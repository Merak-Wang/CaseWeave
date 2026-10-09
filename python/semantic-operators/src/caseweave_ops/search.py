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


CONDITION_SCHEMA = {"type": "array", "items": {"type": "object", "additionalProperties": False,
    "required": ["field", "op", "value", "source_text"], "properties": {
        "field": {"type": "string", "minLength": 1}, "op": {"enum": ["eq", "neq", "gte", "lte", "contains"]},
        "value": {"type": "string", "minLength": 1, "maxLength": 1000}, "source_text": {"type": "string", "minLength": 1}}}}

PLAN_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["keywords", "instruction", "retrieval_expressions", "goal", "steps"],
    "properties": {
        "structured_conditions": CONDITION_SCHEMA,
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


CANONICAL_FIXED_POLICY = "canonical_text_only_for_custom_prediction"


def canonical_fixed_context(context: dict[str, Any]) -> dict[str, Any] | None:
    declared = context.get("canonical_fixed_context")
    if declared is None:
        return None
    if (not isinstance(declared, dict)
        or declared.get("declared_projection") != "canonical-title-abstract-v1"
        or declared.get("source_evidence_policy") != CANONICAL_FIXED_POLICY
        or declared.get("available_text_fields") != ["title", "summary"]
        or not isinstance(declared.get("unavailable_source_fields"), list)
        or not isinstance(declared.get("explicit_source_requirements"), list)
        or any(not isinstance(field, str) or not field.strip()
               for field in declared["unavailable_source_fields"])):
        raise ProtocolError("Invalid canonical fixed context declaration")
    source = context.get("full_user_text", "")
    if not isinstance(source, str):
        raise ProtocolError("Canonical source requirements need authoritative user text")
    requirements = declared["explicit_source_requirements"]
    for item in requirements:
        if (not isinstance(item, dict) or set(item) != {"field", "source_text", "provenance"}
            or item.get("field") not in declared["unavailable_source_fields"]
            or item.get("provenance") != "host-explicit-raw-request-v1"
            or not isinstance(item.get("source_text"), str) or not item["source_text"].strip()
            or item["source_text"] not in source):
            raise ProtocolError("Invalid host-declared explicit source requirement")
    if len({(item["field"], item["source_text"]) for item in requirements}) != len(requirements):
        raise ProtocolError("Duplicate host-declared explicit source requirement")
    return declared


def fixed_custom_query_schema(context: dict[str, Any]) -> dict[str, Any]:
    declared = canonical_fixed_context(context)
    if declared is None:
        raise ProtocolError("Canonical fixed context is required")
    schema = {"type": "object", "additionalProperties": False,
        "required": ["keywords", "instruction", "retrieval_expressions", "structured_conditions"],
        "properties": {name: deepcopy(PLAN_SCHEMA["properties"][name]) for name in
            ("keywords", "instruction", "retrieval_expressions", "knowledge_routes", "structured_conditions")}}
    if context.get("knowledge_catalog") is not None:
        schema["required"].append("knowledge_routes")
    # Missing-source requirements are generated by the host from real task text.
    # The model has no field in which to invent an unavailable source requirement.
    return schema


def parse_fixed_query(value: dict[str, Any], query: str, context: dict[str, Any]) -> dict[str, Any]:
    schema = fixed_custom_query_schema(context)
    if not Draft202012Validator(schema).is_valid(value):
        raise ProtocolError("Invalid canonical fixed intent schema")
    catalog = context.get("knowledge_catalog")
    available = {entry["id"] for domain in catalog or [] for entry in domain["entries"]}
    routes = value.get("knowledge_routes", [])
    route_ids = [route["entry_id"] for route in routes]
    if len(set(route_ids)) != len(route_ids) or any(key not in available for key in route_ids):
        raise ProtocolError("Invalid knowledge route")
    fields = {field["key"]: field for field in context.get("search_fields", [])
              if field.get("origin") == "source" and field.get("availability") == "available"}
    source = context.get("full_user_text", query)
    for condition in value["structured_conditions"]:
        field = fields.get(condition["field"])
        capability = ("range" if condition["op"] in {"gte", "lte"}
                      else "eq" if condition["op"] == "neq" else condition["op"])
        if (not field or capability not in field.get("operations", [])
            or not condition["source_text"].strip() or condition["source_text"] not in source):
            raise ProtocolError("Structured condition lacks an available source field or exact user provenance")
    unsupported = canonical_fixed_context(context)["explicit_source_requirements"]
    instruction = value["instruction"]
    if unsupported:
        instruction += "\n用户明示但当前标题摘要投影无法核实的约束：" + "；".join(item["source_text"] for item in unsupported)
    plan = {key: deepcopy(value[key]) for key in
            ("keywords", "retrieval_expressions", "structured_conditions")}
    plan.update(instruction=instruction, goal=deepcopy(context.get("fixed_goal", {"mode": "all", "count": None})),
                knowledge_routes=deepcopy(routes), steps=[{"id": "filter", "op": "sem_filter",
                "inputs": ["$source"], "instruction": instruction,
                "params": {"require_source": False, "required_fields": []}}])
    normalized = validate_plan(plan)
    if unsupported:
        normalized["unsupported_constraints"] = deepcopy(unsupported)
    return normalized


async def plan_fixed_query(runtime: Runtime, query: str, confirmed_context: str, context: dict[str, Any]) -> dict[str, Any]:
    if canonical_fixed_context(context) is None:
        return await _plan_fixed_legacy_query(runtime, query, confirmed_context, context)
    schema = fixed_custom_query_schema(context)
    instruction = ("一次生成工单检索计划：keywords是关键词OR宽召回；retrieval_expressions是1到3条语义检索改写。"
        "instruction完整保留用户业务对象、状态、纳入与排除条件，不新增硬条件。"
        "工单判断只读取title和summary。structured_conditions仅用于用户明确要求的结构化字段过滤，"
        "必须选search_fields中给出的字段及支持运算，source_text逐字引用query；语义要求放instruction，不能把title/summary当结构化字段，无则[]。"
        "knowledge_routes用[]。只调用submit_result一次。")
    # 请求只送用户判据和可检索字段；来源身份与执行参数留在宿主，不重复塞进模型上下文。
    payload = {"query": context.get("full_user_text", query), "search_fields": [
        {"key": field["key"], "operations": field.get("operations", [])}
        for field in context.get("search_fields", [])
        if field.get("origin") == "source" and field.get("availability") == "available"]}
    normalized = lambda value: parse_fixed_query(value, query, context)
    result = await runtime.call("query_plan", instruction, payload, schema, validate=normalized)
    return {"original": query, **normalized(result.payload), "manifest_id": result.manifest_id}


async def _plan_fixed_legacy_query(runtime: Runtime, query: str, confirmed_context: str, context: dict[str, Any]) -> dict[str, Any]:
    """One model interpretation; goal and the single filter step belong to the host."""
    schema = {"type": "object", "additionalProperties": False,
        "required": ["keywords", "instruction", "retrieval_expressions", "structured_conditions", "require_source", "required_fields"],
        "properties": {name: deepcopy(PLAN_SCHEMA["properties"][name]) for name in
            ("keywords", "instruction", "retrieval_expressions", "knowledge_routes", "structured_conditions")}}
    schema["properties"].update({"require_source": {"type": "boolean"},
        "required_fields": {"type": "array", "items": {"type": "string", "minLength": 1}}})
    catalog = context.get("knowledge_catalog")
    if catalog is not None: schema["required"].append("knowledge_routes")
    available = {e["id"] for d in catalog or [] for e in d["entries"]}
    readable = {f["key"] for f in context.get("evidence_fields", [])}
    fields = {f["key"]: f for f in context.get("search_fields", []) if f.get("origin") == "source" and f.get("availability") == "available"}
    source = context.get("full_user_text", query)
    goal = context.get("fixed_goal", {"mode": "all", "count": None})
    def normalized(value):
        routes = value.get("knowledge_routes", [])
        ids = [r["entry_id"] for r in routes]
        if len(set(ids)) != len(ids) or any(i not in available for i in ids): raise ProtocolError("Invalid knowledge route")
        if not set(value["required_fields"]).issubset(readable): raise ProtocolError("Unknown source evidence field")
        for c in value["structured_conditions"]:
            field = fields.get(c["field"])
            capability = "range" if c["op"] in {"gte", "lte"} else "eq" if c["op"] == "neq" else c["op"]
            if not field or capability not in field.get("operations", []) or not c["source_text"].strip() or c["source_text"] not in source:
                raise ProtocolError("Structured condition lacks an available source field or exact user provenance")
        plan = {k: deepcopy(value[k]) for k in ("keywords", "instruction", "retrieval_expressions", "structured_conditions")}
        plan.update(goal=deepcopy(goal), knowledge_routes=deepcopy(routes), steps=[{"id": "filter", "op": "sem_filter",
            "inputs": ["$source"], "instruction": value["instruction"], "params": {
                "require_source": value["require_source"], "required_fields": value["required_fields"]}}])
        return validate_plan(plan)
    instruction = ("理解工单检索原句与用户补充，仅返回完整业务判据、宽召回关键词、少量向量表达式、显式结构化条件和所需来源字段。"
        "保留对象、状态、时序、纳入与排除关系。关键词和软语义扩展只用于召回，不能变成硬筛选。"
        "structured_conditions仅来自用户明确的必要字段条件，每项source_text逐字引用用户原文；只选search_fields内available且source的字段及支持运算，无明确条件用[]。"
        "知识不添加条件；knowledge_routes只选目录ID，无适用条目用[]。required_fields只选evidence_fields内可用来源字段。"
        "不生成goal或执行steps，宿主固定编排。按schema提交对象。")
    payload = {"original": query, "confirmed_context": confirmed_context}
    result = await runtime.call("query_plan", instruction, payload, schema, validate=normalized)
    return {"original": query, **normalized(result.payload), "manifest_id": result.manifest_id}


async def plan_query(runtime: Runtime, query: str, confirmed_context: str = "") -> dict[str, Any]:
    if not query.strip():
        raise ValueError("Query is empty")
    context = json.loads(confirmed_context) if confirmed_context else {}
    if context.get("fixed_orchestration") is True:
        return await plan_fixed_query(runtime, query, confirmed_context, context)
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
