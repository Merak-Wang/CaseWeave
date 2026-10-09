import json

import pytest

from retrieval_agent_evals import neural_worker
from retrieval_agent_evals.neural_worker import (_gliner_encoder_schema, _gliner_schema, _material,
                                                 _prompts, _selected_test)


def test_neural_worker_projects_test_text_and_does_not_return_teacher_labels(tmp_path):
    (tmp_path / "manifest.json").write_text(json.dumps({"condition_id": "C1", "query": "查找某类工单"}), encoding="utf-8")
    rows = []
    for rank in range(256):
        rows.append({"ticket_id": f"T{rank}", "split": "test" if rank >= 128 else "train",
                     "title": "标题", "summary": "摘要", "body": "原文",
                     "label": rank % 2, "label_source": "deepseek-v4.1-flash"})
    (tmp_path / "candidates.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    test_rows, manifest = _selected_test(tmp_path)

    assert len(test_rows) == 128
    assert set(test_rows[0]) == {"ticket_id", "title", "summary", "body"}
    assert _material(test_rows[0]) == "[标题] 标题\n[摘要] 摘要\n[工单原文] 原文"
    assert manifest["condition_id"] == "C1"


def test_neural_prompts_keep_query_guidance_and_both_boundary_aliases():
    manifest = {"query": "查询完整条件甲", "labeling_guidance": "边界说明乙",
                "positive_criteria": "纳入条件丙", "negative_criteria": "排除条件丁"}
    prompt = _prompts(manifest)["relevant"]
    instructions = prompt["instructions"]
    assert all(value in instructions for value in ("查询完整条件甲", "边界说明乙", "纳入条件丙", "排除条件丁"))
    schema = _gliner_schema(manifest)["relevance"]
    assert schema["labels"] == ["relevant", "irrelevant"]
    assert all(value in schema["label_descriptions"]["relevant"]
               for value in ("查询完整条件甲", "边界说明乙", "纳入条件丙"))
    assert all(value in schema["label_descriptions"]["irrelevant"]
               for value in ("不符合上述检索要求", "排除条件丁"))
    encoder_schema = _gliner_encoder_schema(manifest)["classifications"][0]
    assert encoder_schema["labels"] == schema["labels"]
    assert encoder_schema["label_descriptions"] == schema["label_descriptions"]


def test_batch_runs_remaining_conditions_then_reports_nonzero_failure(monkeypatch, tmp_path):
    conditions = tmp_path / "conditions"
    conditions.mkdir()
    for name in ("Q1", "Q2"):
        case = conditions / name
        case.mkdir()
        (case / "manifest.json").write_text("{}", encoding="utf-8")
    called = []

    def fake_run(method, condition, model, output):
        called.append(condition.name)
        if condition.name == "Q1":
            raise ValueError("truncated")
        return output / "predictions.jsonl"

    monkeypatch.setattr(neural_worker, "run", fake_run)
    monkeypatch.setattr(neural_worker, "_clear_model_cache", lambda: None)
    with pytest.raises(RuntimeError, match="Q1:ValueError"):
        neural_worker.run_many("julia", conditions, tmp_path / "model")
    assert called == ["Q1", "Q2"]
