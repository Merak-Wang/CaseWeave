"""Algorithm mechanisms with independent synthetic oracle; never business Gold."""
import asyncio
from dataclasses import replace
import json
import numpy as np
import pytest
from caseweave_ops.cluster import cluster_filter, FilterOptions, remaining_error_upper
from caseweave_ops.dispatch import invoke_rows
from caseweave_ops.feedback import FeedbackSet
from caseweave_ops.filter import sem_filter, judge_batch
from conftest import record, source, collect, decisions


def fixture(kind, n=1024, seed=0):
    rng = np.random.default_rng(seed)
    y = np.arange(n) % 2
    if kind == 'rare':
        y = np.zeros(n, dtype=int); y[-1] = 1
    if kind == 'multimodal':
        groups = np.arange(n) % 4
        y = (groups % 2 == 0).astype(int)
        X = np.eye(4)[groups] + rng.normal(0, .01, (n, 4))
    elif kind in {'identical', 'rare', 'unknown'}:
        X = np.ones((n, 2))
    else:
        X = np.eye(2)[y] + rng.normal(0, .02, (n, 2))
        if kind == 'mixed': y = rng.integers(0, 2, n)
    if kind == 'unknown': y[:] = -1
    return X / np.linalg.norm(X, axis=1, keepdims=True), y


async def kernel_run(X, y, **kwargs):
    asked = []
    async def judge(ids, phase):
        for start in range(0, len(ids), 8):
            part = ids[start:start+8]
            asked.extend(part.tolist())
            yield part, y[part]
    events = [e async for e in cluster_filter(X, judge, **kwargs)]
    return events, asked


@pytest.mark.parametrize('kind', ['separable', 'mixed', 'identical', 'rare', 'multimodal', 'unknown'])
@pytest.mark.parametrize('seed', [0, 7, 19])
def test_strict_defaults_close_input_and_preserve_subgroups(kind, seed):
    X, y = fixture(kind, seed=seed)
    events, asked = asyncio.run(kernel_run(X, y, options=FilterOptions(seed=seed)))
    out = np.full(len(y), -2)
    inferred = []
    for ids, values, basis, _ in events:
        if basis != 'observation': out[ids] = values
        if basis == 'proxy': inferred.extend(ids)
    assert len(asked) == len(set(asked))
    assert not set(asked).intersection(inferred)
    assert np.array_equal(out, y)
    if kind == 'unknown': assert len(asked) == len(y) and not inferred


def test_fit_predict_and_independent_holdout_actually_skip_calls():
    X, y = fixture('separable', n=4096)
    events, asked = asyncio.run(kernel_run(X, y, options=FilterOptions(
        clusters=1, proposal='linear', pilot_size=100, accept_error=.01, reject_error=.01)))
    assert any(e[3].get('model_fits') == 1 for e in events)
    proxies = {int(i) for ids, _, basis, _ in events if basis == 'proxy' for i in ids}
    assert len(proxies) > len(y) // 2
    assert not proxies.intersection(asked)
    for ids, values, basis, _ in events:
        if basis != 'observation': assert np.array_equal(values, y[ids])


def test_known_counterexample_is_never_overwritten():
    X, y = fixture('separable', n=1024)
    y[3] = 1 - y[3]
    events, asked = asyncio.run(kernel_run(X, y, known={3: int(y[3])}, options=FilterOptions(accept_error=.01)))
    assert 3 not in asked
    assert all(3 not in ids for ids, _, basis, _ in events if basis != 'observation')


def test_public_dispatch_reduces_actual_strong_rows_and_streams_first(make_runtime):
    X, labels = fixture('separable', n=2048)
    requests = []
    def model(payload, request):
        requests.append([r['ref'] for r in payload['records']])
        return {'rows': [decisions({'records': [r]}, request, 'accept' if labels[int(r['ref'])] else 'exclude')['rows'][0]
                         for r in payload['records']]}
    rows = [record(str(i), vector=x) for i, x in enumerate(X)]
    rt = make_runtime(model)
    consumed = []
    async def records():
        for row in [*rows, *rows[:20]]:
            consumed.append(row.ref)
            yield row
    async def run():
        stream = invoke_rows('sem_filter', rt, records(), 'x', {'options': {'accept_error': .01, 'reject_error': .01}})
        first = await anext(stream)
        assert len(consumed) == 8
        return [first, *[v async for v in stream]]
    out = asyncio.run(run())
    strong = {r for group in requests for r in group}
    proxy = {v['value']['ref'] for v in out if v['value']['basis'] == 'proxy'}
    assert proxy and not proxy.intersection(strong)
    assert len(out) == len(rows) == len(strong | proxy)
    assert all(v['value']['manifest_id'] is None for v in out if v['value']['basis'] == 'proxy')
    assert len(strong) < len(rows)


def test_recovery_feedback_unknown_repair_and_predicate_change(make_runtime):
    rt = make_runtime()
    rows = [record(str(i)) for i in range(32)]
    asyncio.run(collect(sem_filter(rt, source(rows), 'x')))
    previous = rt.model.calls
    fb = FeedbackSet(rt.predicate_key('x'))
    replay = asyncio.run(collect(sem_filter(rt, source(rows), 'x', feedback=fb, replay_saved=True)))
    assert len(replay) == len(rows) == len(fb.samples) and rt.model.calls == previous
    fb.observe(rows[0], replace(replay[0], label='undetermined', basis='unresolved'))
    assert rows[0].ref not in fb.samples
    rt.scope.input_revision += 1
    asyncio.run(collect(sem_filter(rt, source(rows), 'opposite predicate')))
    assert rt.model.calls > previous


def test_invalid_response_is_not_cached_and_unknown_is_repairable(make_runtime):
    def model(payload, request):
        out = decisions(payload, request)
        if rt.model.calls == 1: out['rows'][0]['citations'][0]['quote'] = 'not in source'
        return out
    rt = make_runtime(model)
    first = asyncio.run(collect(sem_filter(rt, source([record()]), 'x')))
    second = asyncio.run(collect(sem_filter(rt, source([record()]), 'x')))
    assert first[0].label == 'undetermined'
    assert second[0].label == 'accept' and rt.model.calls == 2


def test_zero_tolerance_requires_nearly_all_rows():
    assert remaining_error_upper(1000, 12, 0, .01) > 0
    from caseweave_ops.cluster import check_size
    assert check_size(1000, 0, .01) >= 990


def test_retracted_feedback_does_not_return_from_response_cache(make_runtime):
    rt = make_runtime()
    fb = FeedbackSet(rt.predicate_key('x'))
    row = record()
    asyncio.run(collect(sem_filter(rt, source([row]), 'x', feedback=fb)))
    fb.revoke(row.ref)
    rt.model.handler = lambda p, r: decisions(p, r, 'exclude')
    repaired = asyncio.run(collect(sem_filter(rt, source([row]), 'x', feedback=fb)))
    assert repaired[0].label == 'exclude' and rt.model.calls == 2
    # Restart with no in-memory feedback and recover the corrected strong label.
    again = asyncio.run(collect(sem_filter(rt, source([row]), 'x', replay_saved=True)))
    assert again[0].label == 'exclude' and rt.model.calls == 2


def test_host_strong_correction_overrides_old_operator_label(make_runtime):
    rt = make_runtime()
    row = record()
    asyncio.run(collect(sem_filter(rt, source([row]), 'x')))
    # A later real main/expert judgment is already in the authoritative state.
    events = asyncio.run(collect(invoke_rows('sem_filter', rt, source([row]), 'x',
        {'host_labels': {row.ref: 0}, 'replay_saved': True})))
    assert events == [] and rt.model.calls == 1
    rt.model.handler = lambda p, r: decisions(p, r, 'exclude')
    # A retraction forces a new strong decision, even with a matching old batch.
    events = asyncio.run(collect(invoke_rows('sem_filter', rt, source([row]), 'x',
        {'host_labels': {row.ref: -1}})))
    assert events[0]['value']['label'] == 'exclude' and rt.model.calls == 2
