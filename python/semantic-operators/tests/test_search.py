import asyncio
import copy
import json
import pytest
from caseweave_ops import *
from caseweave_ops.search import PLAN_SCHEMA, validate_plan
from conftest import record, source, collect

def plan():
    return {"keywords":["副卡","解绑","副卡"],"instruction":"当前需要办理解绑；排除未来自行办理和纯咨询。",
            "retrieval_expressions":["副卡解绑受阻"],"goal":{"mode":"all","count":None},
            "steps":[{"id":"s","op":"sem_search","inputs":["$source"],"instruction":"找线索","params":{}},
                     {"id":"f","op":"sem_filter","inputs":["s"],"instruction":"严格按业务要求判断","params":{}}]}


def test_first_plan_is_one_llm_call_and_no_boolean_ast(make_runtime):
    rt=make_runtime(lambda p,r:plan())
    p=asyncio.run(plan_query(rt,"找全部副卡解绑问题，先显示20条"))
    assert rt.model.calls==1 and p["goal"]=={"mode":"all","count":None}
    assert p["keywords"]==["副卡","解绑"] and "hard" not in p and "keyword_ast" not in p
    assert p["original"].endswith("先显示20条")


@pytest.mark.parametrize("routes", [[], [{"entry_id": "expiry", "reason": "理解到期后的资费变化"}]])
def test_planning_routes_only_catalog_knowledge_in_the_same_call(make_runtime, routes):
    context = json.dumps({"knowledge_catalog": [{"id": "broadband", "entries": [{"id": "expiry"}]}]})
    rt = make_runtime(lambda p, r: {**plan(), "knowledge_routes": routes})
    result = asyncio.run(plan_query(rt, "宽带到期扣费", context))
    assert result["knowledge_routes"] == routes
    assert rt.model.calls == 1


@pytest.mark.parametrize("routes", [None, [{"entry_id": "missing", "reason": "编造条目"}],
    [{"entry_id": "expiry", "reason": "重复"}] * 2])
def test_routing_rejects_missing_invented_or_duplicate_choices(make_runtime, routes):
    context = json.dumps({"knowledge_catalog": [{"id": "broadband", "entries": [{"id": "expiry"}]}]})
    rt = make_runtime(lambda p, r: {**plan(), **({"knowledge_routes": routes} if routes is not None else {})})
    with pytest.raises(ProtocolError):
        asyncio.run(plan_query(rt, "宽带到期扣费", context))
    assert rt.model.calls == 2


def test_planner_repairs_search_index_name_instead_of_requiring_nonexistent_evidence(make_runtime):
    requests = []
    def respond(payload, request):
        requests.append(request)
        value = adaptive_plan()
        value['steps'][0]['params'] = {'required_fields': ['body' if len(requests) == 1 else 'problemDescription']}
        return value
    rt = make_runtime(respond)
    context = json.dumps({'search_fields': ['body'], 'evidence_fields': [{'key': 'problemDescription'}]})
    value = asyncio.run(plan_query(rt, '宽带到期扣费', context))
    assert value['steps'][0]['params']['required_fields'] == ['problemDescription']
    assert rt.model.calls == 2
    assert 'Unknown evidence fields' in requests[-1]['messages'][0]['content']


def test_plan_rejects_budget_and_invalid_dependencies():
    p=plan(); p["steps"][0]["params"]["max_calls"]=3
    with pytest.raises(ProtocolError): validate_plan(p)
    p=plan(); p["steps"][0]["inputs"]=["later"]
    with pytest.raises(ProtocolError): validate_plan(p)


@pytest.mark.parametrize('op', ['sem_map', 'sem_topk', 'sem_join'])
def test_retired_semantic_operators_are_not_dispatch_or_planning_entries(make_runtime, op):
    from caseweave_ops import invoke_rows
    p = plan(); p['steps'][1]['op'] = op
    with pytest.raises(ProtocolError): validate_plan(p)
    with pytest.raises(ProtocolError): asyncio.run(collect(invoke_rows(op, make_runtime(), source([]), 'q')))


def test_plan_target_is_not_page_size():
    p=plan(); p["goal"]["count"]=20
    with pytest.raises(ProtocolError): validate_plan(p)
    p["goal"]["mode"]="examples"
    assert validate_plan(p)["goal"]["count"]==20


def test_search_cancel_does_not_wait_for_backend():
    async def run():
        class B:
            async def semantic(self,*args):
                await asyncio.sleep(60)
                yield Hit(record(),"vector",1)
            async def lexical(self,*args):
                if False: yield None
        scope=Scope("t",1,"s","a")
        stream=sem_search(scope,B(),[[1,0]],"id",[])
        t=asyncio.create_task(anext(stream))
        await asyncio.sleep(.01);scope.cancelled.set()
        with pytest.raises(asyncio.CancelledError): await asyncio.wait_for(t,2)
    asyncio.run(run())


def adaptive_plan():
    return {"keywords": ["副卡"], "instruction": "相关案例", "retrieval_expressions": [],
            "goal": {"mode": "adaptive", "count": None},
            "steps": [{"id": "filter", "op": "sem_filter", "inputs": ["$source"],
                       "instruction": "相关案例", "params": {}}]}


def test_adaptive_goal_does_not_invent_result_count_or_exhaustive_scope():
    assert validate_plan(adaptive_plan())["goal"] == {"mode": "adaptive", "count": None}
    invalid = adaptive_plan()
    invalid["goal"]["count"] = 20
    with pytest.raises(ProtocolError):
        validate_plan(invalid)


@pytest.mark.parametrize("params", [{"require_source": "false"}, {"batch_size": True}])
def test_plan_rejects_coerced_physical_types(params):
    invalid = adaptive_plan()
    invalid["steps"][0]["params"] = params
    with pytest.raises(ProtocolError):
        validate_plan(invalid)


def test_plan_does_not_mutate_model_submission():
    source = adaptive_plan()
    source["keywords"] = [" 副卡 ", "副卡"]
    saved = copy.deepcopy(source)
    assert validate_plan(source)["keywords"] == ["副卡"]
    assert source == saved


def test_model_invented_field_filter_is_rejected_by_advertised_schema():
    from jsonschema import Draft202012Validator
    from caseweave_ops.search import PLAN_SCHEMA
    invalid = adaptive_plan()
    invalid['steps'][0]['params'] = {'field': 'displayId', 'op': 'eq', 'value': 'case-1'}
    assert not Draft202012Validator(PLAN_SCHEMA).is_valid(invalid)


def test_output_schema_cannot_resolve_network_resources():
    from caseweave_ops.runtime import check_schema
    with pytest.raises(ValueError):
        check_schema({'type': 'object', 'properties': {'item': {'$ref': 'https://example.invalid/schema'}}})


def test_invalid_plan_gets_one_feedback_retry_and_model_can_repair():
    class Model:
        identity = 'review-fixture'
        calls = 0
        requests = []

        async def generate(self, request):
            self.calls += 1
            self.requests.append(request['messages'][0]['content'])
            return ModelReply({
                'keywords': ['宽带'], 'instruction': '只找宽带案例', 'retrieval_expressions': [],
                'goal': {'mode': 'adaptive', 'count': 3 if self.calls == 1 else None},
                'steps': [{'id': 'filter', 'op': 'sem_filter', 'inputs': ['$source'],
                           'instruction': '依据证据判断', 'params': {}}],
            })

    async def run():
        model, store = Model(), ArtifactStore()
        try:
            runtime = Runtime(Scope('review-task', 0, 'snapshot', 'authorization'), model, store, Knowledge('none'))
            # 第一次计划未通过校验时同一调用内带反馈重试一次，模型第二次即可修复并返回有效计划
            plan = await plan_query(runtime, '查找宽带案例')
            assert model.calls == 2 and plan['goal'] == {'mode': 'adaptive', 'count': None}
            # 重试请求携带校验原因，模型能看到具体失败原因并纠正
            assert 'Only examples has an explicit positive result count' in model.requests[1]
            assert 'submit_result' in model.requests[1]
        finally:
            store.close()

    asyncio.run(run())


def test_always_invalid_plan_fails_after_exactly_one_feedback_retry():
    class Model:
        identity = 'review-fixture'
        calls = 0

        async def generate(self, request):
            self.calls += 1
            return ModelReply({
                'keywords': ['宽带'], 'instruction': '只找宽带案例', 'retrieval_expressions': [],
                'goal': {'mode': 'adaptive', 'count': 3},
                'steps': [{'id': 'filter', 'op': 'sem_filter', 'inputs': ['$source'],
                           'instruction': '依据证据判断', 'params': {}}],
            })

    async def run():
        model, store = Model(), ArtifactStore()
        try:
            runtime = Runtime(Scope('review-task', 0, 'snapshot', 'authorization'), model, store, Knowledge('none'))
            # 模型始终输出无效计划：只反馈重试一次后如实失败，不无限循环
            with pytest.raises(ProtocolError):
                await plan_query(runtime, '查找宽带案例')
            assert model.calls == 2
        finally:
            store.close()

    asyncio.run(run())
