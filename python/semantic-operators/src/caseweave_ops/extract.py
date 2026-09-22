"""实现类型化 sem_extract，并把输出字段锚定到原文引文。"""
from __future__ import annotations
import math
from dataclasses import asdict, dataclass, field
from typing import Any, AsyncIterable, AsyncIterator
from .runtime import Runtime, CITATION_SCHEMA, batches, check_schema
from .types import Citation, ProtocolError, Record, verify_citations, digest


@dataclass(frozen=True)
class ExtractResult:
    ref: str
    status: str
    data: dict[str, Any] | None
    citations: tuple[Citation, ...]
    field_citations: dict[str, tuple[Citation, ...]] = field(default_factory=dict)
    manifest_id: str | None = None
    error: str | None = None
    basis: str = "model"


def result_schema(data_schema: dict[str, Any]):
    def relocate(value):
        if isinstance(value, list): return [relocate(v) for v in value]
        if not isinstance(value, dict): return value
        return {k: ("#/$defs/payload" + v[1:] if k in ("$ref", "$dynamicRef") and (v == "#" or v.startswith("#/"))
                    else relocate(v)) for k, v in value.items()}
    # 在业务数据 Schema 外包一层记录身份、状态和证据，统一约束批量模型输出。
    props = {"ref": {"type": "string"}, "status": {"enum": ["ok", "undetermined"]},
             "data": {"anyOf": [{"$ref": "#/$defs/payload"}, {"type": "null"}]},
             "citations": {"type": "array", "items": CITATION_SCHEMA},
             "field_citations": {"type": "object", "additionalProperties": {"type": "array", "items": CITATION_SCHEMA}}}
    return {"type": "object", "$defs": {"payload": relocate(data_schema)}, "additionalProperties": False, "required": ["rows"], "properties": {
       "rows": {"type": "array", "items": {"type": "object", "additionalProperties": False,
           "required": list(props), "properties": props}}}}


async def _transform(runtime: Runtime, source: AsyncIterable[Record], instruction: str,
                     output_schema: dict[str, Any], batch_size: int):
    if output_schema.get("type") != "object": raise ValueError("Output schema must describe an object")
    check_schema(output_schema)
    op = "sem_extract"
    schema = result_schema(output_schema)
    actual_instruction = instruction + " 非空字段须有本条原文field_citations；缺证返回null或未决。"
    progress = op + ":" + runtime.predicate_key(actual_instruction) + ":" + digest(output_schema)
    reused = set()
    async for rows in batches(source, batch_size):
        await runtime.scope.check()
        rows = list({r.observation_key: r for r in rows}.values())
        fresh = []
        for row in rows:
            saved = runtime.store.output(runtime.scope.key, progress, row.observation_key)
            if saved and saved["status"] == "ok":
                manifest = saved["manifest_id"]
                if manifest not in reused:
                    await runtime.reuse_result(manifest, runtime.store.get_cache("transform:" + manifest))
                    reused.add(manifest)
                yield ExtractResult(**{**saved, "citations": tuple(Citation(**c) for c in saved["citations"]),
                    "field_citations": {k: tuple(Citation(**c) for c in values) for k, values in saved["field_citations"].items()}})
            else: fresh.append(row)
        rows = fresh
        if not rows: continue
        # Valid per-record results are the reusable cache. Invalid/Unknown batch
        # responses must not poison a repair with richer evidence.
        response = await runtime.call(op, actual_instruction, {"records": [r.model_payload() for r in rows]}, schema, use_cache=False)
        runtime.store.put_cache("transform:" + response.manifest_id, response.payload)
        # 按 ref 保留列表而非直接覆盖，确保能识别模型的缺失项和重复项。
        by_ref = {}
        for value in response.payload["rows"]:
            by_ref.setdefault(value["ref"], []).append(value)
        for r in rows:
            error = None
            data = None
            refs: tuple[Citation, ...] = ()
            fields: dict[str, tuple[Citation, ...]] = {}
            entries = by_ref.get(r.ref, [])
            # 每条记录默认未决，只有结构、总证据和字段证据全部通过才升级为 ok。
            status = "undetermined"
            try:
                if len(entries) != 1: raise ProtocolError("missing_or_duplicate_output")
                row = entries[0]
                refs = verify_citations(row["citations"], [r])
                fields = {key: verify_citations(c, [r]) for key, c in row["field_citations"].items()}
                if row["status"] == "ok":
                    data = row["data"]
                    if not isinstance(data, dict) or not refs: raise ProtocolError("output_without_evidence")
                    # 字段引文不得指向输出外字段，所有非空字段也必须各自有证据。
                    if set(fields)-set(data): raise ProtocolError("citation_for_unknown_field")
                    if any(value is not None and not fields.get(key) for key, value in data.items()):
                        raise ProtocolError("missing_field_level_evidence")
                    status = "ok"
            except ProtocolError as exc:
                # 单条协议错误降级为未决并清空数据，不能让无效值进入后续流程。
                error = str(exc)
                data, refs, fields = None, (), {}
            # 持久化和发布前复核作用域，避免耗时调用后写出已经过期的结果。
            await runtime.scope.check()
            value = ExtractResult(r.ref, status, data, refs, fields, response.manifest_id, error)
            runtime.store.save(runtime.scope.key, progress, r.observation_key, asdict(value))
            yield value


async def sem_extract(runtime: Runtime, source: AsyncIterable[Record], instruction: str,
                      output_schema: dict[str, Any], *, batch_size: int = 8, field_map=None):
    """已声明的可靠字段先由代码读取；开放事实才调用现有 DSH reader。"""
    if not field_map:
        async for result in _transform(runtime, source, instruction, output_schema, batch_size):
            yield result
        return
    from jsonschema import Draft202012Validator
    from .types import utf16len
    check_schema(output_schema)
    async for row in source:
        await runtime.scope.check()
        data, cites = {}, {}
        for name, source_field in field_map.items():
            parts = [p for p in row.passages if p.field == source_field and p.origin == "source" and p.text]
            if len(parts) != 1:
                data[name] = None
                continue
            p = parts[0]
            kind = output_schema.get("properties", {}).get(name, {}).get("type")
            text = p.text.strip()
            try:
                value = int(text) if kind == "integer" else float(text) if kind == "number" else text
            except ValueError:
                value = None
            if isinstance(value, float) and not math.isfinite(value): value = None
            data[name] = value
            if value is not None:
                cites[name] = (Citation(row.ref, row.version, row.content_hash, p.id, p.field,
                    p.start, p.start+utf16len(p.text), p.text, p.origin),)
        ok = all(value is not None for value in data.values()) and Draft202012Validator(output_schema).is_valid(data)
        yield ExtractResult(row.ref, "ok" if ok else "undetermined", data if ok else None,
                        tuple(c for values in cites.values() for c in values), cites,
                        error=None if ok else "missing_or_unparseable_field", basis="field")
