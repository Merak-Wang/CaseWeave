"""Independent fixed-plan acceptance tests: synthetic output, real Runtime/store."""
import asyncio
import copy
import json
import pytest
from jsonschema import Draft202012Validator
from caseweave_ops import plan_query
from caseweave_ops.types import ProtocolError

QUERY = "找全部北京副卡工单，必须查看问题原文"
CONDITION = {"field": "region", "op": "eq", "value": "北京", "source_text": "北京"}


def model_plan():
    return {"keywords": [" 副卡 ", "副卡"], "instruction": "仅纳入北京副卡工单",
            "retrieval_expressions": ["北京副卡问题"], "structured_conditions": [copy.deepcopy(CONDITION)],
            "require_source": True, "required_fields": ["problemDescription"]}


def context(**updates):
    value = {"fixed_orchestration": True, "fixed_goal": {"mode": "all", "count": None},
             "full_user_text": QUERY,
             "search_fields": [{"key": "region", "origin": "source", "availability": "available",
                                "operations": ["eq", "contains", "range"]}],
             "evidence_fields": [{"key": "problemDescription"}]}
    value.update(updates)
    return json.dumps(value, ensure_ascii=False)


def test_fixed_plan_one_actual_intent_then_cache_zero_additional_calls(make_runtime):
    requests = []
    def response(payload, request):
        requests.append(request)
        assert payload["original"] == QUERY
        return model_plan()
    rt = make_runtime(response)
    first = asyncio.run(plan_query(rt, QUERY, context()))
    second = asyncio.run(plan_query(rt, QUERY, context()))
    assert rt.model.calls == 1
    assert second["manifest_id"] == first["manifest_id"]
    assert first["keywords"] == ["副卡"]
    schema = requests[0]["schema"]
    assert "goal" not in schema["properties"] and "steps" not in schema["properties"]
    assert not Draft202012Validator(schema).is_valid({**model_plan(), "goal": {"mode": "examples", "count": 1}})
    assert not Draft202012Validator(schema).is_valid({**model_plan(), "steps": []})


@pytest.mark.parametrize("goal", [{"mode": "all", "count": None}, {"mode": "examples", "count": 3},
                                  {"mode": "adaptive", "count": None}])
def test_goal_and_only_filter_step_are_host_owned(make_runtime, goal):
    original = model_plan()
    saved = copy.deepcopy(original)
    rt = make_runtime(lambda payload, request: original)
    result = asyncio.run(plan_query(rt, QUERY, context(fixed_goal=goal)))
    assert result["goal"] == goal and rt.model.calls == 1
    assert result["steps"] == [{"id": "filter", "op": "sem_filter", "inputs": ["$source"],
        "instruction": original["instruction"],
        "params": {"require_source": True, "required_fields": ["problemDescription"]}}]
    assert original == saved


@pytest.mark.parametrize("changed", [
    {"field": "invented"}, {"source_text": "用户并未提到的上海"},
    {"op": "contains", "value": "北京", "field": "generated_region"},
])
def test_conditions_need_real_available_field_and_user_quote(make_runtime, changed):
    value = model_plan()
    value["structured_conditions"][0].update(changed)
    rt = make_runtime(lambda payload, request: value)
    with pytest.raises(ProtocolError):
        asyncio.run(plan_query(rt, QUERY, context()))
    assert rt.model.calls == 1  # 格式错误结束本次规划，不再请求大模型修复。


@pytest.mark.parametrize("field", [
    {"key": "region", "origin": "generated", "availability": "available", "operations": ["eq"]},
    {"key": "region", "origin": "source", "availability": "unavailable", "operations": ["eq"]},
    {"key": "region", "origin": "source", "availability": "available", "operations": ["contains"]},
])
def test_generated_unavailable_or_unsupported_conditions_rejected(make_runtime, field):
    rt = make_runtime(lambda payload, request: model_plan())
    with pytest.raises(ProtocolError):
        asyncio.run(plan_query(rt, QUERY, context(search_fields=[field])))
    assert rt.model.calls == 1


def test_unknown_required_source_field_is_not_reinterpreted_as_search_text(make_runtime):
    value = model_plan()
    value["required_fields"] = ["body"]
    rt = make_runtime(lambda payload, request: value)
    with pytest.raises(ProtocolError):
        asyncio.run(plan_query(rt, QUERY, context()))
    assert rt.model.calls == 1


def test_feedback_provenance_can_be_used_without_adding_wiki_conditions(make_runtime):
    quote = "只看北京"
    value = model_plan()
    value["structured_conditions"][0]["source_text"] = quote
    value["knowledge_routes"] = []
    rt = make_runtime(lambda payload, request: value)
    result = asyncio.run(plan_query(rt, "找副卡工单", context(full_user_text="找副卡工单\n" + quote,
        knowledge_catalog=[{"id": "scope", "entries": [{"id": "entry"}]}])))
    assert result["structured_conditions"] == value["structured_conditions"]
    assert rt.model.calls == 1


def test_invalid_condition_fails_after_one_call_without_model_repair(make_runtime):
    calls = []
    def response(payload, request):
        calls.append(request)
        value = model_plan()
        if len(calls) == 1:
            value["structured_conditions"][0]["source_text"] = "不存在的条件"
        return value
    rt = make_runtime(response)
    with pytest.raises(ProtocolError):
        asyncio.run(plan_query(rt, QUERY, context(fixed_goal={"mode": "examples", "count": 2})))
    assert rt.model.calls == 1 and len(calls) == 1


def test_cancelled_planning_can_resume_with_same_scope_without_reusing_cancelled_result(make_runtime):
    async def run():
        entered, wait = asyncio.Event(), asyncio.Event()
        async def response(payload, request):
            entered.set()
            await wait.wait()
            return model_plan()
        rt = make_runtime(response)
        pending = asyncio.create_task(plan_query(rt, QUERY, context()))
        await asyncio.wait_for(entered.wait(), 1)
        rt.scope.cancelled.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(pending, 1)
        assert rt.model.calls == 1
        rt.scope.cancelled.clear()
        wait.set()
        result = await asyncio.wait_for(plan_query(rt, QUERY, context()), 1)
        assert result["goal"]["mode"] == "all" and rt.model.calls == 2
        again = await plan_query(rt, QUERY, context())
        assert again["manifest_id"] == result["manifest_id"] and rt.model.calls == 2
    asyncio.run(run())

def test_whitespace_quote_does_not_prove_a_user_condition(make_runtime):
    value = model_plan()
    value["structured_conditions"][0]["source_text"] = " "
    rt = make_runtime(lambda payload, request: value)
    with pytest.raises(ProtocolError):
        asyncio.run(plan_query(rt, QUERY, context(full_user_text=QUERY + " ")))
