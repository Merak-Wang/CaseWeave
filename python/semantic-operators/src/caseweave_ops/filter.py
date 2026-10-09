"""全集学习式 filter 与共享标签读取；只有显式小范围或 baseline 使用逐条判断。"""
from __future__ import annotations
import asyncio
from uuid import uuid4
from dataclasses import asdict, replace
from typing import Any, AsyncIterable
from .runtime import Runtime, CITATION_SCHEMA, SamplingLimitReached
from .types import Decision, ProtocolError, Record, verify_citations

async def sem_filter(runtime: Runtime, source: AsyncIterable[Record], instruction: str, *,
                     algorithm="auto", options=None, scope_mode="full", online_feedback_training=True, **kwargs):
    """在线学习、冻结教师和无标签固定池均经同一授权入口。"""
    if type(online_feedback_training) is not bool:
        raise ProtocolError("online_feedback_training must be boolean")
    # Explicit frozen methods remain selected when feedback training is disabled.
    if not online_feedback_training and algorithm in {"auto", "active", "learned"}:
        algorithm = "direct_teacher"
    if algorithm in {"dual_description_margin", "name_gmm", "kmeans"}:
        if scope_mode != "full" or kwargs.get("stop_after_accepted") is not None:
            raise ProtocolError("Unlabeled methods require the complete recall scope")
        from .unlabeled_filter import unlabeled_filter
        await unlabeled_filter(runtime, instruction, method=algorithm, options=options, **kwargs)
        return
    elif algorithm in {"direct", "direct_teacher"} and scope_mode == "full" and kwargs.get("stop_after_accepted") is None:
        stream = frozen_teacher_filter(runtime, instruction, options=options, **kwargs)
    elif algorithm in {"auto", "active", "learned"} and scope_mode == "full" and kwargs.get("stop_after_accepted") is None:
        stream = learned_filter(runtime, instruction, options=options, **kwargs)
    elif algorithm in {"direct", "direct_teacher", "baseline", "cluster"} or scope_mode == "candidates" or kwargs.get("stop_after_accepted") is not None:
        from .baseline import clustered_filter
        kwargs.pop("initial_refs", None)
        kwargs.pop("recall_scope_key", None)
        for name in ("embedding_id", "query_anchor", "negative_anchor"):
            kwargs.pop(name, None)
        stream = clustered_filter(runtime, source, instruction, algorithm="cluster" if algorithm == "cluster" else "auto",
                                  options=options if algorithm in {"baseline", "cluster"} else None, **kwargs)
    else:
        raise ValueError("Unknown filter algorithm or scope")
    async for result in stream:
        yield result


async def frozen_teacher_filter(runtime, instruction, *, options=None, batch_size=8,
                                require_source=True, required_fields=(), recall_scope_key=None, **_):
    """枚举授权原文并冻结教师逐票判断；不拟合或反馈更新模型。"""
    if runtime.resources is None:
        raise ValueError("Full-scope direct filter requires an authorized numeric feature provider")
    block_size = (options or {}).get("block_size", 1024)
    if type(block_size) is not int or block_size < 1 or type(batch_size) is not int or batch_size < 1:
        raise ValueError("Physical block/batch sizes must be positive integers")
    block_size = min(block_size, 1024)
    call = runtime.resources
    stats = {"algorithm": "direct_teacher", "regime": "frozen_teacher", "online_feedback_training": False,
             "input_revision": runtime.scope.input_revision, "fit_count": 0,
             "training_records": 0, "selection_records": 0, "scope_records": 0,
             "corpus_records": 0, "teacher_unique_records": 0, "positive_records": 0,
             "negative_records": 0, "undetermined_records": 0, "scan_passes": 1,
             "completion_basis": "input_enumeration", "complete_scope_coverage": False,
             "global_semantic_recall": "not_established",
             "task_semantics": "recall_candidate_scope" if recall_scope_key else "full_authorized_scope",
             **({"recall_scope_key": recall_scope_key} if recall_scope_key else {})}
    async def update(reason):
        await runtime.scope.check()
        stats["unresolved"] = stats["undetermined_records"]
        await call("learning.update", {**stats, "stop_reason": reason,
            'sampling_request_limit': 128, 'judge_mode': getattr(runtime, 'judge_mode', 'compact_binary'),
            'judge_readout': getattr(runtime, 'judge_metrics', {}),
            "sampling_requests": runtime.store.sampling_calls(runtime.scope),
            "_usage": runtime.store.metrics(runtime.scope.task_id)})
    await update("frozen_running")
    cursor, feature_id, population_count = None, None, None
    seen_ids, seen_refs, seen_cursors = set(), set(), set()
    while True:
        await runtime.scope.check()
        page = await call("features.scan", {"cursor": cursor, "page_size": block_size, "ranked": False})
        page_feature_id = page.get("feature_id")
        if not page_feature_id or (feature_id is not None and feature_id != page_feature_id):
            raise ValueError("Numeric feature identity changed during frozen filtering")
        feature_id = page_feature_id
        count = page.get("population_count")
        if count is not None:
            if type(count) is not int or count < 0 or (population_count is not None and count != population_count):
                raise ValueError("Authorized population changed during frozen filtering")
            population_count = count
        ids = page.get("ids")
        if not isinstance(ids, list) or len(ids) > block_size or any(type(i) is not int for i in ids):
            raise ProtocolError("Invalid authorized numeric ID page")
        if len(set(ids)) != len(ids) or seen_ids.intersection(ids):
            raise ProtocolError("Authorized numeric IDs must be distinct")
        seen_ids.update(ids)
        stats["corpus_records"] = population_count if population_count is not None else len(seen_ids)
        await runtime.scope.check()
        response = await call("rows.read", {"ids": ids}) if ids else {"rows": []}
        rows = [Record.from_dict(row) for row in response["rows"]]
        if len(rows) != len(ids):
            raise ValueError("Authorized row cardinality changed during frozen filtering")
        refs = [row.ref for row in rows]
        if len(set(refs)) != len(refs) or seen_refs.intersection(refs):
            raise ProtocolError("Authorized record refs must be distinct")
        seen_refs.update(refs)
        for start in range(0, len(rows), batch_size):
            await runtime.scope.check()
            part = rows[start:start + batch_size]
            decisions = await judge_batch(runtime, part, instruction,
                require_source=require_source, required_fields=required_fields)
            for decision in decisions:
                stats[{"accept": "positive_records", "exclude": "negative_records",
                       "undetermined": "undetermined_records"}[decision.label]] += 1
                stats["scope_records"] += 1
                stats["teacher_unique_records"] += 1
                yield {"type": "decision", "value": asdict(decision)}
            if any(d.error == 'sampling_request_limit' for d in decisions):
                stats['message'] = '未完成：128次独立判断额度内未完成，仅返回已确认工单。'
                await update('model_unknown')
                return
            await update("frozen_running")
        cursor = page.get("next_cursor")
        if cursor is None:
            if population_count is not None and len(seen_ids) != population_count:
                raise ValueError("Authorized population cardinality changed during frozen filtering")
            break
        if cursor in seen_cursors:
            raise ProtocolError("Authorized scan cursor must advance")
        seen_cursors.add(cursor)
    # 遍历完仍有技术缺票时如实报错；不把缺项填no或宣称判断完成。
    stats["complete_scope_coverage"] = True
    await update("error" if stats["undetermined_records"] else "frozen_completed")


async def learned_filter(runtime, instruction, *, options=None, batch_size=8,
                         initial_refs=(), host_labels=None, require_source=True, required_fields=(),
                         recall_scope_key=None, **_):
    # 所有在线入口统一使用前128条教师伪标签，避免默认配置落入旧扩标流程。
    from .online_group_filter import online_group_filter
    async for event in online_group_filter(runtime, instruction, options=options,
        batch_size=batch_size, initial_refs=initial_refs, host_labels=host_labels,
        require_source=require_source, required_fields=required_fields, recall_scope_key=recall_scope_key):
        yield event


DECISION_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["rows"], "properties": {"rows": {"type": "array", "items": {
    "type": "object",
    "required": ["ref", "label", "confidence", "citations", "knowledge_ids", "reason"],
    "properties": {"ref": {"type": "string"}, "label": {"enum": ["accept", "exclude"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "citations": {"type": "array", "items": CITATION_SCHEMA},
        "knowledge_ids": {"type": "array", "items": {"type": "string"}}, "reason": {"type": "string"}}}}}}

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
                       review: bool = False, sampling: bool = False, force_compact: bool = False) -> list[Decision]:
    if not records:
        return []
    if len({r.ref for r in records}) != len(records):
        raise ValueError("A judgment batch must have distinct record refs")
    key = runtime.predicate_key(instruction)
    compact = getattr(runtime, 'judge_mode', None) in {'compact_binary', 'anyjev_l0'} or (not require_source and not required_fields and not any(
        r.attributes.get('required_evidence_fields') for r in records) and all(
        p.field in {'title', 'summary', 'displayId'} for r in records for p in r.passages))
    # 短别名只用于本批输出；原始身份仍随正文送达并记入宿主回执。
    model_rows = [r.model_payload() for r in records]
    aliases, passage_aliases = {}, {}
    for i, row in enumerate(model_rows):
        # 要求原文判断时只发送来源片段，避免模型用生成摘要代替已读对话。
        if require_source or required_fields or row['attributes'].get('required_evidence_fields'):
            row['passages'] = [p for p in row['passages'] if p['origin'] == 'source']
        row["alias"] = f"@r{i + 1}"
        aliases[row["alias"]] = row["ref"]
        for j, passage in enumerate(row["passages"]):
            passage["alias"] = f"@p{j + 1}"
            passage_aliases[row["ref"], passage["alias"]] = passage["id"]

    def resolved_rows(payload):
        # 严格按本批映射还原，不移动引文、不猜测段落、不修改模型标签。
        for item in payload["rows"]:
            if compact:
                ref = aliases.get(item["ref"], item["ref"])
                record = next((r for r in records if r.ref == ref), None)
                # 短输出只决定标签；引用绑定本次完整送达的正文，明确保留生成来源。
                yield {**item, "ref": ref, "label": "accept" if item["label"] == "yes" else "exclude",
                    "citations": [{"ref": ref, "passage_id": p.id, "quote": p.text}
                        for p in record.passages if p.text and p.field != 'displayId'
                        and (not (require_source or required_fields or record.attributes.get('required_evidence_fields')) or p.origin == 'source')] if record else [],
                    "knowledge_ids": [], "reason": "依据本次提供的工单正文完成二选一判断。"}
                continue
            citations = []
            for citation in item["citations"]:
                ref = aliases.get(citation["ref"], citation["ref"])
                citations.append({**citation, "ref": ref, "passage_id":
                    passage_aliases.get((ref, citation["passage_id"]), citation["passage_id"])})
            yield {**item, "ref": aliases.get(item["ref"], item["ref"]), "citations": citations}

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
    try:
        if compact and not force_compact and getattr(runtime, 'judge_mode', 'compact_binary') == 'anyjev_l0':
            from .binary_readout import judge_readout
            async def fallback(rows):
                # 局部切换输出协议，避免并发修改Runtime的模式。
                return await _judge_ready(runtime, rows, instruction, require_source=require_source,
                    required_fields=required_fields, use_cache=use_cache, review=review, sampling=sampling,
                    force_compact=True)
            readout_records = [replace(r, passages=tuple(p for p in r.passages if p.origin == 'source'))
                if require_source or required_fields or r.attributes.get('required_evidence_fields') else r for r in records]
            return await judge_readout(runtime, readout_records, instruction, key, fallback, use_cache, sampling, review)
        return await _call_judge(runtime, records, instruction, model_rows, compact, review,
            require_source, required_fields, cacheable, resolved_rows, use_cache, sampling, key)
    except SamplingLimitReached:
        return [unknown(r, key, 'sampling_request_limit') for r in records]


async def _call_judge(runtime, records, instruction, model_rows, compact, review,
        require_source, required_fields, cacheable, resolved_rows, use_cache, sampling, key):
    # 紧凑判断只复制批内短引用；收到后由既有映射还原工单身份，不按返回位置猜测。
    if compact:
        model_rows = [{**row, 'record_ref': row['ref'], 'ref': row['alias']} for row in model_rows]
    result = await runtime.call("sem_filter", instruction,
        {"records": model_rows,
         **({"decision_format": "compact_binary"} if compact else {}),
         "review_stage": "criterion_gaps" if review else "initial",
         "output_instructions": ("独立重新判断全部条件，不参考初判标签或理由，也不能由结果反推原状态。" if review else "") +
             "逐条从 accept（相关）与 exclude（不相关）中选择最贴近查询的一项。查询是唯一业务标准；综合本条工单实际内容判断，不因关键词相似就判相关。"
             "缺少支持相关的事实时选择 exclude，并降低 confidence；必须提交一个二选一标签。confidence 是对所选标签的0到1自报确信程度，不是校准概率，也不作为硬门槛。reason 用一句话说明决定性事实或缺失点。"
             "引用必须使用本条已提供的记录/段落 alias（@r1/@p1）及原文连续短句；required_fields 必须有对应 source 引用。knowledge_ids 只填实际使用的知识。仅调用 submit_result 一次，不输出思考过程。"
             if not compact else ("独立检查所有条件。" if review else "") +
             "按查询判断工单是否直接满足业务条件，不能仅由关键词相似判相关。每条只返回ref、label（yes或no）、confidence（0到1对所选标签的自报确信程度）。禁止理由、引文和其他字段；确信程度不是校准概率。只调用submit_result一次。",
         "require_source": require_source, "required_fields": required_fields}, COMPACT_DECISION_SCHEMA if compact else DECISION_SCHEMA,
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
