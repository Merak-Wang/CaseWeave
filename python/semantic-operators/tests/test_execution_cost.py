"""Execution-cost regressions with deterministic labels, not business quality claims."""
import asyncio
from dataclasses import replace
import math
import numpy as np
import pytest
from caseweave_ops.cluster import FilterOptions, check_size, cluster_filter, remaining_error_upper
from caseweave_ops.filter import judge_batch, sem_filter
from caseweave_ops.topk import sem_topk
from conftest import collect, decisions, record, source
from test_cluster_filter import fixture, kernel_run


@pytest.mark.parametrize('total,tolerance,alpha,expected', [
    (1175, .01, .005, 767), (24, .4, .005, 19), (1000, 0, .005, 996),
])
def test_sample_size_finds_first_feasible_step(total, tolerance, alpha, expected):
    assert check_size(total, tolerance, alpha) == expected
    assert remaining_error_upper(total, expected, 0, alpha) <= tolerance * (total - expected)


def test_strict_and_already_known_inputs_do_not_cluster(monkeypatch):
    def unnecessary(*args, **kwargs):
        pytest.fail('No feature fitting is needed for this input')
    monkeypatch.setattr('caseweave_ops.cluster.partition', unnecessary)
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
    monkeypatch.setattr('caseweave_ops.filter_adapter.FeatureSpool', unnecessary)
    consumed = []
    async def rows():
        for i in range(1024):
            consumed.append(i)
            yield record(str(i))
    def model(payload, request):
        return decisions(payload, request, 'exclude' if rt.model.calls == 1 else 'accept')
    rt = make_runtime(model)
    result = asyncio.run(collect(sem_filter(rt, rows(), 'x', stop_after_accepted=2)))
    assert len(consumed) == 16 and len(result) == 16 and rt.model.calls == 2
    assert sum(r.label == 'accept' for r in result) == 8


def test_missing_required_source_is_not_sent_to_model(make_runtime):
    missing = replace(record('missing'), passages=(replace(record().passages[0], field='summary'),))
    good = record('ready')
    rt = make_runtime()
    out = asyncio.run(judge_batch(rt, [missing, good], 'x', required_fields=('source.raw_dialogue',)))
    assert [d.label for d in out] == ['undetermined', 'accept']
    assert out[0].manifest_id is None and rt.model.calls == 1
    requests = rt.store.db.execute('SELECT request_json FROM calls').fetchall()
    assert len(requests) == 1 and 'missing' not in requests[0][0]
    before = rt.model.calls
    asyncio.run(judge_batch(rt, [missing], 'x', required_fields=('source.raw_dialogue',)))
    assert rt.model.calls == before


@pytest.mark.parametrize('strategy', ['heap', 'quick'])
def test_topk_final_sort_uses_n_log_n_comparisons(strategy):
    calls = 0
    async def compare(a, b):
        nonlocal calls
        calls += 1
        return -1 if int(a.ref) < int(b.ref) else 1
    n = 256
    out = asyncio.run(sem_topk(source([record(str(i)) for i in range(n)]), n, compare, strategy=strategy))
    assert [r.ref for r in out.records] == [str(i) for i in range(n)]
    assert calls < 3 * n * math.ceil(math.log2(n))
