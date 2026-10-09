import asyncio
from dataclasses import replace
from caseweave_ops.filter import judge_batch
from caseweave_ops.types import Passage
from conftest import record, decisions


def records(n=8):
    return [replace(record(str(i)), passages=(Passage('s', 'summary', f'合成设备记录{i}', origin='generated'),)) for i in range(n)]


def test_actual_runtime_counts_two_rotations_once_per_ticket(make_runtime):
    requests = []
    def handler(payload, request):
        requests.append(payload)
        assert payload['decision_format'] == 'next_token_binary'
        return {'available': True, 'p_first': .9 if payload['rotation'] == 0 else .1, 'unavailable_reason': ''}
    rt = make_runtime(handler)
    rt.judge_mode = 'anyjev_l0'
    rt.judge_prior = 'batch'
    result = asyncio.run(judge_batch(rt, records(), '设备故障', require_source=False))
    assert all(d.label == 'accept' for d in result)
    assert rt.model.calls == rt.store.sampling_calls(rt.scope) == 16
    assert rt.judge_metrics['l0_records'] == 8
    assert {p['review_stage'] for p in requests} == {'initial'}
    assert all('分数未校准' in d.reason for d in result)


def test_raw_unavailable_explicitly_falls_back_to_one_compact_request(make_runtime):
    def handler(payload, request):
        if payload['decision_format'] == 'next_token_binary':
            return {'available': False, 'p_first': None, 'unavailable_reason': 'provider_missing_logprobs'}
        return decisions(payload, request, label='exclude')
    rt = make_runtime(handler)
    rt.judge_mode = 'anyjev_l0'
    result = asyncio.run(judge_batch(rt, records(), '设备故障', require_source=False))
    assert all(d.label == 'exclude' for d in result)
    assert rt.model.calls == 17 and rt.judge_metrics['compact_fallback_records'] == 8
    second = asyncio.run(judge_batch(rt, [replace(r, ref=r.ref+'new') for r in records()], '设备故障', require_source=False))
    assert all(d.label == 'exclude' for d in second)
    assert rt.model.calls == 18 and rt.judge_metrics['compact_fallback_records'] == 16


def test_l0_two_rotations_are_not_cut_off_by_old_request_limit(make_runtime):
    rt = make_runtime(lambda p, r: {'available': True, 'p_first': .9 if p['rotation']==0 else .1, 'unavailable_reason': ''})
    rt.judge_mode = 'anyjev_l0'
    for _ in range(127):
        rt.store.begin(rt.scope.task_id, rt.scope.key, 'sem_filter', {'input_revision': rt.scope.input_revision})
    result = asyncio.run(judge_batch(rt, records(1), '设备故障', require_source=False))
    assert rt.model.calls == 2 and rt.store.sampling_calls(rt.scope) == 129
    assert result[0].label == 'accept' and result[0].error is None


def test_parallel_batches_share_six_content_free_probes(make_runtime):
    requests = []
    def handler(payload, request):
        requests.append(payload)
        return {'available': True, 'p_first': .5 if 'calibration_state' in payload else (.1 if payload['rotation'] == 0 else .9), 'unavailable_reason': ''}
    rt = make_runtime(handler)
    rt.judge_mode = 'anyjev_l0'
    rt.judge_prior = 'content_free'
    async def run():
        return await asyncio.gather(*(judge_batch(rt, records(1), '设备故障', require_source=False) for _ in range(4)))
    outcomes = asyncio.run(run())
    assert all(batch[0].label == 'exclude' for batch in outcomes)
    assert len([p for p in requests if 'calibration_state' in p]) == 6
