import numpy as np
import pytest

from retrieval_agent_evals.operators import METHODS, fit_operator


def fixture_data():
    rng = np.random.default_rng(12)
    anchor = np.array([1, 0, 0, 0], dtype=np.float32)
    pos = rng.normal([1, 0, 0, 0], 0.18, (64, 4))
    neg = rng.normal([-1, 0, 0, 0], 0.18, (64, 4))
    x = np.concatenate([pos, neg]).astype(np.float32)
    y = np.r_[np.ones(64), np.zeros(64)].astype(np.int8)
    return x, y, anchor


@pytest.mark.parametrize("name", [m for m in METHODS if m not in {"name_gmm", "spherical_kmeans"}])
def test_supervised_operators_fit_train_and_score_holdout(name):
    x, y, _ = fixture_data()
    train = np.r_[0:48, 64:112]
    test = np.r_[48:64, 112:128]
    model = fit_operator(name, x[train], y[train], seed=2)
    scores = model.score(x[test])
    pred = model.predict(x[test])
    assert scores.shape == (32,)
    assert pred.shape == (32,)
    assert set(np.unique(pred)) <= {0, 1}
    assert np.mean(pred == y[test]) > 0.7


@pytest.mark.parametrize("name", ["name_gmm", "spherical_kmeans"])
def test_anchor_methods_are_zero_label_and_need_query_anchor(name):
    x, _, anchor = fixture_data()
    fitted = fit_operator(name, x[:100], anchor=anchor, seed=3)
    assert np.mean(fitted.predict(x[100:]) == (x[100:, 0] > 0)) > 0.8
    with pytest.raises(ValueError, match="anchor"):
        fit_operator(name, x[:100])


def test_conformal_exposes_selective_predictions():
    x, y, _ = fixture_data()
    model = fit_operator("relation_conformal", x[:96], y[:96])
    pred = model.predict_selective(x[96:], alpha=0.1)
    assert set(np.unique(pred)) <= {-1, 0, 1}



def test_relation_training_features_never_include_the_heldout_rows(monkeypatch):
    import retrieval_agent_evals.operators as operators
    # 正交行使泄漏可直接观测：任何自身中心/原型/leader关系都会产生非零点积。
    x = np.eye(12, dtype=np.float32)
    y = np.r_[np.ones(6), np.zeros(6)].astype(np.int8)
    original = operators._relation_features
    seen = []
    def check_heldout(heldout, pos, neg, pp, np_, leader):
        for references in (pos[None, :], neg[None, :], pp, np_, leader[None, :]):
            np.testing.assert_allclose(heldout @ references.T, 0, atol=1e-7)
        seen.extend(np.argmax(heldout, axis=1).tolist())
        return original(heldout, pos, neg, pp, np_, leader)
    monkeypatch.setattr(operators, '_relation_features', check_heldout)
    model = fit_operator('relation_logistic', x, y, seed=3)
    assert sorted(seen) == list(range(len(x)))
    assert len(seen) == len(set(seen))
    monkeypatch.setattr(operators, '_relation_features', original)
    another = fit_operator('relation_logistic', x, y, seed=3)
    np.testing.assert_allclose(model.score(x), another.score(x))


def test_relation_cross_fit_rejects_a_single_minority_example():
    with pytest.raises(ValueError, match='cross-fit needs at least two'):
        fit_operator('relation_logistic', np.eye(6, dtype=np.float32), np.array([1, 0, 0, 0, 0, 0]))



def test_relation_serving_uses_full_training_state_and_never_updates_on_test(monkeypatch):
    import retrieval_agent_evals.operators as operators
    x, y, _ = fixture_data()
    original, states = operators._relation_state, []
    def observed(rows, labels):
        states.append((rows.copy(), labels.copy()))
        return original(rows, labels)
    monkeypatch.setattr(operators, "_relation_state", observed)
    model = fit_operator("relation_logistic", x, y, seed=4)
    np.testing.assert_allclose(states[-1][0], operators._normalize(x))
    np.testing.assert_array_equal(states[-1][1], y)
    assert all(len(rows) < len(x) for rows, _ in states[:-1])
    before = tuple(part.copy() for part in model.state)
    test = np.array([[0., 1., 0., 0.], [0., 0., 1., 0.]], dtype=np.float32)
    model.score(test)
    assert len(states) == 6
    for prior, current in zip(before, model.state, strict=True):
        np.testing.assert_array_equal(prior, current)
