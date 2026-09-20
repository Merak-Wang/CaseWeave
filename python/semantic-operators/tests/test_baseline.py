"""显式旧 baseline 与小范围参照，合成标签不代表业务 Gold。"""
import asyncio
import json
import math
from dataclasses import replace
import numpy as np
import pytest
from caseweave_ops import invoke_rows
from caseweave_ops.baseline import FilterOptions, check_size, cluster_filter, remaining_error_upper, vote
from caseweave_ops.filter import judge_batch, sem_filter
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


def test_one_percent_regional_error_can_miss_every_rare_positive():
    n = 16384
    rng = np.random.default_rng(0)
    rng.normal(0, .05, (n, 4))
    X, y = np.ones((n, 4)) / 2, np.zeros(n, dtype=int)
    y[rng.choice(n, 32, replace=False)] = 1
    known = {i: int(y[i]) for i in range(8)}
    events, asked = asyncio.run(kernel_run(X, y, known=known, options=FilterOptions(
        clusters=1, pilot_size=64, proposal='linear', accept_error=.01, reject_error=.01)))
    predicted = np.full(n, -2)
    predicted[:8] = y[:8]
    for ids, values, basis, detail in events:
        if basis != 'observation': predicted[ids] = values
    assert len(asked) + len(known) == 600
    assert sum(e[3].get('model_fits', 0) for e in events) == 0
    assert np.count_nonzero((y == 1) & (predicted == 1)) == 0
    assert np.mean(predicted != y) < .01
    strict, _ = asyncio.run(kernel_run(X, y))
    for ids, values, basis, _ in strict:
        if basis != 'observation': assert np.array_equal(values, y[ids])


def test_strict_run_does_not_reuse_saved_proxy(make_runtime):
    from dataclasses import asdict
    from caseweave_ops import Decision
    rt = make_runtime(lambda p, r: decisions(p, r, 'accept'))
    row = record('review-cache')
    key = rt.predicate_key('x')
    progress = 'sem_filter:' + key + ':source:fields:'
    rt.store.save(rt.scope.key, progress, row.observation_key,
        asdict(Decision(row.ref, row.identity, key, 'exclude', basis='proxy')))
    events = asyncio.run(collect(invoke_rows('sem_filter', rt, source([row]), 'x', {'replay_saved': True, 'algorithm': 'baseline'})))
    assert events[0]['value']['label'] == 'accept'
    assert events[0]['value']['basis'] == 'model'
    assert rt.model.calls == 2


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
        stream = invoke_rows('sem_filter', rt, records(), 'x', {'algorithm': 'baseline', 'options': {'accept_error': .01, 'reject_error': .01}})
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
    asyncio.run(collect(sem_filter(rt, source(rows), 'x', scope_mode="candidates")))
    previous = rt.model.calls
    replay = asyncio.run(collect(sem_filter(rt, source(rows), 'x', replay_saved=True, scope_mode="candidates")))
    assert len(replay) == len(rows) and rt.model.calls == previous
    rt.scope.input_revision += 1
    asyncio.run(collect(sem_filter(rt, source(rows), 'opposite predicate', scope_mode="candidates")))
    assert rt.model.calls > previous


def test_invalid_response_is_not_cached_and_unknown_is_repairable(make_runtime):
    def model(payload, request):
        out = decisions(payload, request)
        if rt.model.calls == 1: out['rows'][0]['citations'][0]['quote'] = 'not in source'
        return out
    rt = make_runtime(model)
    first = asyncio.run(collect(sem_filter(rt, source([record()]), 'x', scope_mode="candidates")))
    second = asyncio.run(collect(sem_filter(rt, source([record()]), 'x', scope_mode="candidates")))
    assert first[0].label == 'undetermined'
    assert second[0].label == 'accept' and rt.model.calls == 3


def test_zero_tolerance_requires_nearly_all_rows():
    assert remaining_error_upper(1000, 12, 0, .01) > 0
    from caseweave_ops.baseline import check_size
    assert check_size(1000, 0, .01) >= 990


def test_retracted_feedback_does_not_return_from_response_cache(make_runtime):
    rt = make_runtime()
    row = record()
    asyncio.run(collect(sem_filter(rt, source([row]), 'x', scope_mode="candidates")))
    rt.model.handler = lambda p, r: decisions(p, r, 'exclude')
    repaired = asyncio.run(collect(sem_filter(rt, source([row]), 'x', host_labels={row.ref: -1}, scope_mode="candidates")))
    assert repaired[0].label == 'exclude' and rt.model.calls == 3
    # Restart with no in-memory feedback and recover the corrected strong label.
    again = asyncio.run(collect(sem_filter(rt, source([row]), 'x', replay_saved=True, scope_mode="candidates")))
    assert again[0].label == 'exclude' and rt.model.calls == 3


def test_host_strong_correction_overrides_old_operator_label(make_runtime):
    rt = make_runtime()
    row = record()
    asyncio.run(collect(sem_filter(rt, source([row]), 'x', scope_mode="candidates")))
    # A later real main/expert judgment is already in the authoritative state.
    events = asyncio.run(collect(invoke_rows('sem_filter', rt, source([row]), 'x',
        {'scope_mode': 'candidates', 'host_labels': {row.ref: 0}, 'replay_saved': True})))
    assert events == [] and rt.model.calls == 2
    rt.model.handler = lambda p, r: decisions(p, r, 'exclude')
    # A retraction forces a new strong decision, even with a matching old batch.
    events = asyncio.run(collect(invoke_rows('sem_filter', rt, source([row]), 'x',
        {'scope_mode': 'candidates', 'host_labels': {row.ref: -1}})))
    assert events[0]['value']['label'] == 'exclude' and rt.model.calls == 3


@pytest.mark.parametrize('total,tolerance,alpha,expected', [
    (1175, .01, .005, 767), (24, .4, .005, 19), (1000, 0, .005, 996),
])
def test_sample_size_finds_first_feasible_step(total, tolerance, alpha, expected):
    assert check_size(total, tolerance, alpha) == expected
    assert remaining_error_upper(total, expected, 0, alpha) <= tolerance * (total - expected)


def test_strict_and_already_known_inputs_do_not_cluster(monkeypatch):
    def unnecessary(*args, **kwargs):
        pytest.fail('No feature fitting is needed for this input')
    monkeypatch.setattr('caseweave_ops.baseline.partition', unnecessary)
    X, y = fixture('separable', n=32)
    events, asked = asyncio.run(kernel_run(X, y))
    assert asked == list(range(32))
    assert all(basis == 'reference' for _, _, basis, _ in events)
    events, asked = asyncio.run(kernel_run(X, y, known=dict(enumerate(y)),
        options=FilterOptions(accept_error=.01, reject_error=.01)))
    assert not events and not asked


def test_child_regions_reuse_parent_strong_labels():
    X, y = fixture('mixed', n=512)
    events, asked = asyncio.run(kernel_run(X, y, options=FilterOptions(
        clusters=1, validation_size=8)))
    trained = [detail['training'] for _, _, basis, detail in events
               if basis == 'observation' and detail['phase'] == 'prediction']
    assert len(trained) > 1 and max(map(len, trained[1:])) > 12
    assert len(asked) == len(set(asked))
    assert all(np.array_equal(values, y[ids]) for ids, values, basis, _ in events
               if basis != 'observation')


def test_strict_filter_streams_next_batch_and_stops_at_example_target(make_runtime, monkeypatch):
    def unnecessary(*args, **kwargs):
        pytest.fail('Strict streaming does not spool features')
    monkeypatch.setattr('caseweave_ops.baseline.FeatureSpool', unnecessary)
    consumed = []
    async def rows():
        for i in range(1024):
            consumed.append(i)
            yield record(str(i))
    def model(payload, request):
        return decisions(payload, request, 'exclude' if rt.model.calls == 1 else 'accept')
    rt = make_runtime(model)
    result = asyncio.run(collect(sem_filter(rt, rows(), 'x', stop_after_accepted=2, scope_mode="candidates")))
    assert len(consumed) == 16 and len(result) == 16 and rt.model.calls == 3
    assert sum(r.label == 'accept' for r in result) == 8


def test_missing_required_source_is_not_sent_to_model(make_runtime):
    missing = replace(record('missing'), passages=(replace(record().passages[0], field='summary'),))
    good = record('ready')
    rt = make_runtime()
    out = asyncio.run(judge_batch(rt, [missing, good], 'x', required_fields=('source.raw_dialogue',)))
    assert [d.label for d in out] == ['undetermined', 'accept']
    assert out[0].manifest_id is None and rt.model.calls == 2
    requests = rt.store.db.execute('SELECT request_json FROM calls').fetchall()
    assert len(requests) == 2 and all('missing' not in request[0] for request in requests)
    before = rt.model.calls
    asyncio.run(judge_batch(rt, [missing], 'x', required_fields=('source.raw_dialogue',)))
    assert rt.model.calls == before


def test_simvote_matches_pairwise_near_antipodal_and_thresholds():
    rng = np.random.default_rng(4)
    X = rng.normal(size=(200, 12)); X /= np.linalg.norm(X, axis=1, keepdims=True)
    X[100:110] = -X[0] + rng.normal(0, 1e-8, (10,12)); X /= np.linalg.norm(X, axis=1, keepdims=True)
    labels = rng.integers(0,2,len(X))
    for train in (np.arange(80), np.array([0,0,0,1])):
        target = np.arange(80,200)
        weights = np.maximum(0,(X[target] @ X[train].T+1)/2)
        expected = np.divide(weights @ labels[train],weights.sum(1),out=np.full(len(target),labels[train].mean()),where=weights.sum(1)>1e-12)
        actual,_ = vote(X,train,target,labels,'similarity',17)
        np.testing.assert_allclose(actual,expected,atol=1e-10)
        np.testing.assert_array_equal(actual>=.5,expected>=.5)


def test_query_vectors_do_not_remove_strong_judgments(make_runtime):
    rows = [record(str(i), vector=(1, i / 24)) for i in range(24)]
    requests = []
    def model(payload, request):
        requests.append(tuple(r['ref'] for r in payload['records']))
        return decisions(payload, request)
    async def run(params):
        rt = make_runtime(model)
        return [v async for v in invoke_rows('sem_filter', rt, source(rows), 'x', {'algorithm': 'baseline', **params})]
    plain = asyncio.run(run({}))
    plain_requests = requests[:]
    requests.clear()
    scored = asyncio.run(run({'queries': [[1, 0]], 'embedding_id': 'synthetic-test-space'}))
    assert len(plain) == len(scored) == 24
    assert len(plain_requests) == len(requests) == 6
    assert {r for batch in requests for r in batch} == {r.ref for r in rows}
    assert {frozenset(b) for b in requests} == {frozenset(b) for b in plain_requests}
