"""128×1024合成特征只验证候选拟合/OOF/二分类，不代表业务准确率。"""
import numpy as np
import pytest
from caseweave_ops.ensemble import DEFAULT_METHODS, select_group_crossfit
from caseweave_ops.models import model_bank


@pytest.mark.parametrize("positives", [64, 6])
def test_eleven_candidates_crossfit_with_dense_small_samples(positives):
    rng = np.random.default_rng(19)
    x = rng.normal(size=(128, 1024)).astype(np.float32)
    y = np.zeros(128, dtype=np.int8); y[:positives] = 1
    x[:, :8] += y[:, None] * 1.5
    groups = np.array([str(i) for i in range(128)], dtype=object)
    selected, manifest = select_group_crossfit({'dense': x}, y, groups,
        methods=list(DEFAULT_METHODS), fusion='selective', budget_seconds=60)
    assert len(manifest['models']) == 11
    assert not manifest['candidate_failures']
    assert manifest['fit_count'] == 44
    assert 1 <= len(manifest['members']) <= 3
    assert np.isfinite(selected.score_views({'dense': x})).all()


def test_no_probability_calibration_wrapper_or_svm_probability_fit():
    bank = model_bank(methods=list(DEFAULT_METHODS))
    assert len(bank) == 11
    for candidate in bank:
        assert type(candidate.estimator).__name__ != 'CalibratedClassifierCV'
        if candidate.name == 'dense_rbf_svm':
            assert candidate.estimator.probability is False
