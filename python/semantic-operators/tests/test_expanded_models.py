"""128×1024合成特征只验证候选拟合/OOF/二分类，不代表业务准确率。"""
import numpy as np
import pytest
from caseweave_ops.ensemble import DEFAULT_METHODS, select_group_crossfit
from caseweave_ops.models import model_bank


@pytest.mark.parametrize("positives", [64, 6])
def test_fourteen_default_candidates_crossfit_with_dense_and_text_small_samples(positives):
    rng = np.random.default_rng(19)
    x = rng.normal(size=(128, 1024)).astype(np.float32)
    y = np.zeros(128, dtype=np.int8); y[:positives] = 1
    x[:, :8] += y[:, None] * 1.5
    groups = np.array([str(i) for i in range(128)], dtype=object)
    views = {'dense': x, 'text': np.array(['权限异常处理' if label else '普通业务办理' for label in y], dtype=object)}
    selected, manifest = select_group_crossfit(views, y, groups,
        fusion='selective', budget_seconds=60)
    assert len(manifest['models']) == 14
    assert manifest['methods'] == list(DEFAULT_METHODS)
    assert not manifest['candidate_failures']
    assert manifest['fit_count'] == 56
    assert 1 <= len(manifest['members']) <= 3
    assert np.isfinite(selected.score_views(views)).all()


def test_no_probability_calibration_wrapper_or_svm_probability_fit():
    bank = model_bank(methods=list(DEFAULT_METHODS))
    assert len(bank) == 14
    for candidate in bank:
        assert type(candidate.estimator).__name__ != 'CalibratedClassifierCV'
        if candidate.name == 'dense_rbf_svm':
            assert candidate.estimator.probability is False


def test_text_vectorizer_fits_only_training_documents():
    from caseweave_ops.models import TextLinearEstimator
    model = TextLinearEstimator().fit(['授权故障', '普通办理'], [1, 0])
    vocabulary = dict(model.vectorizer.vocabulary_)
    idf = model.vectorizer.idf_.copy()
    assert np.isfinite(model.decision_function(['留出专用词汇'])).all()
    assert model.vectorizer.vocabulary_ == vocabulary
    np.testing.assert_array_equal(model.vectorizer.idf_, idf)
    assert '专用' not in vocabulary


def test_explicit_text_model_requires_real_text_view():
    with pytest.raises(ValueError, match='feature view'):
        select_group_crossfit({'dense': np.eye(4)}, np.array([0, 1, 0, 1]),
            np.arange(4).astype(str), methods=['dense_lr', 'text_lr'])
