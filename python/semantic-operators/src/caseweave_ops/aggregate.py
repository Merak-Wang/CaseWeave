"""执行保留叶子来源链路的流式分层语义聚合。

固定扇入只限制同时存活的摘要节点并改变归并拓扑，不限制总调用数；物化后的
叶子引文仍可能按 O(N) 增长。计量上涨不会丢弃记录，结构校验也不代表摘要天然
满足结合律或事实一定正确。
"""
from __future__ import annotations
from dataclasses import asdict, dataclass, field
import math
from typing import AsyncIterable
from .runtime import Runtime, records_from
from .features import decode_block
import numpy as np
from .types import Record, Citation, ProtocolError, digest, utf16len

AGG_SCHEMA = {"type": "object", "additionalProperties": False,
  "required": ["status", "text", "source_ids"], "properties": {
    "status": {"enum": ["ok", "undetermined"]}, "text": {"type": "string"},
    "source_ids": {"type": "array", "items": {"type": "string"}}}}


@dataclass(frozen=True)
class Summary:
    id: str
    text: str
    citations: tuple[Citation, ...]
    leaves: int
    complete: bool
    manifest_id: str | None = None
    parent_ids: tuple[str, ...] = ()
    statistics: dict = field(default_factory=dict)


async def sem_agg(runtime: Runtime, source: AsyncIterable[Record], instruction: str, *, fan_in: int = 8, numeric_fields=(), evidence_window=None, population_count=None) -> Summary:
    if type(fan_in) is not int or fan_in < 2: raise ValueError("fan_in must be at least 2")
    if evidence_window is not None:
        # Host 限定此池为已确认的命名记录；窗口只控制解说正文，绝不重写 filter 结果。
        pool = [r async for r in source]
        features = await runtime.resources("evidence.features", {"refs": [r.ref for r in pool]})
        block = decode_block(features)
        if not block.available.all(): raise ValueError("Evidence diversity needs prepared features for the supplied pool")
        by_ref = {r.ref: r for r in pool}
        selected = mmr_evidence(block.dense, np.ones(len(block.ids)), evidence_window)
        source = records_from([by_ref[features["refs"][int(i)]] for i in selected])
    # 每一层保存尚未凑满扇入的节点，行为类似进位树，空间随层数增长。
    levels: list[list[Summary]] = []
    total_leaves = 0
    reduction_failed = False
    lineage = "sem_agg:"+runtime.predicate_key(instruction)

    def combine(items):
        result = {"records": sum(i.leaves for i in items), "coverage": "selected_evidence_only" if evidence_window else "supplied_records_only",
                  "population_count": population_count, "fields": {}}
        for name in numeric_fields:
            parts = [i.statistics["fields"][name] for i in items]
            present, missing = sum(p["present"] for p in parts), sum(p["missing"] for p in parts)
            total = sum(p["observed_sum"] for p in parts)
            result["fields"][name] = {"present": present, "missing": missing, "observed_sum": total,
                "exact": missing == 0, "sum": total if missing == 0 else None,
                "mean": total/present if present and not missing else None}
        return result

    async def reduce(items: list[Summary]) -> Summary:
        nonlocal reduction_failed
        source_index = {}
        sources = []
        def records(citations):
            # 从可信引文重建最小来源记录，让上层摘要仍能回溯原始证据身份。
            rows = {}
            for c in citations:
                row = rows.setdefault(c.ref, {"ref": c.ref, "version": c.version, "content_hash": c.content_hash,
                                             "passages": [], "attributes": {}})
                row["passages"].append({"id": c.passage_id, "field": c.field, "text": c.quote, "start": c.start, "origin": c.origin})
            return list(rows.values())
        for item in items:
            # 叶子按段落提供引用 ID；中间摘要只传自身清单身份。
            if item.manifest_id is None:
                for citation in item.citations:
                    ident = digest(asdict(citation))
                    source_index[ident] = (citation,)
                    sources.append({"id": ident, "text": citation.quote, "origin": citation.origin, "records": records((citation,))})
            else:
                source_index[item.id] = item.id
                sources.append({"id": item.id, "text": item.text, "origin": "derived_summary", "complete": item.complete,
                                "source_manifest_id": item.manifest_id})
        def validate(value):
            ids = value["source_ids"]
            if len(ids) != len(set(ids)) or any(i not in source_index for i in ids):
                raise ProtocolError("Aggregation cited an unsupplied source")
        result = await runtime.call("sem_agg", instruction+" 仅概括输入来源，source_ids引用输入id；统计用code_statistics，派生摘要不作原文。",
             {"sources": sources, "input_record_count": sum(i.leaves for i in items), "code_statistics": combine(items)}, AGG_SCHEMA, validate=validate,
             cache_if=lambda v: v['status'] == 'ok' and bool(v['text'].strip()) and bool(v['source_ids']))
        value = result.payload
        ids = value["source_ids"]
        # 模型只能引用本轮提供的唯一来源 ID，拒绝虚构来源和重复灌水。
        ok = value["status"] == "ok" and bool(value["text"].strip()) and bool(ids)
        reduction_failed |= not ok
        # 节点只保存直接叶证据与父 ID；不会向上复制全部叶原文。
        parents = tuple(source_index[i] for i in ids if isinstance(source_index[i], str))
        by_key = {digest(asdict(c)): c for i in ids if not isinstance(source_index[i], str) for c in source_index[i]}
        output = Summary(digest([result.manifest_id, value]), value["text"] if ok else "",
            tuple(by_key.values()), sum(i.leaves for i in items), ok and all(i.complete for i in items), result.manifest_id, parents, combine(items))
        runtime.store.save(runtime.scope.key, lineage, output.id, asdict(output))
        return output

    async def push(item: Summary, level: int):
        while len(levels) <= level: levels.append([])
        levels[level].append(item)
        # 一层凑满 fan_in 后立即归并并向上一层进位，避免囤积全部输入。
        if len(levels[level]) == fan_in:
            group, levels[level] = levels[level], []
            await push(await reduce(group), level+1)

    async for record in source:
        await runtime.scope.check()
        total_leaves += 1
        # 每条原始记录先转成只含真实段落全文的叶子节点，空段落不生成引文。
        citations = tuple(Citation(record.ref, record.version, record.content_hash, p.id, p.field,
                                  p.start, p.start+utf16len(p.text), p.text, p.origin) for p in record.passages if p.text)
        fields = {}
        for name in numeric_fields:
            parts = [p for p in record.passages if p.field == name and p.origin == "source"]
            try: value = float(parts[0].text) if len(parts) == 1 else None
            except ValueError: value = None
            available = value is not None and math.isfinite(value)
            fields[name] = {"present": int(available), "missing": int(not available), "observed_sum": value if available else 0.}
        leaf = Summary(record.identity, "", citations, 1, bool(citations), statistics={"fields": fields})
        await push(leaf, 0)
    if total_leaves == 0:
        return Summary(digest([runtime.scope.key, "empty"]), "", (), 0, True)
    # 输入结束后逐层清空余数；单个零层叶子也要经过一次模型聚合才形成摘要文本。
    while sum(len(level) for level in levels) > 1 or (levels and len(levels[0]) == 1 and sum(map(len, levels)) == 1):
        index = next(i for i, level in enumerate(levels) if level)
        group, levels[index] = levels[index], []
        await push(await reduce(group), index+1)
    result = next(item for level in levels for item in level)
    await runtime.scope.check()
    # 任一中间归并未决都会向最终结果传播 complete=False。
    citations, pending, visited = {}, [result.id], set()
    while pending:
        ident = pending.pop()
        if ident in visited: continue
        visited.add(ident)
        node = runtime.store.output(runtime.scope.key, lineage, ident)
        for c in node["citations"]: citations[digest(c)] = Citation(**c)
        pending.extend(node["parent_ids"])
    return Summary(result.id, result.text, tuple(citations.values()), total_leaves,
                   result.complete and not reduction_failed, result.manifest_id, result.parent_ids, result.statistics)


def mmr_evidence(X, relevance, k, relevance_weight=.7):
    """归一化特征；仅保存冗余度向量，空间 O(n)，不构建 n×n 矩阵。"""
    if k < 1 or not 0 <= relevance_weight <= 1:
        raise ValueError("Invalid evidence window")
    relevance = np.asarray(relevance)
    redundancy, available = np.full(len(X), -np.inf), np.ones(len(X), dtype=bool)
    chosen = []
    for step in range(min(k, len(X))):
        priority = relevance if step == 0 else relevance_weight*relevance-(1-relevance_weight)*redundancy
        index = int(np.argmax(np.where(available, priority, -np.inf)))
        chosen.append(index); available[index] = False
        redundancy = np.maximum(redundancy, X @ X[index])
    return np.asarray(chosen, dtype=np.int64)
