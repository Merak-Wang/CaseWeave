"""流式执行 sem_filter，输出真实三态判断并支持反馈与可选校准推断。"""
from __future__ import annotations
from dataclasses import asdict
from typing import AsyncIterable, AsyncIterator, Any
from .model import Runtime
from .types import Decision, Citation, Label, ProtocolError, StaleTask, Record, verify_citations
from .feedback import FeedbackSet, WeakScorer
from .calibration import RegionGate

CITATION_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["ref", "passage_id", "quote"], "properties": {
    "ref": {"type": "string"}, "passage_id": {"type": "string"}, "quote": {"type": "string"}}}
DECISION_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["rows"], "properties": {"rows": {"type": "array", "items": {
    "type": "object", "additionalProperties": False,
    "required": ["ref", "label", "citations", "knowledge_ids", "reason"],
    "properties": {"ref": {"type": "string"}, "label": {"enum": ["accept", "exclude", "undetermined"]},
        "citations": {"type": "array", "items": CITATION_SCHEMA},
        "knowledge_ids": {"type": "array", "items": {"type": "string"}}, "reason": {"type": "string"}}}}}}


async def batches(source: AsyncIterable[Any], size: int) -> AsyncIterator[list[Any]]:
    if type(size) is not int or size < 1:
        raise ValueError("Batch size must be positive")
    batch = []
    # 满批立即交付，输入结束后再交付尾批，始终保持流式处理。
    async for row in source:
        batch.append(row)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def unknown(record: Record, key: str, why: str, manifest: str | None = None) -> Decision:
    return Decision(record.ref, record.identity, key, "undetermined", basis="unresolved",
                    reason=why, error=why, manifest_id=manifest)


async def judge_batch(runtime: Runtime, records: list[Record], instruction: str,
                      *, require_source: bool = True, required_fields: tuple[str, ...] = (), use_cache: bool | None = None) -> list[Decision]:
    if not records:
        return []
    if len({r.ref for r in records}) != len(records):
        raise ValueError("A judgment batch must have distinct record refs")
    key = runtime.predicate_key(instruction)
    # 同时发送正文、期望 ref 和证据要求，让模型输出可以逐条闭环核验。
    def cacheable(payload):
        # Cache only complete, reusable decisions; per-row invalid output is
        # still returned as Unknown below, and can be repaired on the next run.
        items = payload["rows"]
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
            if item["label"] == "undetermined" or not refs or not set(item["knowledge_ids"]).issubset(wiki):
                return False
            if require_source and not any(c.origin == "source" and c.field != "displayId" for c in refs):
                return False
            if any(not any(c.origin == "source" and c.field == f for c in refs)
                   for f in (*required_fields, *row.attributes.get("required_evidence_fields", []))):
                return False
        return True
    result = await runtime.call("sem_filter", instruction,
        {"records": [r.model_payload() for r in records], "requested_refs": [r.ref for r in records],
         "require_source": require_source, "required_fields": required_fields}, DECISION_SCHEMA, cache_if=cacheable, use_cache=use_cache)
    # 保留每个 ref 的全部返回项，用数量检查识别缺失和重复，而不是静默覆盖。
    by_ref: dict[str, list[dict[str, Any]]] = {}
    for row in result.payload["rows"]:
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
            if row["label"] != "undetermined":
                if not citations or (require_source and not any(c.origin == "source" and c.field != "displayId" for c in citations)):
                    raise ProtocolError("Decision lacks the required actual source evidence")
                # 调用方要求与记录自身要求合并；每个字段都必须有 source 原文引文。
                fields = (*required_fields, *record.attributes.get("required_evidence_fields", []))
                if any(not any(c.field == field and c.origin == "source" for c in citations) for field in fields):
                    out.append(unknown(record, key, "需要读取并引用原文字段：" + ", ".join(fields), result.manifest_id))
                    continue
            out.append(Decision(record.ref, record.identity, key, row["label"], citations,
                 tuple(row["knowledge_ids"]), "reused_model" if result.cache_hit else "model",
                 row["reason"], result.manifest_id))
        except ProtocolError:
            # 引文或知识引用不合法时保守降级为未决，不保留模型给出的业务标签。
            out.append(unknown(record, key, "invalid_evidence_reference", result.manifest_id))
    return out


async def sem_filter_reference(runtime: Runtime, source: AsyncIterable[Record], instruction: str, *,
                     batch_size: int = 8, scorer: WeakScorer | None = None,
                     feedback: FeedbackSet | None = None,
                     gates: tuple[RegionGate, ...] = (), require_source: bool = True,
                     required_fields: tuple[str, ...] = (),
                     replay_saved: bool = False,
                     stop_after_accepted: int | None = None) -> AsyncIterator[Decision]:
    """不设置调用预算；stop_after_accepted 表示“找 n 个案例”，不是调用上限。

    默认路径会对有限输入范围执行所有必要的强判断。本地分数只重排当前批次，
    不加载百万级全集；HTTP/Schema 错误直接交给宿主，不暗中修复或递归重试。
    已处理版本通过磁盘进度跳过而非维护超大内存集合；新宿主调用应使用新作用域，
    或明确请求回放持久化结果，本函数默认不重复发出旧结果。
    """
    if stop_after_accepted is not None and (type(stop_after_accepted) is not int or stop_after_accepted < 1):
        raise ValueError("Example target must be positive")
    key, accepted = runtime.predicate_key(instruction), 0
    if feedback is not None and feedback.predicate_key != key:
        raise ValueError("Feedback predicate does not match the filter")
    # 进度键纳入判据和证据强度，避免“只看概览”的结果冒充“已读原文”。
    progress_op = "sem_filter:" + key + (":source" if require_source else ":overview") + ":fields:" + ",".join(sorted(required_fields))
    async for rows in batches(source, batch_size):
        await runtime.scope.check()
        if runtime.predicate_key(instruction) != key:
            raise StaleTask("Filter predicate or scope changed")
        # 先按磁盘进度处理断点恢复，再对当前批相同观察内容做幂等去重。
        unique = {}
        for r in rows:
            saved = runtime.store.output(runtime.scope.key, progress_op, r.observation_key)
            if saved is not None and replay_saved:
                # 回放时恢复不可变嵌套类型，并把首次模型依据标记为缓存复用。
                saved["citations"] = tuple(Citation(**c) for c in saved["citations"])
                saved["knowledge_ids"] = tuple(saved["knowledge_ids"])
                if saved["basis"] == "model": saved["basis"] = "reused_model"
                yield Decision(**saved)
                accepted += saved["label"] == "accept"
            elif saved is None:
                unique[r.observation_key] = r
        rows = list(unique.values())
        # 弱评分只调整当前批的判断顺序，不替代后续证据核验。
        if scorer:
            rows.sort(key=lambda r: (-scorer.score(r).priority, r.ref))
        # 仅持有匹配校准证书的记录可走代理门，其余全部进入模型强判断。
        strong, ready = [], []
        for r in rows:
            inferred = None
            if scorer:
                score = scorer.score(r)
                for gate in gates:
                    inferred = gate.apply(r, score, key)
                    if inferred:
                        break
            if inferred:
                ready.append((r, inferred))
            else:
                strong.append(r)
        if strong:
            decisions = await judge_batch(runtime, strong, instruction, require_source=require_source, required_fields=required_fields)
            ready.extend(zip(strong, decisions))
        # 发布前复核作用域，随后先持久化、再学习反馈，保证恢复状态完整。
        for record, decision in ready:
            await runtime.scope.check()
            runtime.store.save(runtime.scope.key, progress_op, record.observation_key, asdict(decision))
            if feedback:
                feedback.observe(record, decision)
            accepted += decision.label == "accept"
            yield decision
        # 一批可能越过目标数；不能为凑数量丢弃有效判断，展示分页由上游负责。
        if stop_after_accepted is not None and accepted >= stop_after_accepted:
            runtime.store.observe(runtime.scope.task_id, "goal_met", {"accepted": accepted, "goal": stop_after_accepted})
            return
    # 只声明“给定输入已处理”，不把有限输入枚举误写成全局语义找全证明。
    runtime.store.observe(runtime.scope.task_id, "input_enumerated", {"op": "sem_filter", "predicate": key,
                         "meaning": "supplied scope processed; not a proof of global semantic completeness"})


async def sem_filter(runtime: Runtime, source: AsyncIterable[Record], instruction: str, *,
                     algorithm="cluster", options=None, **kwargs) -> AsyncIterator[Decision]:
    """Default public path: disk-backed clustering, selective judgment and checks.

    reference preserves the 0.3.0 batch-sort baseline. csv is the explicitly
    uncalibrated paper comparison, never a production quality guarantee.
    """
    if algorithm == "reference":
        stream = sem_filter_reference(runtime, source, instruction, **kwargs)
    elif algorithm in {"cluster", "csv"}:
        from .filter_adapter import clustered_filter
        stream = clustered_filter(runtime, source, instruction, algorithm=algorithm, options=options, **kwargs)
    else:
        raise ValueError("Unknown filter algorithm")
    async for result in stream:
        yield result
