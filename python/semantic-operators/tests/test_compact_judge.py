"""Compact production decision contract; fixtures are synthetic, no model network."""
import asyncio
from dataclasses import replace
from caseweave_ops.filter import judge_batch
from caseweave_ops.types import Passage
from conftest import record, decisions


def test_compact_binary_keeps_actual_evidence_without_second_review(make_runtime):
    requests = []
    def handler(payload, request):
        requests.append((payload, request))
        schema = request['schema']['properties']['rows']['items']
        assert schema['required'] == ['ref', 'label', 'confidence']
        assert schema['additionalProperties'] is False
        assert '真实来源引文' not in request['messages'][0]['content']
        return decisions(payload, request)
    rt = make_runtime(handler)
    row = replace(record('canonical'), passages=(
        Passage('title', 'title', '设备故障', origin='generated'),
        Passage('summary', 'summary', '用户报告路由器频繁掉线。', origin='generated')))
    output = asyncio.run(judge_batch(rt, [row], '设备故障', require_source=False))
    assert output[0].label == 'accept' and output[0].confidence == 1
    assert [(c.field, c.quote, c.origin) for c in output[0].citations] == [
        ('title', '设备故障', 'generated'), ('summary', '用户报告路由器频繁掉线。', 'generated')]
    assert rt.model.calls == 1
    assert [p['review_stage'] for p, _ in requests] == ['initial']
    assert all('citations' not in r['schema']['properties']['rows']['items']['properties'] for _, r in requests)


def test_compact_negative_needs_one_call_and_cache_does_not_consume_budget(make_runtime):
    rt = make_runtime(lambda p, r: decisions(p, r, label='exclude'))
    row = replace(record('negative'), passages=(Passage('s', 'summary', '无设备故障', origin='generated'),))
    first = asyncio.run(judge_batch(rt, [row], '设备故障', require_source=False))
    second = asyncio.run(judge_batch(rt, [row], '设备故障', require_source=False))
    assert first[0].label == second[0].label == 'exclude'
    assert rt.model.calls == 1 and second[0].basis == 'reused_model'
    assert rt.store.sampling_calls(rt.scope) == 1


def test_explicit_required_fields_keep_model_selected_source_quotes(make_runtime):
    rt = make_runtime()
    result = asyncio.run(judge_batch(rt, [record()], '解绑失败',
        require_source=False, required_fields=('source.raw_dialogue',)))
    assert result[0].label == 'accept' and result[0].citations[0].field == 'source.raw_dialogue'
    assert 'citations' in rt.store.request(result[0].manifest_id)['schema']['properties']['rows']['items']['properties']


def test_production_compact_source_requirements_do_not_restore_verbose_protocol(make_runtime):
    rt = make_runtime()
    rt.judge_mode = 'compact_binary'
    result = asyncio.run(judge_batch(rt, [record()], '解绑失败',
        require_source=True, required_fields=('source.raw_dialogue',)))
    assert result[0].label == 'accept'
    assert all(c.origin == 'source' for c in result[0].citations)
    request = rt.store.request(result[0].manifest_id)
    assert request['schema']['properties']['rows']['items']['required'] == ['ref', 'label', 'confidence']
