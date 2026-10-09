"""Frozen teacher fixtures use authorized numeric scope and explicit synthetic models."""
import asyncio
import numpy as np
import pytest
from caseweave_ops import invoke_rows
from caseweave_ops.runtime import ModelRequestError
from caseweave_ops.types import ProtocolError
from conftest import record, source, collect
from test_learning_sets import numeric_port


def forbid_fitting(monkeypatch):
    def fail(*args, **kwargs): raise AssertionError('Frozen teacher must not fit, vote or cluster')
    for target in ('caseweave_ops.models._fit', 'caseweave_ops.baseline.partition',
                   'caseweave_ops.baseline.vote', 'caseweave_ops.baseline.cluster_filter'):
        monkeypatch.setattr(target, fail)


@pytest.mark.parametrize('algorithm', ['direct', 'direct_teacher'])
def test_frozen_teacher_uses_whole_scope_including_missing_features_and_unknown(make_runtime, monkeypatch, algorithm):
    forbid_fitting(monkeypatch)
    y = (np.arange(257) % 2).astype(np.int8); y[5] = -1
    rt = make_runtime()
    updates, predictions, reads = numeric_port(rt, np.ones((257, 2), dtype=np.float32), y, missing=[250])
    events = asyncio.run(collect(invoke_rows('sem_filter', rt, source([record('front-page-only')]), 'synthetic predicate', {
        'algorithm': algorithm, 'scope_mode': 'full', 'online_feedback_training': False,
        'batch_size': 2, 'recall_scope_key': 'synthetic-full-union',
        'options': {'block_size': 32, 'proposal': 'linear', 'accept_error': .99}})))
    values = [event['value'] for event in events]
    assert reads == list(range(len(reads))) and len(values) == 257 and not predictions
    assert {value['ref'] for value in values} == {str(i) for i in range(len(values))}
    unknown = next(value for value in values if value['ref'] == '5')
    assert unknown['label'] == 'undetermined' and unknown['confidence'] is None
    assert rt.model.calls == 129
    last = updates[-1]
    assert last['stop_reason'] == 'error' and last['completion_basis'] == 'input_enumeration'
    assert last['undetermined_records'] == 1  # 遍历完成仍保留真实技术缺项，不补为no。
    assert last['scope_records'] == last['teacher_unique_records'] == len(values)
    # 此替身没有population_count；未枚举尾部不能宣称已知全集数量。
    assert last['corpus_records'] == len(reads)
    assert last['fit_count'] == 0 and last['online_feedback_training'] is False
    assert last['regime'] == 'frozen_teacher' and last['unresolved'] >= 1
    assert last['complete_scope_coverage'] is True
    assert last['positive_records'] + last['negative_records'] + last['undetermined_records'] == len(values)
    assert 'quality' not in last and 'selected_model' not in last


@pytest.mark.parametrize('algorithm', ['auto', 'active', 'learned'])
def test_false_feedback_flag_cannot_enter_learned_fit(make_runtime, monkeypatch, algorithm):
    forbid_fitting(monkeypatch)
    rt = make_runtime()
    updates, _, _ = numeric_port(rt, np.ones((3, 2), dtype=np.float32), np.zeros(3, dtype=np.int8))
    asyncio.run(collect(invoke_rows('sem_filter', rt, source([]), 'q', {
        'online_feedback_training': False, 'algorithm': algorithm, 'scope_mode': 'full'})))
    assert updates[-1]['regime'] == 'frozen_teacher'
    with pytest.raises(ProtocolError, match='must be boolean'):
        asyncio.run(collect(invoke_rows('sem_filter', rt, source([]), 'q', {'online_feedback_training': 'false'})))


def test_frozen_cancellation_never_reports_completed(make_runtime):
    rt = make_runtime()
    updates, _, _ = numeric_port(rt, np.ones((4, 2), dtype=np.float32), np.zeros(4, dtype=np.int8))
    async def cancelled(payload, request):
        rt.scope.cancelled.set()
        await asyncio.sleep(0)
    rt.model.handler = cancelled
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(collect(invoke_rows('sem_filter', rt, source([]), 'q', {'algorithm': 'direct'})))
    assert all(update['stop_reason'] != 'frozen_completed' for update in updates)
    assert rt.store.metrics(rt.scope.task_id)['running'] == 0


def test_frozen_transport_retry_keeps_attempt_receipts(make_runtime):
    rt = make_runtime()
    updates, _, _ = numeric_port(rt, np.ones((1, 2), dtype=np.float32), np.zeros(1, dtype=np.int8))
    teacher, calls = rt.model.handler, 0
    def retry(payload, request):
        nonlocal calls
        calls += 1
        if calls == 1: raise ModelRequestError('TRANSPORT', 'synthetic temporary failure', True)
        return teacher(payload, request)
    rt.model.handler = retry
    events = asyncio.run(collect(invoke_rows('sem_filter', rt, source([]), 'q', {'algorithm': 'direct'})))
    assert events[0]['value']['label'] == 'exclude'
    metrics = rt.store.metrics(rt.scope.task_id)
    assert metrics['llm_adapter_calls'] == 2 and metrics['failed_attempts'] == 1
    assert updates[-1]['sampling_requests'] == 1 and updates[-1]['fit_count'] == 0


def test_frozen_rejects_changed_population_instead_of_completing(make_runtime):
    rt = make_runtime()
    updates, _, _ = numeric_port(rt, np.ones((3, 2), dtype=np.float32), np.zeros(3, dtype=np.int8))
    port = rt.resources
    async def changed(method, payload):
        value = await port(method, payload)
        if method == 'features.scan': value['population_count'] = 4
        return value
    rt.resources = changed
    with pytest.raises(ValueError, match='population cardinality changed'):
        asyncio.run(collect(invoke_rows('sem_filter', rt, source([]), 'q', {'algorithm': 'direct'})))
    assert all(update['stop_reason'] != 'frozen_completed' for update in updates)


@pytest.mark.parametrize('bad_source', ['missing_row', 'duplicate_ref', 'duplicate_numeric_id'])
def test_frozen_source_inconsistency_cannot_claim_complete_coverage(make_runtime, bad_source):
    rt = make_runtime()
    updates, _, _ = numeric_port(rt, np.ones((3, 2), dtype=np.float32), np.zeros(3, dtype=np.int8))
    port = rt.resources
    async def broken(method, payload):
        value = await port(method, payload)
        if method == 'features.scan' and bad_source == 'duplicate_numeric_id':
            value['ids'][1] = value['ids'][0]
        if method == 'rows.read':
            if bad_source == 'missing_row': value['rows'].pop()
            elif bad_source == 'duplicate_ref': value['rows'][1] = value['rows'][0]
        return value
    rt.resources = broken
    with pytest.raises((ValueError, ProtocolError)):
        asyncio.run(collect(invoke_rows('sem_filter', rt, source([]), 'q', {'algorithm': 'direct'})))
    assert all(update['stop_reason'] != 'frozen_completed' and not update['complete_scope_coverage'] for update in updates)


@pytest.mark.parametrize("method", ["dual_description_margin", "name_gmm", "kmeans"])
@pytest.mark.parametrize("truncation", [{"scope_mode": "candidates"}, {"scope_mode": "full", "example_count": 1}])
def test_public_unlabeled_scope_cannot_silently_truncate_or_fall_back_to_teacher(make_runtime, method, truncation):
    rt = make_runtime()
    with pytest.raises(ProtocolError, match="complete recall scope"):
        asyncio.run(collect(invoke_rows("sem_filter", rt, source([]), "synthetic", {
            "algorithm": method, "online_feedback_training": False,
            "recall_scope_key": "synthetic-full-pool", **truncation})))
    assert rt.model.calls == 0
