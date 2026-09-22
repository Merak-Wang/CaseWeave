"""现有 Host 的一次查询理解与并行搜索；数据和 embedding 均回调既有 Provider。"""
from __future__ import annotations
import asyncio
import json
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, AsyncIterable, AsyncIterator, Protocol
from jsonschema import Draft202012Validator
from .runtime import Runtime, check_schema
from .types import Record, Scope, ProtocolError

OPS = ("sem_search", "sem_filter", "sem_extract", "sem_agg")


PLAN_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["keywords", "instruction", "retrieval_expressions", "goal", "steps"],
    "properties": {
        "keywords": {"type": "array", "items": {"type": "string"}},
        "instruction": {"type": "string"},
        "retrieval_expressions": {"type": "array", "items": {"type": "string"}},
        "knowledge_routes": {"type": "array", "items": {"type": "object", "additionalProperties": False,
            "required": ["entry_id", "reason"], "properties": {
                "entry_id": {"type": "string", "minLength": 1}, "reason": {"type": "string", "minLength": 1}}}},
        "goal": {"type": "object", "additionalProperties": False, "required": ["mode", "count"],
                 "properties": {"mode": {"enum": ["adaptive", "examples", "all"]}, "count": {"type": ["integer", "null"]}}},
        "steps": {"type": "array", "items": {"type": "object", "additionalProperties": False,
            "required": ["id", "op", "inputs", "instruction", "params"], "properties": {
                "id": {"type": "string"}, "op": {"enum": list(OPS)},
                "inputs": {"type": "array", "items": {"type": "string"}},
                "instruction": {"type": "string"}, "params": {"type": "object", "additionalProperties": False,
                    "properties": {"keywords": {"type": "array", "items": {"type": "string"}},
                        "expressions": {"type": "array", "items": {"type": "string"}},
                        "k": {"type": "integer", "minimum": 1}, "batch_size": {"type": "integer", "minimum": 1},
                        "require_source": {"type": "boolean"}, "required_fields": {"type": "array", "items": {"type": "string", "minLength": 1}},
                        "fan_in": {"type": "integer", "minimum": 2},
                        "output_schema": {"type": "object"}}}}}}}}


def validate_plan(plan: dict[str, Any]) -> dict[str, Any]:
    # 先校验封闭 Schema，再检查跨字段约束，拒绝模型夹带未声明能力。
    if not Draft202012Validator(PLAN_SCHEMA).is_valid(plan):
        raise ProtocolError("Invalid query plan schema")
    plan = deepcopy(plan)
    if not plan["instruction"].strip() or not plan["steps"]:
        raise ProtocolError("A plan must preserve a nonempty business instruction and executable steps")
    goal = plan["goal"]
    if (goal["mode"] == "examples" and (type(goal["count"]) is not int or goal["count"] <= 0)) or (goal["mode"] != "examples" and goal["count"] is not None):
        raise ProtocolError("Only examples has an explicit positive result count")
    # known 只收录已验证步骤，使输入引用天然满足拓扑顺序且不可形成环。
    known = {"$source"}
    permitted_params = {"sem_search": {"keywords", "expressions", "k"}, "sem_filter": {"batch_size", "require_source", "required_fields"},
                        "sem_extract": {"output_schema", "batch_size"},
                        "sem_agg": {"fan_in"}}
    for step in plan["steps"]:
        if not step["id"] or step["id"] in known or any(i not in known for i in step["inputs"]):
            raise ProtocolError("Duplicate step ID, invalid input, or non-topological plan")
        # 每种算子仅接收明确白名单参数，计划不能注入代码、身份或预算控制。
        if not set(step["params"]).issubset(permitted_params[step["op"]]):
            raise ProtocolError("Unsupported operator argument; no arbitrary code or budget controls")
        if not step["inputs"] or not step["instruction"].strip():
            raise ProtocolError("Operator requires an input and an instruction")
        if "require_source" in step["params"] and type(step["params"]["require_source"]) is not bool:
            raise ProtocolError("require_source must be Boolean")
        if step["op"] == "sem_extract":
            # 类型化转换的输出 Schema 既要存在，也要通过本地引用安全检查。
            schema = step["params"].get("output_schema")
            if not isinstance(schema, dict):
                raise ProtocolError("Typed transforms require an output schema")
            check_schema(schema)
        for name in ("k", "batch_size", "fan_in"):
            if name in step["params"] and (type(step["params"][name]) is not int or step["params"][name] < (2 if name == "fan_in" else 1)):
                raise ProtocolError("Invalid physical parameter")
        known.add(step["id"])
    # 这里只做保序去重和空白清理，不擅自解释或改写中文逻辑词。
    plan["keywords"] = list(dict.fromkeys(w.strip() for w in plan["keywords"] if w.strip()))
    plan["retrieval_expressions"] = list(dict.fromkeys(w.strip() for w in plan["retrieval_expressions"] if w.strip()))
    return plan


async def plan_query(runtime: Runtime, query: str, confirmed_context: str = "") -> dict[str, Any]:
    if not query.strip():
        raise ValueError("Query is empty")
    context = json.loads(confirmed_context) if confirmed_context else {}
    catalog = context.get("knowledge_catalog")
    schema = deepcopy(PLAN_SCHEMA)
    if catalog is not None:
        schema["required"].append("knowledge_routes")
    available = {entry["id"] for domain in catalog or [] for entry in domain["entries"]}
    evidence_fields = context.get("evidence_fields")
    readable_names = {field["key"] for field in evidence_fields or []}

    def validate_routing(value):
        plan = validate_plan(value)
        if catalog is not None and "knowledge_routes" not in plan:
            raise ProtocolError("Select knowledge_routes explicitly; use [] for zero-shot judgment")
        ids = [route["entry_id"] for route in plan.get("knowledge_routes", [])]
        if len(ids) != len(set(ids)) or any(id not in available for id in ids):
            raise ProtocolError("Knowledge routes must select unique IDs from knowledge_catalog")
        for step in plan["steps"]:
            missing = set(step["params"].get("required_fields", [])) - readable_names
            if evidence_fields is not None and missing:
                raise ProtocolError(f"Unknown evidence fields: {sorted(missing)}; select required_fields only from evidence_fields: {sorted(readable_names)}")
        return plan

    instruction = ("规划工单检索：返回宽召回关键词、少量语义改写、完整业务判据和算子步骤。"
        "判据只来自原句与用户补充，保留对象、状态、时序及纳入/排除关系；知识不能添加条件。"
        "未指定数量用all、count=null；明确要若干案例才用examples。指定工单ID时keywords只放完整ID。"
        "knowledge_routes仅选目录内相关entry_id并简述reason，无适用知识用[]。"
        "普通检索只用一个sem_filter，从$source开始，每步填写params。"
        "sem_filter参数限batch_size、require_source、required_fields；业务条件写instruction。"
        "仅需原文核实时设置require_source和required_fields；字段须取evidence_fields中可用的原文字段，不能用search_fields或摘要替代。"
        "需要对话时只选实际对话字段，如source.raw_dialogue或conversationOrUpdates。"
        "sem_search参数限keywords/expressions/k，sem_extract须有output_schema，sem_agg只设fan_in。"
        "按schema提交对象，params独立于instruction，不生成调用或token预算。")
    # Runtime 在首次响应和缓存复用时执行校验，返回前再校验一次并复制为规范计划。
    # 校验失败多为模型把 JSON 结构写进字符串值；带校验原因重试一次，避免整个检索因一次畸形输出失败。
    try:
        result = await runtime.call("query_plan", instruction, {"original": query, "confirmed_context": confirmed_context}, schema, validate=validate_routing)
    except ProtocolError as exc:
        feedback = "计划校验失败：" + str(exc) + "。按schema重交submit_result对象，params为独立字段。"
        result = await runtime.call("query_plan", instruction + feedback, {"original": query, "confirmed_context": confirmed_context}, schema, validate=validate_routing)
    plan = validate_routing(result.payload)
    return {"original": query, **plan, "manifest_id": result.manifest_id}


@dataclass(frozen=True)
class Hit:
    record: Record
    channel: str
    score: float | None


class SearchBackend(Protocol):
    def semantic(self, vectors: list[list[float]], embedding_id: str, k: int) -> AsyncIterator[Hit]: ...
    def lexical(self, keywords: list[str]) -> AsyncIterator[Hit]: ...


async def _take(scope: Scope, queue: asyncio.Queue):
    # 同时等待队列数据和任务取消，避免无新数据时无法及时响应撤销。
    getter = asyncio.create_task(queue.get())
    cancelled = asyncio.create_task(scope.cancelled.wait())
    try:
        done, _ = await asyncio.wait({getter, cancelled}, return_when=asyncio.FIRST_COMPLETED)
        if cancelled in done and scope.cancelled.is_set():
            raise asyncio.CancelledError("Search cancelled or superseded")
        return await getter
    finally:
        for task in (getter, cancelled):
            if not task.done(): task.cancel()
        await asyncio.gather(getter, cancelled, return_exceptions=True)


async def _pump(stream: AsyncIterable[Any], queue: asyncio.Queue, tag: str) -> None:
    try:
        # 将各通道值、异常和完成信号统一封装后送入共享队列。
        async for value in stream:
            await queue.put((tag, value, None))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await queue.put((tag, None, exc))
    finally:
        # 消费方取消后不再向满队列写完成信号，避免生产任务永久阻塞。
        if not asyncio.current_task().cancelling():
            await queue.put((tag, None, StopAsyncIteration()))


async def sem_search(scope: Scope, backend: SearchBackend, vectors: list[list[float]],
                     embedding_id: str, keywords: list[str], k: int = 20, *, expressions: list[str] | None = None) -> AsyncIterator[Hit]:
    if type(k) is not int or k < 1:
        raise ValueError("Search window must be positive")
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    # 向量、关键词和语义文本各自形成独立通道，可并行返回候选。
    lanes = []
    if vectors:
        lanes.append(_pump(backend.semantic(vectors, embedding_id, k), queue, "semantic"))
    if keywords:
        lanes.append(_pump(backend.lexical(keywords), queue, "lexical"))
    # 语义改写保序去重，避免相同表达重复扫描后端。
    for text in dict.fromkeys(expressions or []):
        if not isinstance(text, str) or not text.strip(): raise ValueError("Invalid search expression")
        lanes.append(_pump(backend.semantic_text(text, k), queue, "semantic"))
    tasks = [asyncio.create_task(c) for c in lanes]
    # 共享队列复用所有通道；先持续交付可用候选，最后统一报告通道故障。
    running, faults = len(tasks), []
    try:
        while running:
            await scope.check()
            _, value, error = await _take(scope, queue)
            if isinstance(error, StopAsyncIteration):
                running -= 1
            elif error is not None:
                faults.append(error)
            else:
                await scope.check()
                yield value
        if faults:
            raise ExceptionGroup("Search channel failure; already emitted hits remain usable candidates", faults)
    finally:
        for task in tasks:
            if not task.done(): task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
