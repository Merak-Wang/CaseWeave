import hashlib
import json

from retrieval_agent_evals.report_experiment import build_report


def test_report_rejoins_only_frozen_test_identities_and_marks_missing_methods(tmp_path):
    conditions = tmp_path / "conditions"
    results = tmp_path / "results"
    report = tmp_path / "report"
    case = conditions / "Q1"
    case.mkdir(parents=True)
    results.mkdir()
    (case / "manifest.json").write_text(json.dumps({"condition_id": "Q1", "query": "test query",
        "recall_union_count": 600, "document_embedding": {"model": "local-embedding"},
        "query_embedding": {"model": "local-embedding", "query_index": 0}}), encoding="utf-8")
    candidates, labeled = [], []
    for i in range(256):
        split = "train" if i % 2 == 0 else "test"
        row = {"ticket_id": f"T{i:03}", "split": split, "title": "标题", "summary": "摘要", "body": "原文"}
        candidates.append(row)
        labeled.append({**row, "label": int(i % 4 == 1), "label_source": "deepseek-v4.1-flash"})
    for name, rows in (("candidates.jsonl", candidates), ("labeled.jsonl", labeled)):
        (case / name).write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    test = [row for row in labeled if row["split"] == "test"]
    ids = [row["ticket_id"] for row in test]
    split_hash = hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest()
    predictions = [{"ticket_id": row["ticket_id"], "prediction": int(row["label"]), "pseudo_label": 1-row["label"]} for row in test]
    (results / "Q1.json").write_text(json.dumps({"condition_id": "Q1", "test_split_hash": split_hash,
        "embedding_identity": {"model": "local-embedding"},
        "query_embedding_identity": {"model": "local-embedding", "query_index": 0},
        "embedding_generation": {"document": {"wall_elapsed_seconds": 17},
                                 "query": {"provider_elapsed_ms": 8}},
        "methods": [{"method": "linear_svm", "status": "completed", "predictions": predictions,
                     "timing_seconds": {"fit": .1, "predict_and_score": .2, "total": .3}}]}), encoding="utf-8")
    neural = case / "neural" / "laya"
    neural.mkdir(parents=True)
    (neural / "predictions.jsonl").write_text("".join(json.dumps({"ticket_id": row["ticket_id"],
        "prediction": 1-row["label"], "score": .7}) + "\n" for row in test), encoding="utf-8")
    (neural / "environment.json").write_text(json.dumps({"calls": 128, "input_tokens_total": 2400,
        "inference_seconds_total": 12}), encoding="utf-8")
    julia = case / "neural" / "julia"
    julia.mkdir(parents=True)
    (julia / "predictions.jsonl").write_text("", encoding="utf-8")
    (julia / "environment.json").write_text(json.dumps({"status": "incomplete", "count": 0,
        "failure_type": "ValueError", "failure_message": "strict token budget exceeded"}), encoding="utf-8")
    gliner = case / "neural" / "gliner"
    gliner.mkdir(parents=True)
    (gliner / "predictions.jsonl").write_text("".join(json.dumps({"ticket_id": row["ticket_id"],
        "prediction": 0, "score": .4, "prediction_any_chunk_relevant": 1,
        "score_any_chunk_relevant": .7, "input_tokens": 200, "elapsed_seconds": .1,
        "length": {"chunk_count": 2}}) + "\n" for row in test), encoding="utf-8")
    (gliner / "environment.json").write_text(json.dumps({"status": "completed", "calls": 128,
        "input_tokens_total": 25600, "inference_seconds_total": 12}), encoding="utf-8")

    metrics = build_report(conditions, results, report)
    rows = [json.loads(line) for line in (report / "comparison.jsonl").read_text(encoding="utf-8").splitlines()]
    by_method = {row["method"]: row for row in rows}

    assert metrics["condition_count"] == 1
    assert by_method["linear_svm"]["metrics"]["f1"] == 1.0
    assert by_method["laya"]["metrics"]["f1"] == 0.0
    assert by_method["logistic_regression"]["status"] == "not_run"
    assert by_method["julia"]["status"] == "incomplete"
    assert metrics["methods"]["julia"]["incomplete_conditions"][0]["completed_prediction_count"] == 0
    assert by_method["gliner_official"]["model_calls"] == 128
    assert by_method["gliner_official"]["forward_batches"] == 128
    assert by_method["gliner_official"]["chunk_decisions"] == 256
    assert by_method["gliner_any_positive"]["shared_inference_with"] == "gliner_official"
    assert metrics["methods"]["gliner_any_positive"]["neural_usage_sum"] is None
    assert metrics["embedding_costs"]["shared_document_embeddings"][0]["generation"]["wall_elapsed_seconds"] == 17
    assert metrics["embedding_costs"]["all_query_embeddings_generation"]["provider_elapsed_ms"] == 8
    assert metrics["methods"]["linear_svm"]["conditions_completed"] == 1
    assert "DeepSeek V4.1 Flash" in (report / "REPORT.md").read_text(encoding="utf-8")
    assert by_method["all_positive"]["reference_only"] is True
    assert metrics["conditions"][0]["train_pseudo_label_counts"] == {"negative": 128, "positive": 0}
    assert metrics["conditions"][0]["test_pseudo_label_counts"] == {"negative": 64, "positive": 64}


def test_report_rejects_prediction_identity_mismatch(tmp_path):
    conditions, results = tmp_path / "conditions", tmp_path / "results"
    case = conditions / "Q1"
    case.mkdir(parents=True)
    results.mkdir()
    (case / "manifest.json").write_text(json.dumps({"condition_id": "Q1"}), encoding="utf-8")
    candidates = [{"ticket_id": f"T{i}", "split": "train" if i < 128 else "test"} for i in range(256)]
    (case / "candidates.jsonl").write_text("".join(json.dumps(row) + "\n" for row in candidates), encoding="utf-8")
    test_ids = [row["ticket_id"] for row in candidates if row["split"] == "test"]
    digest = hashlib.sha256("\n".join(sorted(test_ids)).encode()).hexdigest()
    (results / "Q1.json").write_text(json.dumps({"test_split_hash": digest,
        "methods": [{"method": "linear_svm", "status": "completed", "predictions": []}]}), encoding="utf-8")

    import pytest
    with pytest.raises(ValueError, match="prediction identities"):
        build_report(conditions, results, tmp_path / "report")
