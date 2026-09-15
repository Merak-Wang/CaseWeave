import asyncio
import copy
import pytest
from caseweave_ops.planner import validate_plan
from caseweave_ops.types import ProtocolError


def plan():
    return {"keywords": ["副卡"], "instruction": "相关案例", "retrieval_expressions": [],
            "goal": {"mode": "adaptive", "count": None},
            "steps": [{"id": "filter", "op": "sem_filter", "inputs": ["$source"],
                       "instruction": "相关案例", "params": {}}]}


def test_adaptive_goal_does_not_invent_result_count_or_exhaustive_scope():
    assert validate_plan(plan())["goal"] == {"mode": "adaptive", "count": None}
    invalid = plan()
    invalid["goal"]["count"] = 20
    with pytest.raises(ProtocolError):
        validate_plan(invalid)


@pytest.mark.parametrize("params", [{"require_source": "false"}, {"batch_size": True}])
def test_plan_rejects_coerced_physical_types(params):
    invalid = plan()
    invalid["steps"][0]["params"] = params
    with pytest.raises(ProtocolError):
        validate_plan(invalid)


def test_plan_does_not_mutate_model_submission():
    source = plan()
    source["keywords"] = [" 副卡 ", "副卡"]
    saved = copy.deepcopy(source)
    assert validate_plan(source)["keywords"] == ["副卡"]
    assert source == saved


def test_model_invented_field_filter_is_rejected_by_advertised_schema():
    from jsonschema import Draft202012Validator
    from caseweave_ops.planner import PLAN_SCHEMA
    invalid = plan()
    invalid['steps'][0]['params'] = {'field': 'displayId', 'op': 'eq', 'value': 'case-1'}
    assert not Draft202012Validator(PLAN_SCHEMA).is_valid(invalid)


def test_output_schema_cannot_resolve_network_resources():
    from caseweave_ops.schema import check_schema
    with pytest.raises(ValueError):
        check_schema({'type': 'object', 'properties': {'item': {'$ref': 'https://example.invalid/schema'}}})
