"""Synthetic canonical intent tests using the actual Runtime/cache; no network."""
import asyncio
import copy
import json
import pytest
from jsonschema import Draft202012Validator
from caseweave_ops import plan_query
from caseweave_ops.search import fixed_custom_query_schema, parse_fixed_query
from caseweave_ops.types import ProtocolError
from caseweave_ops.runtime import ModelRequestError


def context(query='设备故障', **changes):
    value = {'fixed_orchestration': True, 'fixed_goal': {'mode': 'all', 'count': None},
             'full_user_text': query, 'search_fields': [], 'evidence_fields': [],
             'canonical_fixed_context': {
                 'source_evidence_policy': 'canonical_text_only_for_custom_prediction',
                 'declared_projection': 'canonical-title-abstract-v1',
                 'available_text_fields': ['title', 'summary'],
                 'unavailable_source_fields': ['problemDescription', 'conversationOrUpdates',
                     'resolutionSteps', 'rootCause', 'answer', 'source.raw_dialogue', 'source.resolution'],
                 'explicit_source_requirements': []}}
    value.update(changes)
    return value


def interpretation():
    return {'keywords': ['设备故障', '故障告警', '设备异常', '硬件故障', '运行异常', '链路故障',
                         '掉电', '死机', '重启异常', '损坏', '不可用', '中断', '告警', '维修', '故障恢复', '设备报错'],
            'instruction': '查找标题或摘要描述设备故障的工单，不增加原文证据要求。',
            'retrieval_expressions': ['设备异常或故障告警'], 'structured_conditions': []}


@pytest.mark.parametrize('query', [
    '筛选明确描述光猫、路由器、终端或其他设备故障，或者为处理设备故障而请求或实施重启、更换的工单。',
    '筛选明确描述拨号认证、业务认证或账号登录失败、报错、异常或无法完成的工单。',
    '筛选明确描述预约改期、延期、重新预约，或者联系客户时无人接听、联系不上或无法联系的工单。',
])
def test_original_generic_intent_one_real_runtime_model_invocation_and_cache(make_runtime, query):
    requests = []
    def answer(payload, request):
        requests.append(request)
        assert payload == {'query': query, 'search_fields': []}
        prompt = request['messages'][0]['content'] + request['messages'][1]['content']
        for rule in ('身份称谓', '实际操作受阻的具体症状', '实际操作、具体症状互补',
                     '不额外要求确诊某个单一根因'):
            assert rule in prompt
        return interpretation()
    rt = make_runtime(answer)
    serialized = json.dumps(context(query), ensure_ascii=False)
    first = asyncio.run(plan_query(rt, query, serialized))
    second = asyncio.run(plan_query(rt, query, serialized))
    assert rt.model.calls == 1 and len(requests) == 1
    assert first['manifest_id'] == second['manifest_id']
    assert first['keywords'] == interpretation()['keywords']
    assert first['steps'][0]['params'] == {'require_source': False, 'required_fields': []}
    assert 'unsupported_constraints' not in first
    schema = requests[0]['schema']
    assert schema['required'] == ['keywords', 'instruction', 'retrieval_expressions', 'structured_conditions']
    assert 'require_source' not in schema['properties'] and 'required_fields' not in schema['properties']
    assert 'unsupported_constraints' not in schema['properties']


@pytest.mark.parametrize('extra', [{'require_source': True}, {'required_fields': ['rootCause']}, {'goal': {}}, {'steps': []}, {'invented': True}])
def test_fixed_parser_rejects_unknown_or_old_field_protocol(extra):
    value = {**interpretation(), **extra}
    assert not Draft202012Validator(fixed_custom_query_schema(context())).is_valid(value)
    with pytest.raises(ProtocolError):
        parse_fixed_query(value, '设备故障', context())


def test_parser_preserves_specific_keywords_and_does_not_mutate_response():
    value = interpretation()
    original = copy.deepcopy(value)
    plan = parse_fixed_query(value, '设备故障', context())
    assert plan['keywords'] == original['keywords']
    assert value == original


def test_compound_intent_keeps_submitted_discovery_terms_and_specific_product(make_runtime):
    query = '帮我找宽带欠费停机和5G业务相关工单'
    value = {'keywords': ['宽带', '欠费', '停机', '宽带欠费', '欠费停机', '5G'],
             'instruction': '查找宽带欠费停机和5G业务相关工单。',
             'retrieval_expressions': ['宽带欠费停机与5G业务'], 'structured_conditions': []}
    def answer(payload, request):
        assert payload['query'] == query
        prompt = json.dumps(request['messages'], ensure_ascii=False)
        assert '业务对象的常用别名' in prompt
        assert '不能仅因短词包含在复合短语中就删除' in prompt
        assert '去掉帮我找、相关工单' in prompt
        return value
    runtime = make_runtime(answer)
    result = asyncio.run(plan_query(runtime, query, json.dumps(context(query), ensure_ascii=False)))
    assert runtime.model.calls == 1
    assert result['keywords'] == value['keywords']
    assert result['instruction'] == value['instruction']
    assert result['retrieval_expressions'] == value['retrieval_expressions']
    assert value['keywords'] == ['宽带', '欠费', '停机', '宽带欠费', '欠费停机', '5G']


def test_explicit_missing_raw_evidence_keeps_quote_and_unknown_metadata():
    query = '找设备故障工单，必须逐字核对对话原文'
    value = interpretation()
    ctx = context(query)
    declared = [{'field': 'source.raw_dialogue', 'source_text': '必须逐字核对对话原文',
                 'provenance': 'host-explicit-raw-request-v1'}]
    ctx['canonical_fixed_context']['explicit_source_requirements'] = declared
    plan = parse_fixed_query(value, query, ctx)
    assert plan['unsupported_constraints'] == declared
    assert '必须逐字核对对话原文' in plan['instruction']
    assert plan['steps'][0]['instruction'] == plan['instruction']


def test_actual_runtime_rejects_invented_field_without_another_planning_call(make_runtime):
    def answer(payload, request):
        value = interpretation()
        if rt.model.calls == 1:
            value['unsupported_constraints'] = [{'field': 'resolutionSteps', 'source_text': payload['query']}]
        return value
    rt = make_runtime(answer)
    query = '找请求更换设备的工单'
    with pytest.raises(ModelRequestError, match='结构化'):
        asyncio.run(plan_query(rt, query, json.dumps(context(query), ensure_ascii=False)))
    assert rt.model.calls == 1


def test_actual_runtime_preserves_host_explicit_raw_request_without_model_field_choice(make_runtime):
    query = '必须逐字核对对话原文中设备更换要求'
    ctx = context(query)
    declared = [{'field': 'source.raw_dialogue', 'source_text': query,
                 'provenance': 'host-explicit-raw-request-v1'}]
    ctx['canonical_fixed_context']['explicit_source_requirements'] = declared
    rt = make_runtime(lambda _payload, _request: interpretation())
    plan = asyncio.run(plan_query(rt, query, json.dumps(ctx, ensure_ascii=False)))
    assert rt.model.calls == 1
    assert plan['unsupported_constraints'] == declared


@pytest.mark.parametrize('constraint', [
    {'field': 'rootCause', 'source_text': '用户没有要求的原文'},
    {'field': 'not_in_catalog', 'source_text': '设备故障'},
    {'field': 'source.raw_dialogue', 'source_text': ' '},
    {'field': 'resolutionSteps', 'source_text': '设备故障'},
])
def test_model_cannot_invent_missing_evidence_requirement_without_quote_and_field_provenance(constraint):
    value = {**interpretation(), 'unsupported_constraints': [constraint]}
    with pytest.raises(ProtocolError):
        parse_fixed_query(value, '设备故障', context())


@pytest.mark.parametrize('change', [
    {'field': 'not_in_catalog'}, {'source_text': '不存在于用户原文'},
    {'provenance': 'model-chosen'}, {'extra': 'not_allowed'},
])
def test_canonical_parser_rejects_malformed_host_requirement(change):
    query = '必须核对对话原文'
    ctx = context(query)
    item = {'field': 'source.raw_dialogue', 'source_text': query, 'provenance': 'host-explicit-raw-request-v1'}
    ctx['canonical_fixed_context']['explicit_source_requirements'] = [{**item, **change}]
    with pytest.raises(ProtocolError):
        parse_fixed_query(interpretation(), query, ctx)


def test_actual_runtime_legacy_fixed_branch_keeps_its_source_protocol(make_runtime):
    query = '必须核对对话原文'
    ctx = context(query)
    del ctx['canonical_fixed_context']
    ctx['evidence_fields'] = [{'key': 'source.raw_dialogue', 'origin': 'source', 'availability': 'available'}]
    rt = make_runtime(lambda _payload, _request: {**interpretation(), 'require_source': True,
                                                 'required_fields': ['source.raw_dialogue']})
    plan = asyncio.run(plan_query(rt, query, json.dumps(ctx, ensure_ascii=False)))
    assert rt.model.calls == 1
    assert plan['steps'][0]['params'] == {'require_source': True, 'required_fields': ['source.raw_dialogue']}


@pytest.mark.parametrize('field', [
    {'key': 'region', 'origin': 'generated', 'availability': 'available', 'operations': ['eq']},
    {'key': 'region', 'origin': 'source', 'availability': 'unavailable', 'operations': ['eq']},
    {'key': 'region', 'origin': 'source', 'availability': 'available', 'operations': ['contains']},
])
def test_structured_conditions_still_require_available_source_and_operation(field):
    query = '找北京设备故障'
    value = interpretation()
    value['structured_conditions'] = [{'field': 'region', 'op': 'eq', 'value': '北京', 'source_text': '北京'}]
    with pytest.raises(ProtocolError):
        parse_fixed_query(value, query, context(query, search_fields=[field]))


def test_real_source_metadata_condition_with_exact_user_quote_is_preserved():
    query = '找北京设备故障'
    value = interpretation()
    value['structured_conditions'] = [{'field': 'region', 'op': 'eq', 'value': '北京', 'source_text': '北京'}]
    field = {'key': 'region', 'origin': 'source', 'availability': 'available', 'operations': ['eq']}
    plan = parse_fixed_query(value, query, context(query, search_fields=[field]))
    assert plan['structured_conditions'] == value['structured_conditions']


def test_authoritative_projection_policy_is_required_for_canonical_parser():
    wrong = context()
    wrong['canonical_fixed_context']['declared_projection'] = 'ticket-search-projection-v1'
    with pytest.raises(ProtocolError):
        parse_fixed_query(interpretation(), '设备故障', wrong)
