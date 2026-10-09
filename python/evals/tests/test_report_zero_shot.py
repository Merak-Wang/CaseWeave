import hashlib
import json

from retrieval_agent_evals.experiment import digest
from retrieval_agent_evals.report_zero_shot import build_report


def _jsonl(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def test_zero_shot_report_scores_frozen_predictions_and_cached_laya(tmp_path):
    conditions = tmp_path / "conditions"
    predictions = tmp_path / "predictions"
    conditions.mkdir()
    predictions.mkdir()
    protocol = tmp_path / "protocol.json"
    protocol.write_text(json.dumps({"class_descriptions": [{"condition_id": "C01:positive", "query": "固定定义"}]}), encoding="utf-8")
    (tmp_path / "description_embeddings.manifest.json").write_text(
        json.dumps({"http_physical_requests": 3, "provider_elapsed_ms": 12.5}), encoding="utf-8")
    protocol_hash = hashlib.sha256(protocol.read_bytes()).hexdigest()
    for condition_index, cid in enumerate(("C01", "C02", "Q01", "Q02")):
        folder = conditions / cid
        neural = folder / "neural" / "laya"
        neural.mkdir(parents=True)
        rows, labeled, test_ids, pred_rows = [], [], [], []
        for i in range(256):
            ticket_id = f"{cid}-{i:03}"
            split = "train" if i < 128 else "test"
            row = {"ticket_id": ticket_id, "split": split, "title": f"title-{i}", "summary": f"summary-{i}"}
            rows.append(row)
            label = int(i % 2 == 0) if cid != "C02" else 1
            labeled.append({**row, "label": label, "label_source": "deepseek-v4.1-flash"})
            if split == "test":
                test_ids.append(ticket_id)
                input_hash = hashlib.sha256(f"【标题】{row['title']}\n【摘要】{row['summary']}".encode()).hexdigest()
                pred_rows.append({"ticket_id": ticket_id, "prediction": label, "input_sha256": input_hash})
        candidate_path = folder / "candidates.jsonl"
        _jsonl(candidate_path, rows)
        _jsonl(folder / "labeled.jsonl", labeled)
        (folder / "manifest.json").write_text(json.dumps({"condition_id": cid, "query_spec": {"query": cid}}), encoding="utf-8")
        test_hash = hashlib.sha256("\n".join(test_ids).encode()).hexdigest()
        test_input_hashes = {row["ticket_id"]: row["input_sha256"] for row in pred_rows}
        method_preds = [{"ticket_id": ticket_id, "prediction": 1, "input_sha256": test_input_hashes[ticket_id]}
                        for ticket_id in test_ids]
        result = {"condition_id": cid, "protocol_sha256": protocol_hash, "candidate_sha256": digest(candidate_path),
                  "test_id_sha256": test_hash, "test_count": 128, "methods": [{
                      "method": "dual_description_margin", "regime": "zero_example_independent",
                      "source": "frozen description pair", "learning_signal": "description vectors",
                      "config": {"threshold": 0}, "prediction_seconds": 0.25,
                      "predictions": method_preds}]}
        (predictions / f"{cid}.json").write_text(json.dumps(result), encoding="utf-8")
        _jsonl(neural / "predictions.jsonl", pred_rows)

    result = build_report(conditions_root=conditions, predictions_root=predictions,
                          protocol_path=protocol, output_root=tmp_path / "report")
    assert result["common_micro_metrics"]["dual_description_margin"]["micro"]["n"] == 384
    assert result["common_micro_metrics"]["dual_description_margin"]["micro"]["f1"] == 2 / 3
    assert result["common_micro_metrics"]["laya"]["micro"]["f1"] == 1.0
    assert result["conditions"]["C02"]["methods"][0]["metrics"]["balanced_accuracy"] is None
    assert result["description_embedding"]["http_physical_requests"] == 3
    assert result["description_embedding"]["provider_elapsed_ms"] == 12.5
    report = (tmp_path / "report" / "REPORT.md").read_text(encoding="utf-8")
    assert "DS V4.1 Flash" in report
    assert "laya" in report
