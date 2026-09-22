"""仅受控合成质量，不把脚本标签称为中文业务 Gold 或真实 LLM。"""
import asyncio
import base64
import numpy as np
import pytest
from caseweave_ops import invoke_rows
from caseweave_ops.models import fit_models, operating_point
from caseweave_ops.quality import Region, quality_bounds, positive_bounds
from conftest import record, source, collect, decisions


def numeric_port(runtime, X, y, missing=(), scores=None):
    updates, emitted, samples = [], {}, []
    available = np.ones(len(X), dtype=np.uint8); available[list(missing)] = 0
    def block(ids, cursor=None):
        ids = np.array(ids, dtype=np.int64)
        return {"ids": ids.tolist(), "dense": base64.b64encode(np.asarray(X[ids], dtype='<f4').tobytes()).decode(),
            "dimensions": X.shape[1], "available": base64.b64encode(available[ids].tobytes()).decode(),
            "feature_id": "synthetic-v1", "next_cursor": cursor,
            **({"scores": np.asarray(scores)[ids].tolist()} if scores is not None else {})}
    async def call(method, p):
        if method == 'features.scan':
            start, width = int(p['cursor'] or 0), p['page_size']; end = min(len(X), start+width)
            return block(range(start, end), str(end) if end < len(X) else None)
        if method == 'features.take': return block(p['ids'])
        if method == 'features.seeds': return {'ids': [int(i) for i in p['refs']], 'feature_id': 'synthetic-v1'}
        if method == 'rows.read':
            samples.extend(p['ids'])
            return {'rows': [record(str(i), text=f'synthetic {int(y[i])}').model_payload() for i in p['ids']]}
        if method == 'learning.update': updates.append(p.copy())
        elif method == 'predictions.begin': emitted.clear()
        elif method == 'predictions.write': emitted.update(zip(p['ids'], p['labels']))
        elif method == 'predictions.finish': pass
        else: raise AssertionError(method)
        return {}
    def teacher(p, _):
        out = decisions(p)
        for r in out['rows']: r['label'] = {-1: 'undetermined', 0: 'exclude', 1: 'accept'}[int(y[int(r['ref'])])]
        return out
    runtime.resources = call; runtime.model.handler = teacher
    return updates, emitted, samples


def run(rt, **options):
    return asyncio.run(collect(invoke_rows('sem_filter', rt, source([]), 'synthetic predicate',
        {'options': {'pool_size': 1024, 'sample_size': 128, 'selection_size': 256, 'validation_size': 512, **options}})))


def test_default_fits_four_models_scores_full_scope_and_separates_training_selection_audit(make_runtime):
    y = np.arange(5000) % 2
    X = np.eye(2, dtype=np.float32)[y]
    rt = make_runtime(); updates, predicted, sampled = numeric_port(rt, X, y)
    run(rt)
    last = updates[-1]
    phases = [p['stop_reason'] for p in updates]
    assert phases.index('scanning') < phases.index('ranked_sampling') < phases.index('training')
    assert phases.index('training') < phases.index('selecting') < phases.index('predicting') < phases.index('auditing')
    assert updates[phases.index('ranked_sampling')]['sampling_method'] == 'ngram_vector_desc'
    assert updates[phases.index('auditing')]['sampling_method'] == 'ngram_vector_desc'
    assert updates[phases.index('auditing')]['audit_sampling_method'] == 'srs_without_replacement_per_frozen_region'
    assert len(updates[phases.index('training')]['candidate_models']) == 4
    assert updates[phases.index('predicting')]['selected_model']
    assert last['fit_count'] == 4 and last['predicted_records'] == len(X)
    assert last['positive_records'] > 0 and last['negative_records'] > 0 and last['undetermined_records'] == 0
    assert len(predicted) == len(X) and last['stop_reason'] == 'quality_passed'
    assert last['quality']['recall_lower'] >= .95
    assert {i for i, v in predicted.items() if v == 1} == set(np.flatnonzero(y))
    assert len(sampled) < len(X)
    t, v, a = map(lambda k: set(last[k]), ('training_ids', 'selection_ids', 'audit_ids'))
    assert not t & v and not t & a and not v & a


def test_batch_width_changes_neither_samples_nor_set(make_runtime):
    y = np.arange(4000) % 2; X = np.eye(2, dtype=np.float32)[y]
    outputs = []
    for width in (57, 16384):
        rt = make_runtime(); updates, output, samples = numeric_port(rt, X, y)
        run(rt, block_size=width); outputs.append((output, set(samples), updates[-1]['quality']))
    assert outputs[0] == outputs[1]


@pytest.mark.parametrize('concurrency,batch_size', [(32, 4), (32, 1), (128, 1)])
def test_runs_sample_batches_concurrently(make_runtime, concurrency, batch_size):
    async def execute():
        width = concurrency * batch_size
        y = np.zeros(width*2, dtype=np.int8)
        rt = make_runtime()
        updates, _, samples = numeric_port(rt, np.eye(2, dtype=np.float32)[y], y)
        teacher = rt.model.handler
        port, read_sizes = rt.resources, []
        async def batched_port(method, payload):
            if method == 'rows.read':
                read_sizes.append(len(payload['ids']))
            return await port(method, payload)
        rt.resources = batched_port
        release = asyncio.Event()
        active, peak, started = 0, 0, 0
        async def parallel_teacher(payload, request):
            nonlocal active, peak, started
            assert 1 <= len(payload['records']) <= batch_size
            active += 1; started += 1; peak = max(peak, active)
            if started == concurrency:
                release.set()
            await asyncio.wait_for(release.wait(), timeout=5)
            try:
                return teacher(payload, request)
            finally:
                active -= 1
        rt.model.handler = parallel_teacher
        await collect(invoke_rows('sem_filter', rt, source([]), 'synthetic predicate',
            {'batch_size': batch_size, 'options': {'concurrency': concurrency, 'sample_size': width,
                'pool_size': width*2, 'selection_size': 1, 'validation_size': 1,
                'precision_target': .9, 'recall_target': .9}}))
        assert peak == concurrency
        assert read_sizes == [width, width]
        assert updates[-1]['batch_size'] == batch_size and updates[-1]['concurrency'] == concurrency
        assert updates[-1]['precision_target'] == .9 and updates[-1]['recall_target'] == .9
        assert len(set(samples)) == width*2
    asyncio.run(execute())


def test_selection_resume_keeps_models_and_holdout_after_store_reopen(make_runtime, tmp_path):
    from caseweave_ops import ArtifactStore
    y = np.zeros(5000, dtype=np.int8); y[42] = 1
    rt = make_runtime(); updates, _, samples = numeric_port(rt, np.eye(2, dtype=np.float32)[y], y)
    port, scans = rt.resources, []
    async def call(method, p):
        if method == 'features.seeds':
            return {'ids': [42], 'known_labels': {'42': 1}, 'feature_id': 'synthetic-v1'}
        if method == 'features.scan': scans.append(p)
        return await port(method, p)
    rt.resources = call
    run(rt)
    first = updates[-1]
    assert first['stop_reason'] == 'needs_selection_coverage'
    previous_samples, previous_scans = set(samples), len(scans)
    # 重新打开实际缓存，验证恢复不依赖 Python 进程里的模型对象。
    restored = ArtifactStore(tmp_path / 'resume.sqlite')
    rt.store.db.backup(restored.db)
    rt.store = restored
    try:
        updates.clear(); samples.clear(); run(rt)
        second = updates[-1]
        assert len(scans) == previous_scans
        assert second['fit_count'] == first['fit_count'] == 4
        assert not {'scanning', 'ranked_sampling', 'training'} & {s['stop_reason'] for s in updates}
        assert second['reused_training_records'] == first['training_records']
        assert set(first['selection_ids']) < set(second['selection_ids'])
        assert not set(second['training_ids']) & set(second['selection_ids'])
        assert not previous_samples & set(samples)
        assert len(samples) == 256
        assert second['stop_reason'] == 'needs_selection_coverage'
        # 耗尽现有排序池后明确交回发现缺口，不能继续提示无收益的原样续跑。
        for _ in range(5):
            run(rt)
            if updates[-1]['stop_reason'] == 'needs_coverage':
                break
        assert updates[-1]['stop_reason'] == 'needs_coverage'
        assert updates[-1]['selection_remaining_records'] == 0
        assert len(scans) == previous_scans
        assert updates[-1]['fit_count'] == 4
    finally:
        restored.close()


@pytest.mark.parametrize('change', ['training_label', 'feature_generation', 'query_revision'])
def test_selection_resume_invalidates_affected_models(make_runtime, change):
    from dataclasses import replace
    y = np.zeros(5000, dtype=np.int8); y[42] = 1
    rt = make_runtime(); updates, _, _ = numeric_port(rt, np.eye(2, dtype=np.float32)[y], y)
    port, generation, known, scans = rt.resources, 'synthetic-v1', {'42': 1}, []
    async def call(method, p):
        if method == 'features.seeds': return {'ids': [42], 'known_labels': known, 'feature_id': generation}
        if method == 'features.scan': scans.append(p)
        value = await port(method, p)
        return {**value, 'feature_id': generation} if method.startswith('features.') else value
    rt.resources = call
    run(rt); first = updates[-1]; scans_before = len(scans)
    if change == 'training_label':
        known[str(next(i for i in first['training_ids'] if i != 42))] = 1
    elif change == 'feature_generation': generation = 'synthetic-v2'
    else: rt.scope = replace(rt.scope, input_revision=2)
    updates.clear(); run(rt)
    phases = {u['stop_reason'] for u in updates}
    assert 'resuming_selection' not in phases
    assert 'training' in phases
    assert (len(scans) > scans_before) == (change != 'training_label')


def test_vector_discovery_survives_a_broad_keyword_seed_pool(make_runtime):
    y = np.zeros(2000, dtype=np.int8); y[:15] = 1
    X = np.eye(2, dtype=np.float32)[y]
    rt = make_runtime(); updates, _, samples = numeric_port(rt, X, y)
    port = rt.resources
    async def call(method, p):
        if method == 'features.seeds':
            return {'ids': list(range(2000)), 'scores': {str(i): 2 if i < 15 else 1 for i in range(2000)}}
        return await port(method, p)
    rt.resources = call
    run(rt)
    assert set(range(15)) & set(samples[:128])
    assert updates[-1]['fit_count'] == 4


@pytest.mark.parametrize('block_size', [7, 16384])
def test_ranked_discovery_keeps_high_ids_first_and_reserves_adjacent_positives(make_runtime, block_size):
    y = np.zeros(2000, dtype=np.int8); y[-4:] = 1
    rt = make_runtime()
    updates, _, samples = numeric_port(rt, np.eye(2, dtype=np.float32)[y], y,
        scores=np.arange(len(y), dtype=float))
    run(rt, pool_size=16, selection_size=4, sample_size=4, block_size=block_size)
    # 全域最高分在数字 ID 尾部；首窗全正后，下一窗继续按分数找到反例。
    assert samples[:8] == list(range(1999, 1991, -1))
    last = updates[-1]
    assert last['selection_ids'] == [1998, 1997, 1994, 1993]
    assert not set(last['training_ids']) & set(last['selection_ids'])
    assert last['fit_count'] == 4
    assert next(u for u in updates if u['sampling_phase'] == 'training_discovery')['sampling_method'] == 'ngram_vector_desc'


def test_ranked_discovery_resume_consumes_new_seed_without_reusing_labels_or_moving_holdout(make_runtime):
    y = np.zeros(100, dtype=np.int8); y[99] = 1
    rt = make_runtime()
    updates, _, samples = numeric_port(rt, np.eye(2, dtype=np.float32)[y], y,
        scores=100-np.arange(len(y), dtype=float))
    port, seeds = rt.resources, []
    async def call(method, p):
        if method == 'features.seeds':
            return {'ids': seeds, 'scores': {str(i): 200 for i in seeds}, 'feature_id': 'synthetic-v1'}
        return await port(method, p)
    rt.resources = call
    options = {'pool_size': 16, 'selection_size': 4, 'sample_size': 4}
    run(rt, **options)
    first, previous = updates[-1], set(samples)
    assert first['stop_reason'] == 'needs_coverage'
    seeds.extend([99, 99]); samples.clear(); run(rt, **options)
    second = updates[-1]
    assert samples[0] == 99
    assert not previous & set(samples)
    assert second['selection_ids'] == first['selection_ids']
    assert not set(second['training_ids']) & set(second['selection_ids'])
    assert second['fit_count'] == 4


@pytest.mark.parametrize('positives', [(1, 2), (0, 3)])
def test_ranked_discovery_reads_holdout_positives_and_stratifies_before_first_fit(make_runtime, positives):
    y = np.zeros(100, dtype=np.int8); y[list(positives)] = 1
    rt = make_runtime()
    updates, _, samples = numeric_port(rt, np.eye(2, dtype=np.float32)[y], y,
        scores=100-np.arange(len(y), dtype=float))
    run(rt, pool_size=16, selection_size=4, sample_size=4)
    assert samples[:4] == list(range(4))
    last = updates[-1]
    assert last['positive_records'] == 2
    assert len(set(positives) & set(last['training_ids'])) == 1
    assert len(set(positives) & set(last['selection_ids'])) == 1
    assert not set(last['training_ids']) & set(last['selection_ids'])
    assert last['fit_count'] == 4
    assert last['stop_reason'] == 'quality_passed'


def test_single_holdout_positive_is_visible_while_training_gap_requests_next_ranked_window(make_runtime):
    y = np.zeros(100, dtype=np.int8); y[1] = 1
    rt = make_runtime()
    updates, _, samples = numeric_port(rt, np.eye(2, dtype=np.float32)[y], y,
        scores=100-np.arange(len(y), dtype=float))
    run(rt, pool_size=16, selection_size=4, sample_size=4)
    assert samples == list(range(8))
    last = updates[-1]
    assert last['positive_records'] == 1 and last['missing_training_labels'] == ['positive']
    assert 1 in last['selection_ids'] and 1 not in last['training_ids']
    assert last['discovery_remaining_records'] == 12
    assert last['next_action'] == 'continue_ranked_discovery'


def test_selection_resume_consumes_new_high_score_positive_with_frozen_models(make_runtime):
    y = np.zeros(100, dtype=np.int8); y[98:] = 1
    rt = make_runtime()
    updates, _, samples = numeric_port(rt, np.eye(2, dtype=np.float32)[y], y,
        scores=100-np.arange(len(y), dtype=float))
    port, seeds = rt.resources, [99]
    async def call(method, p):
        if method == 'features.seeds':
            return {'ids': seeds, 'scores': {str(i): 200 for i in seeds},
                'known_labels': {'99': 1}, 'feature_id': 'synthetic-v1'}
        return await port(method, p)
    rt.resources = call
    options = {'pool_size': 16, 'selection_size': 4, 'sample_size': 4}
    run(rt, **options); first = updates[-1]
    assert first['stop_reason'] == 'needs_selection_coverage'
    previous = set(samples)
    seeds.append(98); samples.clear(); updates.clear(); run(rt, **options)
    second = updates[-1]
    assert samples[0] == 98
    assert not previous & set(samples)
    assert 'resuming_selection' in {u['stop_reason'] for u in updates}
    assert 'training' not in {u['stop_reason'] for u in updates}
    assert second['training_ids'] == first['training_ids']
    assert set(first['selection_ids']) < set(second['selection_ids'])
    assert 98 in second['selection_ids'] and 98 not in second['training_ids']
    assert second['stop_reason'] == 'quality_passed'


def test_random_unlearnable_is_not_certified(make_runtime):
    rng = np.random.default_rng(8); X = rng.normal(size=(4000, 10)); y = rng.integers(0, 2, 4000)
    rt = make_runtime(); updates, _, samples = numeric_port(rt, X, y); run(rt)
    assert updates[-1]['stop_reason'] == 'quality_not_met'
    assert updates[-1]['next_action'] == 'change_representation_or_discriminator'
    assert len(samples) < len(X)


@pytest.mark.parametrize('kind', ['rare', 'unknown', 'missing'])
def test_insufficient_information_or_rare_positives_never_become_all_negative_or_full_teacher(make_runtime, kind):
    y = np.zeros(5000, dtype=np.int8)
    if kind == 'rare': y[1234] = 1
    if kind == 'unknown': y[:] = -1
    X = np.ones((len(y), 2), dtype=np.float32)
    rt = make_runtime(); updates, predicted, samples = numeric_port(rt, X, y, range(5000) if kind == 'missing' else ())
    run(rt)
    assert updates[-1]['stop_reason'] != 'quality_passed' and not predicted
    assert len(samples) <= 256 and updates[-1]['unresolved'] > 0


def test_missing_features_and_observed_unknown_contribute_to_recall():
    q = quality_bounds([Region(True, 1000, 1000, 1000), Region(False, 1000, 0, 0)], known_unknown=10)
    assert q['fn_interval'][1] == 1010 and q['recall_lower'] < .5


def test_unresolved_history_can_be_judged_after_evidence_becomes_available(make_runtime):
    y = np.full(1000, -1, dtype=np.int8); X = np.eye(2, dtype=np.float32)[np.arange(1000) % 2]
    rt = make_runtime(); updates, predicted, samples = numeric_port(rt, X, y)
    run(rt)
    assert updates[-1]['stop_reason'] == 'needs_information'
    prior = set(samples); y[:] = np.arange(1000) % 2; samples.clear()
    run(rt)
    assert prior & set(samples)
    assert updates[-1]['fit_count'] == 4 and len(predicted) == 1000


def test_unchanged_unresolved_evidence_does_not_call_teacher_again(make_runtime):
    y = np.full(1000, -1, dtype=np.int8)
    rt = make_runtime(); updates, _, _ = numeric_port(rt, np.eye(2, dtype=np.float32)[np.arange(1000) % 2], y)
    run(rt); calls = rt.model.calls
    run(rt)
    assert rt.model.calls == calls
    assert updates[-1]['stop_reason'] == 'needs_information'
    assert updates[-1]['reused_unresolved_records'] > 0


def test_finite_population_bounds_match_exhaustive_small_integer_tails():
    from math import comb
    for N in range(1, 12):
        for n in range(1, N+1):
            for k in range(n+1):
                possible = []
                for K in range(k, k+N-n+1):
                    mass = [comb(K, j)*comb(N-K, n-j) if j <= K and n-j <= N-K else 0 for j in range(n+1)]
                    if 40*sum(mass[:k+1]) >= comb(N, n) and 40*sum(mass[k:]) >= comb(N, n): possible.append(K)
                assert positive_bounds(N, n, k, .05) == (min(possible), max(possible))


def test_linear_folding_preserves_fit_precision_dense_and_sparse():
    from scipy.sparse import csr_matrix
    from caseweave_ops.models import model_bank
    rng = np.random.default_rng(5); X = rng.normal(size=(200, 6)); y = (X[:, 0] > 0).astype(np.int8)
    for sparse in (False, True):
        views = {'dense': X, **({'sparse': csr_matrix(X)} if sparse else {})}
        for model in fit_models(views, y, candidates=model_bank(sparse=sparse)[:2]):
            x = views[model.view]; z = model.scaler.transform(x) if model.scaler else x
            np.testing.assert_allclose(model.score(x), model.estimator.decision_function(z), atol=1e-12)


def test_nonuniform_selection_uses_inclusion_weights_and_never_class_weights():
    q = operating_point(np.array([1, 0, 1]), np.array([3., 2., 1.]), weights=np.array([1., 100., 1.]))
    assert q['precision'] < 1 or q['recall'] < 1


def test_previous_audit_becomes_known_and_cannot_reenter_independent_measurement(make_runtime):
    y = np.arange(5000) % 2; X = np.eye(2, dtype=np.float32)[y]
    rt = make_runtime(); updates, _, _ = numeric_port(rt, X, y)
    run(rt); first = updates[-1]
    run(rt); second = updates[-1]
    assert second['quality']['measurement_round'] == 2
    assert second['quality']['delta'] < first['quality']['delta']
    assert set(first['audit_ids']) <= set(second['training_ids'])
    assert not set(first['audit_ids']) & set(second['audit_ids'])
