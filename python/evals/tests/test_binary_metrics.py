import pytest

from retrieval_agent_evals.binary_metrics import score_binary


def test_binary_metrics_include_selective_coverage_and_usage():
    result = score_binary([1, 1, 0, 0], [1, -1, 0, 1], usage={
        "calls": 3, "input_tokens": 12, "output_tokens": 4, "latency_ms": 80,
    })
    assert result["tp"] == 1
    assert result["fp"] == 1
    assert result["tn"] == 1
    assert result["fn"] == 1
    assert result["coverage"] == 0.75
    assert result["abstain_rate"] == 0.25
    assert result["precision"] == 0.5
    assert result["recall"] == 0.5
    assert result["conditional"]["recall"] == 1.0
    assert result["usage"]["calls"] == 3


def test_binary_metrics_report_zero_coverage_without_division_errors():
    result = score_binary([1, 0], [-1, -1])
    assert result["coverage"] == 0
    assert result["accuracy"] == 0
    assert result["balanced_accuracy"] == 0
    assert result["abstained"] == 2


def test_binary_metrics_reject_different_shapes():
    with pytest.raises(ValueError, match="identical shape"):
        score_binary([1], [1, 0])


def test_conditional_f1_is_zero_when_every_decision_is_wrong():
    result = score_binary([1, 0], [0, 1])
    assert result["conditional"]["precision"] == 0
    assert result["conditional"]["recall"] == 0
    assert result["conditional"]["f1"] == 0


def test_unknown_references_do_not_become_negatives_or_accuracy_denominator():
    result = score_binary([1, 0, -1, -1], [1, 0, 1, -1])
    assert result['accuracy'] == result['conditional']['accuracy'] == 1
    assert result['fp'] == result['fn'] == 0
    assert result['coverage'] == .75
    assert result['reference_count'] == result['evaluated'] == 2
    assert result['reference_unknown'] == 2
    assert result['reference_coverage'] == .5
    assert result['evaluated_coverage'] == 1


def test_no_reference_labels_keeps_quality_unknown():
    result = score_binary([-1, -1], [1, 0])
    assert result['coverage'] == 1 and result['reference_coverage'] == 0
    assert result['accuracy'] is None and result['precision'] is None and result['f1'] is None
    assert result['conditional']['accuracy'] is None
