from retrieval_agent_evals.report_combined import (
    _condition_method_record,
    _input_fields,
    _metric,
    _micro_from_conditions,
    _pct,
    merge_condition_method_rows,
)


def test_merge_keeps_first_baseline_and_adds_new_methods():
    baseline = {"method": "laya", "metrics": {"n": 1, "f1": 0.5}}
    duplicate = {"method": "laya", "metrics": {"n": 1, "f1": 0.5}, "cached": True}
    added = {"method": "dual_description_margin", "metrics": {"n": 1, "f1": 1.0}}

    merged = merge_condition_method_rows([baseline], [duplicate, added])

    assert merged["laya"] == baseline
    assert set(merged) == {"laya", "dual_description_margin"}


def test_merge_rejects_changed_cached_metrics_and_micro_preserves_abstain_denominator():
    baseline = {"method": "laya", "metrics": {"n": 1, "f1": 0.5}}
    changed = {"method": "laya", "metrics": {"n": 1, "f1": 0.6}}
    try:
        merge_condition_method_rows([baseline], [changed])
    except ValueError:
        pass
    else:
        raise AssertionError("changed cached metrics must not silently replace the original baseline")

    micro = _micro_from_conditions([{
        "n": 2, "predicted": 1, "abstained": 1, "tp": 0, "fp": 0, "fn": 1, "tn": 1,
        "abstained_positive": 1, "abstained_negative": 0,
    }])
    assert micro["coverage"] == 0.5
    assert micro["recall"] == 0.0
    assert micro["balanced_accuracy"] == 0.5


def test_failed_method_remains_failed_without_zero_metric():
    failure = {"method": "relation_conformal", "status": "failed", "metrics": None,
               "error_type": "insufficient_calibration_classes"}
    merged = merge_condition_method_rows([failure], [])

    assert merged["relation_conformal"]["status"] == "failed"
    assert merged["relation_conformal"]["metrics"] is None


def test_zero_shot_metrics_without_status_render_as_scores_not_dashes():
    method = _condition_method_record({
        "method": "name_gmm_test_batch",
        "metrics": {"balanced_accuracy": 0.845833, "f1": 0.817734},
    })
    report = {"conditions": {"C01": {"methods": {"name_gmm_test_batch": method}}}}

    assert method["status"] == "completed"
    assert _metric(report, "name_gmm_test_batch", "C01", "balanced_accuracy") == 0.845833
    assert _metric(report, "name_gmm_test_batch", "C01", "f1") == 0.817734
    assert _pct(0.845833) == "84.6%"


def test_jeff_inputs_exclude_body_unlike_cached_neural_baselines():
    assert _input_fields("jeff_qwen35_08b") == ["title", "summary"]
    assert _input_fields("laya") == ["title", "summary", "body"]
