"""实现类型化 sem_map / sem_extract，并把输出字段锚定到原文引文。"""
from __future__ import annotations
from dataclasses import asdict, dataclass, field
from typing import Any, AsyncIterable, AsyncIterator
from .filter import CITATION_SCHEMA, batches
from .model import Runtime
from .types import Citation, ProtocolError, Record, verify_citations, digest
from .schema import check_schema


@dataclass(frozen=True)
class MapResult:
    ref: str
    status: str
    data: dict[str, Any] | None
    citations: tuple[Citation, ...]
    field_citations: dict[str, tuple[Citation, ...]] = field(default_factory=dict)
    manifest_id: str | None = None
    error: str | None = None


def result_schema(data_schema: dict[str, Any], extract: bool):
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
                     output_schema: dict[str, Any], extract: bool, batch_size: int):
    if output_schema.get("type") != "object": raise ValueError("Output schema must describe an object")
    check_schema(output_schema)
    op = "sem_extract" if extract else "sem_map"
    schema = result_schema(output_schema, extract)
    # extract 比 map 多一层字段级证据要求：每个非空字段都必须能回指原文。
    actual_instruction = instruction + (" 每个非空输出字段必须在field_citations中列出本记录的原文引文；无依据字段返回null或未决。" if extract else " 返回data和本记录依据；field_citations可为空。")
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
                yield MapResult(**{**saved, "citations": tuple(Citation(**c) for c in saved["citations"]),
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
                    if extract:
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
            value = MapResult(r.ref, status, data, refs, fields, response.manifest_id, error)
            runtime.store.save(runtime.scope.key, progress, r.observation_key, asdict(value))
            yield value


def sem_map(runtime: Runtime, source: AsyncIterable[Record], instruction: str,
            output_schema: dict[str, Any], *, batch_size: int = 8) -> AsyncIterator[MapResult]:
    return _transform(runtime, source, instruction, output_schema, False, batch_size)


def sem_extract(runtime: Runtime, source: AsyncIterable[Record], instruction: str,
                output_schema: dict[str, Any], *, batch_size: int = 8) -> AsyncIterator[MapResult]:
    return _transform(runtime, source, instruction, output_schema, True, batch_size)
