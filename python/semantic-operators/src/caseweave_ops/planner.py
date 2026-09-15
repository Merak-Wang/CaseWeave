"""生成一次结构化模型计划；关键词只用于宽召回，不充当业务逻辑 AST。"""
from __future__ import annotations
from typing import Any
from copy import deepcopy
from jsonschema import Draft202012Validator
from .model import Runtime
from .types import ProtocolError
from .schema import check_schema

OPS = ("sem_search", "sem_filter", "sem_topk", "sem_map", "sem_extract", "sem_join", "sem_agg")
PLAN_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["keywords", "instruction", "retrieval_expressions", "goal", "steps"],
    "properties": {
        "keywords": {"type": "array", "items": {"type": "string"}},
        "instruction": {"type": "string"},
        "retrieval_expressions": {"type": "array", "items": {"type": "string"}},
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
                        "sem_topk": {"k"}, "sem_map": {"output_schema", "batch_size"},
                        "sem_extract": {"output_schema", "batch_size"}, "sem_join": {"batch_size"},
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
        if step["op"] == "sem_topk" and "k" not in step["params"]:
            raise ProtocolError("topk requires k")
        if step["op"] in ("sem_map", "sem_extract"):
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
    instruction = ("理解用户要检索的业务集合，给出关键词列表、完整自然语言判据和核心算子计划。"
        "不生成关键词AND/OR/NOT树；词表只是宽召回线索。复杂逻辑保留在instruction中交给算子执行。"
        "保留主体、时间、已完成与待办理、纳入与排除边界，不凭空增加字段筛选。"
        "不要提问，不要要求用户标注。首轮计划保持直接，仅选本次需要的算子。"
        "少量retrieval_expressions是检索先验，不是事实或标签。"
        "没有明确数量或全集要求时使用adaptive且count=null，由主Agent判断案例是否充分。"
        "all仅用于用户明确要求全集，count必须为null；examples是用户明确要求的案例数量，不是页面大小。"
        "仅核实指定工单ID时keywords只填完整ID，retrieval_expressions可为空；instruction限定该工单，不以主题近似替代ID。"
        "普通检索只需一个sem_filter步骤。需要原始对话时params为{\"require_source\":true,\"required_fields\":[\"source.raw_dialogue\"]}；若来源只有conversationOrUpdates则使用该字段。按evidence_fields选择实际对话字段。"
        "核实其他原文字段时在required_fields中填写字段名。require_source表示引文必须是来源事实，required_fields独立约束实际读到并引用的字段；摘要不能替代对话。缺少原文返回未决，主Agent定向读取后再过滤。"
        "sem_filter仅允许batch_size、require_source、required_fields参数，不支持field/op/value；语义条件写instruction。"
        "sem_search仅允许keywords/expressions/k；sem_topk必须有k；sem_map和sem_extract必须有output_schema；"
        "sem_join仅允许batch_size，sem_agg仅允许fan_in。没有字段产出要求时不要添加map/extract。"
        "输入从$source开始，按依赖顺序填写steps，每步都必须有params对象。计量不设预算，不生成call/token次数上限。")
    # Runtime 在首次响应和缓存复用时执行校验，返回前再校验一次并复制为规范计划。
    result = await runtime.call("query_plan", instruction, {"original": query, "confirmed_context": confirmed_context}, PLAN_SCHEMA, validate=validate_plan)
    plan = validate_plan(result.payload)
    return {"original": query, **plan, "manifest_id": result.manifest_id}
