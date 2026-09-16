"""核心算子的公共分发入口，可供 Python 服务和标准输入输出桥共同调用。"""
from __future__ import annotations
from dataclasses import asdict
from typing import AsyncIterable, AsyncIterator, Any
from .model import Runtime
from .types import Record, ProtocolError
from .filter import sem_filter
from .feedback import FeedbackSet, MultiViewScorer
from .topk import sem_topk, model_compare
from .transform import sem_map, sem_extract
from .join import sem_join
from .aggregate import sem_agg


async def records_from(values: list[Record]) -> AsyncIterator[Record]:
    for value in values: yield value


async def invoke_rows(op: str, runtime: Runtime, source: AsyncIterable[Record], instruction: str,
                      params: dict[str, Any] | None = None) -> AsyncIterator[dict[str, Any]]:
    """不执行任意代码，也不接受模型覆盖配额、身份或服务端点。"""
    p = params or {}
    # 先按算子执行封闭参数白名单，任何未知操作或附加参数都立即拒绝。
    allowed = {"sem_filter": {"batch_size", "require_source", "required_fields", "example_count", "queries", "embedding_id", "keywords", "replay_saved", "algorithm", "options", "host_labels"},
               "sem_topk": {"k", "strategy"}, "sem_map": {"batch_size", "output_schema"},
               "sem_extract": {"batch_size", "output_schema"}, "sem_agg": {"fan_in"}}
    if op not in allowed or set(p)-allowed[op]: raise ProtocolError("Unknown operator/argument")
    if op == "sem_filter":
        fields = p.get("required_fields", [])
        if not isinstance(fields, list) or any(not isinstance(f, str) or not f.strip() for f in fields):
            raise ProtocolError("required_fields must contain field names")
        # Batch sorting is retained for the reference experiment only. The
        # cluster path learns in numeric row arrays, without retaining all texts
        # in an auxiliary in-memory FeedbackSet.
        reference = p.get("algorithm") == "reference"
        feedback = FeedbackSet(runtime.predicate_key(instruction)) if reference and p.get("queries") else None
        scorer = None
        if feedback is not None:
            scorer = MultiViewScorer(p["queries"], p["embedding_id"], p.get("keywords", []), feedback)
        # Auto streams strict judgments; explicit cluster preserves the comparison.
        async for result in sem_filter(runtime, source, instruction, batch_size=p.get("batch_size", 8),
                algorithm=p.get("algorithm", "auto"), options=p.get("options"),
                **({"scorer": scorer} if reference else {"host_labels": p.get("host_labels")}),
                feedback=feedback, require_source=p.get("require_source", True),
                required_fields=tuple(fields),
                replay_saved=p.get("replay_saved", False),
                stop_after_accepted=p.get("example_count")):
            yield {"type": "decision", "value": asdict(result)}
    elif op == "sem_topk":
        # 把运行时和业务指令闭包进比较器，使每次两两比较都走同一证据协议。
        async def compare(l, r): return await model_compare(runtime, instruction, l, r)
        result = await sem_topk(source, p["k"], compare, runtime=runtime, strategy=p.get("strategy", "heap"))
        yield {"type": "topk", "refs": [r.ref for r in result.records], "examined": result.examined,
               "unresolved_pairs": result.unresolved_pairs, "algorithm_completed": result.algorithm_completed,
               "global_semantic_optimality": result.global_semantic_optimality}
    elif op in ("sem_map", "sem_extract"):
        # map 与 extract 共用流式转换骨架，由操作名决定是否强制字段级引文。
        func = sem_extract if op == "sem_extract" else sem_map
        async for result in func(runtime, source, instruction, p["output_schema"], batch_size=p.get("batch_size", 8)):
            yield {"type": "transform", "value": asdict(result)}
    else:
        result = await sem_agg(runtime, source, instruction, fan_in=p.get("fan_in", 8))
        yield {"type": "aggregate", "value": asdict(result)}
