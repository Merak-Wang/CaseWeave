"""三个语义算子的公共入口；搜索与读取是 Host 基础能力。"""
from __future__ import annotations
from dataclasses import asdict
from typing import AsyncIterable, AsyncIterator, Any
from .types import Scope, Record, Passage, Knowledge, Decision, Citation, ProtocolError, StaleTask
from .runtime import Runtime, ModelReply, ModelPort, ArtifactStore, Usage, records_from
from .search import sem_search, plan_query, validate_plan, OPS, Hit
from .filter import sem_filter, judge_batch
from .extract import sem_extract, ExtractResult
from .aggregate import sem_agg, Summary

async def invoke_rows(op: str, runtime: Runtime, source: AsyncIterable[Record], instruction: str,
                      params: dict[str, Any] | None = None) -> AsyncIterator[dict[str, Any]]:
    """不执行任意代码，也不接受模型覆盖配额、身份或服务端点。"""
    p = params or {}
    # 先按算子执行封闭参数白名单，任何未知操作或附加参数都立即拒绝。
    allowed = {"sem_filter": {"scope_mode", "batch_size", "require_source", "required_fields", "example_count", "queries", "embedding_id", "keywords", "replay_saved", "algorithm", "options", "host_labels", "initial_refs", "recall_scope_key", "online_feedback_training", "query_anchor", "negative_anchor"},
               "sem_extract": {"batch_size", "output_schema", "field_map"}, "sem_agg": {"fan_in", "numeric_fields", "evidence_window", "population_count"}}
    if op not in allowed or set(p)-allowed[op]: raise ProtocolError("Unknown operator/argument")
    if op == "sem_filter":
        if type(p.get("online_feedback_training", True)) is not bool:
            raise ProtocolError("online_feedback_training must be boolean")
        fields = p.get("required_fields", [])
        if not isinstance(fields, list) or any(not isinstance(f, str) or not f.strip() for f in fields):
            raise ProtocolError("required_fields must contain field names")
        # 产品与对照共用授权入口；无标签方法冻结完整召回池和描述锚点。
        async for result in sem_filter(runtime, source, instruction, batch_size=p.get("batch_size", 8),
                algorithm=p.get("algorithm", "auto"), options=p.get("options"),
                online_feedback_training=p.get("online_feedback_training", True),
                host_labels=p.get("host_labels"), require_source=p.get("require_source", True),
                required_fields=tuple(fields),
                replay_saved=p.get("replay_saved", False),
                scope_mode=p.get("scope_mode", "full"), initial_refs=p.get("initial_refs", []),
                recall_scope_key=p.get("recall_scope_key"), embedding_id=p.get("embedding_id"),
                query_anchor=p.get("query_anchor"), negative_anchor=p.get("negative_anchor"),
                stop_after_accepted=p.get("example_count")):
            yield result if isinstance(result, dict) else {"type": "decision", "value": asdict(result)}
    elif op == "sem_extract":
        async for result in sem_extract(runtime, source, instruction, p["output_schema"], batch_size=p.get("batch_size", 8), field_map=p.get("field_map")):
            yield {"type": "transform", "value": asdict(result)}
    else:
        result = await sem_agg(runtime, source, instruction, fan_in=p.get("fan_in", 8), numeric_fields=p.get("numeric_fields", []),
                               evidence_window=p.get("evidence_window"), population_count=p.get("population_count"))
        yield {"type": "aggregate", "value": asdict(result)}


__all__ = ["Scope", "Record", "Passage", "Knowledge", "Decision", "Citation", "ProtocolError", "StaleTask",
           "Runtime", "ModelReply", "ModelPort", "ArtifactStore", "Usage", "records_from", "invoke_rows",
           "sem_search", "plan_query", "validate_plan", "OPS", "Hit", "sem_filter", "judge_batch",
           "sem_extract", "ExtractResult", "sem_agg", "Summary"]
