import asyncio
import copy
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


def test_invalid_plan_is_not_reused_after_operator_validation_failed():
    class Model:
        identity = 'review-fixture'
        calls = 0

        async def generate(self, request):
            self.calls += 1
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
            with pytest.raises(ProtocolError):
                await plan_query(runtime, '查找宽带案例')
            try:
                await plan_query(runtime, '查找宽带案例')
            except ProtocolError:
                pass
            print({'model_calls_after_two_plan_attempts': model.calls})
            assert model.calls == 2, 'A rejected plan is served from cache forever; the model cannot repair it'
        finally:
            store.close()

    asyncio.run(run())
