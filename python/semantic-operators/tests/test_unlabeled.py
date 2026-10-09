"""Synthetic-only acceptance checks for one-fit, identity-bound frozen adapters."""
import asyncio
from dataclasses import replace

import numpy as np
import pytest

from caseweave_ops.types import Passage, ProtocolError, Record, StaleTask, digest
from caseweave_ops.unlabeled import QueryUnlabeledAdapter, UNLABELED_METHODS


METHODS = tuple(UNLABELED_METHODS)


def rows(vectors):
    return tuple(Record(f"synthetic-{i}", "v1", digest(["synthetic", i]),
        (Passage(f"p-{i}", "source.synthetic", f"synthetic text {i}"),),
        (tuple(float(value) for value in vector),), "synthetic-space") for i, vector in enumerate(vectors))


def adapter(method):
    return QueryUnlabeledAdapter(method, scope_key="synthetic-scope", predicate_key="synthetic-predicate",
                                 embedding_id="synthetic-space", seed=7)


def separated_pool():
    rng = np.random.default_rng(29)
    vectors = np.vstack([rng.normal((1., 0., 0.), .12, (20, 3)),
                         rng.normal((-1., 0., 0.), .12, (20, 3))])
    return rows(vectors), vectors


@pytest.mark.parametrize("method", METHODS)
def test_chunk_order_duplicate_lookup_never_refits_and_scores_stay_fixed(method, monkeypatch):
    records, vectors = separated_pool()
    frozen = adapter(method)
    manifest = frozen.fit(records, vectors, np.array([1., 0., 0.]), negative_anchor=np.array([-1., 0., 0.]))
    original = {decision.ref: decision for decision in frozen.predict(records)}
    assert manifest["fit_count"] == (0 if method == "dual_description_margin" else 1)
    assert manifest["online_feedback_training"] is False and manifest["teacher_calls"] == 0
    assert manifest["quality"] == "unmeasured" and manifest["authority"] == "proxy_candidates_only"
    assert {decision.label for decision in original.values()} == {"accept", "exclude"}
    assert all(d.confidence is None and d.basis == "proxy" and not d.citations for d in original.values())
    def forbidden(*args, **kwargs):
        raise AssertionError("predict must not fit an estimator")
    monkeypatch.setattr("caseweave_ops.unlabeled.GaussianMixture.fit", forbidden)
    monkeypatch.setattr("caseweave_ops.unlabeled.KMeans.fit", forbidden)
    permuted = tuple(records[i] for i in np.random.default_rng(44).permutation(len(records)))
    for size in (1, 3, 17, 40):
        for start in range(0, len(records), size):
            for decision in frozen.predict(permuted[start:start + size]):
                assert decision == original[decision.ref]
    assert frozen.predict((records[1], records[1]))[0] == frozen.predict((records[1], records[1]))[1]
    assert frozen.manifest == manifest
    with pytest.raises(ProtocolError, match="already_fitted"):
        frozen.fit(records, vectors, np.array([1., 0., 0.]))


@pytest.mark.parametrize("method", METHODS)
def test_canonical_pool_order_makes_independent_seeded_fits_reproducible(method):
    records, vectors = separated_pool()
    first, second = adapter(method), adapter(method)
    anchor, negative = np.array([1., 0., 0.]), np.array([-1., 0., 0.])
    first.fit(records, vectors, anchor, negative_anchor=negative)
    order = np.random.default_rng(9).permutation(len(records))
    second.fit(tuple(records[i] for i in order), vectors[order], anchor, negative_anchor=negative)
    assert first.manifest["pool_key"] == second.manifest["pool_key"]
    assert first.predict(records) == second.predict(records)


def test_dual_description_is_pointwise_and_tie_is_binary_negative():
    vectors = np.array([[2., .1], [-2., .1], [0., 1.]])
    records = rows(vectors)
    frozen = adapter("dual_description_margin")
    frozen.fit(records, vectors, [1., 0.], negative_anchor=[-1., 0.])
    positive, negative, tie = frozen.predict(records)
    assert positive.label == "accept" and positive.inference["score"] > 0
    assert negative.label == "exclude" and negative.inference["score"] < 0
    assert tie.label == "exclude" and tie.error is None
    assert tie.basis == "proxy" and tie.inference['score'] == 0
    isolated = adapter("dual_description_margin")
    isolated.fit(records[:1], vectors[:1], [1., 0.], negative_anchor=[-1., 0.])
    assert isolated.predict(records[:1])[0].inference["score"] == positive.inference["score"]


@pytest.mark.parametrize("method", ["name_gmm", "kmeans"])
def test_constant_single_cluster_pool_is_unknown_not_all_positive(method):
    vectors = np.ones((12, 3))
    frozen = adapter(method)
    manifest = frozen.fit(rows(vectors), vectors, [1., 0., 0.])
    predictions = frozen.predict(rows(vectors))
    assert manifest["fit_count"] == 0 and manifest["unknown_records"] == 12
    assert all(p.label == "undetermined" and p.error == "degenerate_unlabeled_projection" for p in predictions)
    assert all(p.confidence is None and p.basis == "unresolved" for p in predictions)


@pytest.mark.parametrize("method,count", [("name_gmm", 4), ("kmeans", 1)])
def test_too_small_pool_retains_unknown(method, count):
    vectors = np.random.default_rng(3).normal(size=(count, 3))
    frozen = adapter(method)
    manifest = frozen.fit(rows(vectors), vectors, [1., 0., 0.])
    assert manifest["fit_count"] == 0
    assert all(p.label == "undetermined" and p.error == "insufficient_unlabeled_pool" for p in frozen.predict(rows(vectors)))


@pytest.mark.parametrize("method", METHODS)
def test_missing_query_anchor_does_not_become_negative_training_data(method):
    records, vectors = separated_pool()
    frozen = adapter(method)
    frozen.fit(records, vectors, None)
    assert all(p.label == "undetermined" and p.error == "query_anchor_missing_or_invalid" for p in frozen.predict(records))
    assert frozen.manifest["fit_count"] == 0


def test_missing_negative_description_keeps_dual_unknown():
    records, vectors = separated_pool()
    frozen = adapter("dual_description_margin")
    frozen.fit(records, vectors, [1., 0., 0.])
    assert all(p.label == "undetermined" and p.error == "negative_description_anchor_missing_or_invalid" for p in frozen.predict(records))


def test_missing_invalid_vectors_and_wrong_embedding_space_remain_unknown():
    vectors = np.array([[1., 0.], [0., 0.], [np.nan, 1.], [-1., 0.]])
    records = list(rows(np.array([[1., 0.], [0., 0.], [1., 1.], [-1., 0.]])))
    records[-1] = replace(records[-1], embedding_id="different-space")
    frozen = adapter("dual_description_margin")
    frozen.fit(records, vectors, [1., 0.], negative_anchor=[-1., 0.])
    output = frozen.predict(records)
    assert output[0].label == "accept"
    assert all(p.label == "undetermined" and p.error == "missing_or_invalid_vector_or_embedding_space" for p in output[1:])


def test_empty_pool_and_empty_chunk_are_valid_without_fit_or_teacher():
    frozen = adapter("name_gmm")
    manifest = frozen.fit((), np.empty((0, 2)), [1., 0.])
    assert manifest["fit_count"] == 0 and manifest["pool_records"] == 0
    assert frozen.predict(()) == ()


def test_pool_identity_cannot_be_reused_for_changed_version_text_attributes_or_vector():
    records, vectors = separated_pool()
    frozen = adapter("name_gmm")
    frozen.fit(records, vectors, [1., 0., 0.])
    changed = (replace(records[0], version="v2"),
               replace(records[1], attributes={"synthetic_attribute": "changed"}),
               replace(records[2], passages=(Passage("new-p", "source.synthetic", "changed synthetic text"),)),
               replace(records[3], vectors=((0., 1., 0.),)))
    assert all(p.label == "undetermined" and p.error == "record_changed_since_fixed_pool_fit" for p in frozen.predict(changed))
    outsider = replace(records[0], ref="outside-fixed-pool")
    assert frozen.predict([outsider])[0].error == "record_not_in_fixed_pool"
    with pytest.raises(StaleTask):
        frozen.predict(records, scope_key="different-scope")


def test_cancel_before_fit_after_native_fit_and_before_predict_never_publishes():
    records, vectors = separated_pool()
    frozen = adapter("name_gmm")
    with pytest.raises(asyncio.CancelledError):
        frozen.fit(records, vectors, [1., 0., 0.], cancelled=lambda: True)
    with pytest.raises(ProtocolError, match="not_fitted"):
        frozen.predict(records)
    checks = iter((False, True))
    with pytest.raises(asyncio.CancelledError):
        frozen.fit(records, vectors, [1., 0., 0.], cancelled=lambda: next(checks))
    with pytest.raises(ProtocolError, match="not_fitted"):
        frozen.manifest
    frozen.fit(records, vectors, [1., 0., 0.])
    with pytest.raises(asyncio.CancelledError):
        frozen.predict(records, cancelled=lambda: True)


def test_invalid_fit_shape_duplicate_refs_and_mutable_manifest_do_not_corrupt_pool():
    records, vectors = separated_pool()
    frozen = adapter("name_gmm")
    with pytest.raises(ProtocolError, match="align"):
        frozen.fit(records, vectors[:-1], [1., 0., 0.])
    with pytest.raises(ProtocolError, match="unique"):
        frozen.fit([records[0], records[0]], vectors[:2], [1., 0., 0.])
    frozen.fit(records, vectors, [1., 0., 0.])
    manifest = frozen.manifest
    manifest["config"]["n_init"] = 999
    manifest["quality"] = "invented_accuracy"
    assert frozen.manifest["quality"] == "unmeasured"
    assert frozen.manifest["config"]["n_init"] == 8


def test_fixed_task_configuration_cannot_be_changed_in_place():
    frozen = adapter("name_gmm")
    for field, changed in (("method", "kmeans"), ("scope_key", "new-scope"),
                           ("predicate_key", "new-predicate"), ("embedding_id", "new-space"), ("seed", 8)):
        with pytest.raises(AttributeError):
            setattr(frozen, field, changed)


def test_estimator_error_is_unknown_without_echoing_features(monkeypatch):
    records, vectors = separated_pool()
    marker = "SYNTHETIC_FEATURES_MUST_NOT_ESCAPE"
    def failed(*args, **kwargs):
        raise ValueError(marker)
    monkeypatch.setattr("caseweave_ops.unlabeled.GaussianMixture.fit", failed)
    frozen = adapter("name_gmm")
    frozen.fit(records, vectors, [1., 0., 0.])
    predictions = frozen.predict(records)
    assert all(p.label == "undetermined" and p.error == "unlabeled_fit_failed" for p in predictions)
    assert marker not in repr(predictions)
    assert frozen.manifest["quality"] == "unmeasured"
