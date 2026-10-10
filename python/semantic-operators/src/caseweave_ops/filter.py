"""固定128伪标签学习、无反馈算子与共享二分类教师。"""
from __future__ import annotations
import asyncio
from uuid import uuid4
from dataclasses import asdict
from typing import Any, AsyncIterable
from .runtime import Runtime
from .types import Decision, ProtocolError, Record, verify_citations

async def sem_filter(runtime: Runtime, source: AsyncIterable[Record], instruction: str, *,
                     algorithm="auto", options=None, scope_mode="full", **kwargs):
    """自定义检索只保留固定128伪标签学习与三个无反馈算子。"""
    if algorithm in {"dual_description_margin", "name_gmm", "kmeans"}:
        from .unlabeled_filter import unlabeled_filter
        await unlabeled_filter(runtime, instruction, method=algorithm, options=options, **kwargs)
        return
    if algorithm not in {"auto", "active", "learned"}:
        raise ValueError("Unknown custom retrieval method")
    async for event in learned_filter(runtime, instruction, options=options, **kwargs):
        yield event


async def learned_filter(runtime, instruction, *, options=None, batch_size=8,
                         require_source=True, required_fields=(),
                         recall_scope_key=None, **_):
    # 所有在线入口统一使用前128条教师伪标签，避免默认配置落入旧扩标流程。
    from .online_group_filter import online_group_filter
    async for event in online_group_filter(runtime, instruction, options=options,
        batch_size=batch_size, require_source=require_source, required_fields=required_fields, recall_scope_key=recall_scope_key):
        yield event


COMPACT_DECISION_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["rows"], "properties": {"rows": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["ref", "label", "confidence"],
    "properties": {"ref": {"type": "string"}, "label": {"enum": ["yes", "no"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1}}}}}}


def unknown(record: Record, key: str, why: str, manifest: str | None = None,
            error: str | None = None) -> Decision:
    return Decision(record.ref, record.identity, key, "undetermined", basis="unresolved",
                    reason=why, error=error or why, manifest_id=manifest)


async def judge_batch(runtime: Runtime, records: list[Record], instruction: str,
                      *, require_source: bool = True, required_fields: tuple[str, ...] = (), use_cache: bool | None = None,
                      sampling: bool = False) -> list[Decision]:
    """Only ask the model about rows whose required evidence is available."""
    key = runtime.predicate_key(instruction)
    ready, missing = [], {}
    for row in records:
        source_fields = {p.field for p in row.passages if p.origin == 'source' and p.text}
        absent = set((*required_fields, *row.attributes.get('required_evidence_fields', []))) - source_fields
        if absent or (require_source and not source_fields - {'displayId'}):
            missing[row.ref] = unknown(row, key, '需要读取原文字段：' + ', '.join(sorted(absent)) if absent else '需要读取原文依据')
        else:
            ready.append(row)
    judged = await _judge_ready(runtime, ready, instruction, require_source=require_source,
                                required_fields=required_fields, use_cache=use_cache, sampling=sampling)
    # 每条教师伪标签只判断一次，直接用于后续监督训练。
    by_ref = {**missing, **{d.ref: d for d in judged}}
    return [by_ref[row.ref] for row in records]


async def _judge_ready(runtime: Runtime, records: list[Record], instruction: str,
                       *, require_source: bool, required_fields: tuple[str, ...], use_cache: bool | None,
                       sampling: bool = False) -> list[Decision]:
    if not records:
        return []
    if len({r.ref for r in records}) != len(records):
        raise ValueError("A judgment batch must have distinct record refs")
    key = runtime.predicate_key(instruction)
    # 短别名只用于本批输出；原始身份仍随正文送达并记入宿主回执。
    model_rows = [r.model_payload() for r in records]
    aliases = {}
    for i, row in enumerate(model_rows):
        # 要求原文判断时只发送来源片段，避免模型用生成摘要代替已读对话。
        if require_source or required_fields or row['attributes'].get('required_evidence_fields'):
            row['passages'] = [p for p in row['passages'] if p['origin'] == 'source']
        row["alias"] = f"@r{i + 1}"
        aliases[row["alias"]] = row["ref"]

    def resolved_rows(payload):
        # 严格按本批映射还原，不移动引文、不猜测段落、不修改模型标签。
        for item in payload["rows"]:
            ref = aliases.get(item["ref"], item["ref"])
            record = next((r for r in records if r.ref == ref), None)
            # 短输出只决定标签；引用绑定本次完整送达的正文，明确保留生成来源。
            yield {**item, "ref": ref, "label": "accept" if item["label"] == "yes" else "exclude",
                "citations": [{"ref": ref, "passage_id": p.id, "quote": p.text}
                    for p in record.passages if p.text and p.field != 'displayId'
                    and (not (require_source or required_fields or record.attributes.get('required_evidence_fields')) or p.origin == 'source')] if record else [],
                "knowledge_ids": [], "reason": "依据本次提供的工单正文完成二选一判断。"}

    def cacheable(payload):
        # Cache only complete, reusable decisions; per-row invalid output is
        # still returned as Unknown below, and can be repaired on the next run.
        items = list(resolved_rows(payload))
        if len(items) != len(records) or {x["ref"] for x in items} != {r.ref for r in records}:
            return False
        wiki = {e["id"] for e in runtime.knowledge.entries}
        by_id = {r.ref: r for r in records}
        for item in items:
            row = by_id[item["ref"]]
            try:
                refs = verify_citations(item["citations"], [row])
            except ProtocolError:
                return False
            if not refs or not set(item["knowledge_ids"]).issubset(wiki):
                return False
            if require_source and not any(c.origin == "source" and c.field != "displayId" for c in refs):
                return False
            if any(not any(c.origin == "source" and c.field == f for c in refs)
                   for f in (*required_fields, *row.attributes.get("required_evidence_fields", []))):
                return False
        return True
    return await _call_judge(runtime, records, instruction, model_rows,
        require_source, required_fields, cacheable, resolved_rows, use_cache, sampling, key)


async def _call_judge(runtime, records, instruction, model_rows,
        require_source, required_fields, cacheable, resolved_rows, use_cache, sampling, key):
    # 紧凑判断只复制批内短引用；收到后由既有映射还原工单身份，不按返回位置猜测。
    model_rows = [{**row, 'record_ref': row['ref'], 'ref': row['alias']} for row in model_rows]
    result = await runtime.call("sem_filter", instruction,
        {"records": model_rows,
         "decision_format": "compact_binary",
         "output_instructions": "按查询判断工单是否满足全部业务条件。每条只返回ref、label（yes或no）、confidence（0到1模型自报确信程度）。不输出理由、引文、概率读出或其他字段，只调用submit_result一次。",
         "require_source": require_source, "required_fields": required_fields}, COMPACT_DECISION_SCHEMA,
        cache_if=cacheable, use_cache=use_cache, sampling=sampling)
    # 保留每个 ref 的全部返回项，用数量检查识别缺失和重复，而不是静默覆盖。
    by_ref: dict[str, list[dict[str, Any]]] = {}
    for row in resolved_rows(result.payload):
        by_ref.setdefault(row["ref"], []).append(row)
    supplied = {r.ref for r in records}
    if set(by_ref)-supplied:
        runtime.store.observe(runtime.scope.task_id, "unexpected_output_refs", {"op": "sem_filter", "manifest": result.manifest_id})
    # Wiki 只能引用本轮真实提供的条目，不能由模型创造知识来源。
    wiki_ids = {e["id"] for e in runtime.knowledge.entries}
    out = []
    for record in records:
        row_list = by_ref.get(record.ref, [])
        if len(row_list) != 1:
            out.append(unknown(record, key, "missing_or_duplicate_output", result.manifest_id))
            continue
        row = row_list[0]
        try:
            # 每条决定只核验自身记录，杜绝借用同批其他工单的证据。
            citations = verify_citations(row["citations"], [record])
            if not set(row["knowledge_ids"]).issubset(wiki_ids):
                raise ProtocolError("Knowledge reference was not supplied")
            if not citations or (require_source and not any(c.origin == "source" and c.field != "displayId" for c in citations)):
                raise ProtocolError("Decision lacks the required actual source evidence")
            # 调用方要求与记录自身要求合并；每个字段都必须有 source 原文引文。
            fields = (*required_fields, *record.attributes.get("required_evidence_fields", []))
            if any(not any(c.field == field and c.origin == "source" for c in citations) for field in fields):
                out.append(unknown(record, key, "需要读取并引用原文字段：" + ", ".join(fields), result.manifest_id))
                continue
            out.append(Decision(record.ref, record.identity, key, row["label"], citations,
                 tuple(row["knowledge_ids"]), "reused_model" if result.cache_hit else "model",
                 row["reason"], result.manifest_id, confidence=row["confidence"]))
        except ProtocolError as exc:
            # 引文或知识引用不合法时保守降级为未决，不保留模型给出的业务标签。
            out.append(unknown(record, key, "invalid_evidence_reference", result.manifest_id, str(exc)))
    return out
