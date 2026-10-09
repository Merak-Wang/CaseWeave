import numpy as np

from retrieval_agent_evals.zero_shot import (
    ZERO_SHOT_METHODS,
    predict_batch,
    predict_one,
)


def test_pointwise_dual_description_uses_only_one_ticket_vector():
    positive = np.array([1.0, 0.0, 0.0])
    negative = np.array([-1.0, 0.0, 0.0])
    pos = predict_one(np.array([2.0, 0.1, 0.0]), positive, negative)
    neg = predict_one(np.array([-2.0, 0.1, 0.0]), positive, negative)
    assert pos["prediction"] == 1 and pos["score"] > 0
    assert neg["prediction"] == 0 and neg["score"] < 0
    assert pos["config"]["threshold"] == 0.0


def test_transductive_methods_fit_only_the_unlabeled_batch_and_are_deterministic():
    rng = np.random.default_rng(19)
    positive = rng.normal(loc=(1.0, 0.0, 0.0, 0.0), scale=0.12, size=(64, 4))
    negative = rng.normal(loc=(-1.0, 0.0, 0.0, 0.0), scale=0.12, size=(64, 4))
    x = np.vstack([positive, negative])
    query = np.array([1.0, 0.0, 0.0, 0.0])
    methods = [name for name, meta in ZERO_SHOT_METHODS.items()
               if meta["regime"] == "test_batch_transductive"]
    assert len(methods) == 7
    for method in methods:
        first = predict_batch(method, x, query, seed=7)
        second = predict_batch(method, x, query, seed=7)
        assert first["scores"].shape == (128,)
        assert first["predictions"].shape == (128,)
        assert np.isfinite(first["scores"]).all()
        assert set(np.unique(first["predictions"])) <= {0, 1}
        np.testing.assert_array_equal(first["predictions"], second["predictions"])
        np.testing.assert_allclose(first["scores"], second["scores"])
        assert first["config"]["seed"] == 7


def test_otsu_has_stable_lower_threshold_tie_and_constant_fallback():
    x = np.array([-2.0, -1.0, 1.0, 2.0])
    result = predict_batch("query_otsu_test_batch", x[:, None], np.ones(1))
    assert result["config"]["threshold_value"] == -0.0
    assert result["predictions"].tolist() == [0, 0, 1, 1]
    same = predict_batch("query_otsu_test_batch", np.ones((4, 1)), np.ones(1))
    assert same["predictions"].tolist() == [1, 1, 1, 1]
