"""仅受控合成质量，不把脚本标签称为中文业务 Gold 或真实 LLM。"""
import asyncio
import base64
import numpy as np
import pytest
from caseweave_ops import invoke_rows
from caseweave_ops.models import fit_models, operating_point
from caseweave_ops.quality import Region, quality_bounds, positive_bounds
from conftest import record, source, collect, decisions


def numeric_port(runtime, X, y, missing=()):
    updates, emitted, samples = [], {}, []
    available = np.ones(len(X), dtype=np.uint8); available[list(missing)] = 0
    def block(ids, cursor=None):
        ids = np.array(ids, dtype=np.int64)
        return {"ids": ids.tolist(), "dense": base64.b64encode(np.asarray(X[ids], dtype='<f4').tobytes()).decode(),
            "dimensions": X.shape[1], "available": base64.b64encode(available[ids].tobytes()).decode(),
            "feature_id": "synthetic-v1", "next_cursor": cursor}
    async def call(method, p):
        if method == 'features.scan':
            start, width = int(p['cursor'] or 0), p['page_size']; end = min(len(X), start+width)
            return block(range(start, end), str(end) if end < len(X) else None)
        if method == 'features.take': return block(p['ids'])
        if method == 'features.seeds': return {'ids': [int(i) for i in p['refs']]}
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
    assert last['fit_count'] == 4 and last['predicted_records'] == len(X)
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
