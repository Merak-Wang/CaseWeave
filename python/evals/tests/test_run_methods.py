import json

import numpy as np
import pytest

from retrieval_agent_evals.operators import METHODS
from retrieval_agent_evals.run_methods import run_condition


def test_test_label_flip_never_changes_any_operator_prediction(tmp_path):
    rng = np.random.default_rng(29)
    vectors = rng.normal(size=(256, 12)).astype(np.float32)
    ticket_ids = [f"ticket-{i:03}" for i in range(256)]
    vectors_path = tmp_path / "tickets.npz"
    np.savez(vectors_path, ticket_ids=np.asarray(ticket_ids), vectors=vectors)
    document_timing = {"http_physical_requests": 88, "provider_elapsed_ms": 1200.5,
                       "wall_elapsed_seconds": 2.3, "chunk_count": 902}
    vectors_path.with_suffix(".manifest.json").write_text(json.dumps({"embedding": {"model": "document-model"}, **document_timing}))
    query_path = tmp_path / "queries.npz"
    np.savez(query_path, condition_ids=np.asarray(["C01"]), vectors=np.asarray([rng.normal(size=12)], dtype=np.float32))
    query_timing = {"http_physical_requests": 1, "provider_elapsed_ms": 35.2}
    query_path.with_suffix(".manifest.json").write_text(json.dumps({"embedding": {"model": "query-model"}, **query_timing}))

    base_rows = []
    for i, ticket_id in enumerate(ticket_ids):
        base_rows.append({"ticket_id": ticket_id, "split": "train" if i < 128 else "test",
                          "label": int((i % 4) < 2), "title": f"标题{i}", "summary": f"摘要{i}", "body": f"正文{i}"})
    outputs = []
    for turn in (0, 1):
        condition_dir = tmp_path / f"condition-{turn}"
        condition_dir.mkdir()
        rows = [dict(row) for row in base_rows]
        if turn:
            for row in rows[128:]:
                row["label"] = 1 - row["label"]
        (condition_dir / "labeled.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        (condition_dir / "manifest.json").write_text(json.dumps({"condition_id": "C01"}), encoding="utf-8")
        outputs.append(run_condition(condition_dir, vectors_path, query_path, tmp_path / f"result-{turn}.json"))

    assert len(METHODS) == 12
    assert all(result["operator_count"] == 12 for result in outputs)
    for first, second in zip(outputs[0]["methods"], outputs[1]["methods"], strict=True):
        assert first["method"] == second["method"]
        assert first["status"] == second["status"] == "completed"
        assert [row["prediction"] for row in first["predictions"]] == [row["prediction"] for row in second["predictions"]]
        assert first["test_scores"] == second["test_scores"]
    assert outputs[0]["embedding_generation"] == {"document": document_timing, "query": query_timing}
    assert outputs[0]["group_holdout_verified"] and outputs[0]["group_count"] == 256
    assert outputs[0]["split_seed"] is None and outputs[0]["split_mode"] == "imported_verified_holdout"


@pytest.mark.parametrize('known_training_classes', ['binary', 'single', 'none'])
def test_null_teacher_labels_excluded_from_fit_and_preserved_in_coverage(tmp_path, monkeypatch, known_training_classes):
    import retrieval_agent_evals.run_methods as runner
    condition = tmp_path / 'condition'
    condition.mkdir()
    ids = [f'synthetic-{i}' for i in range(256)]
    x = np.eye(256, dtype=np.float32)
    vectors = tmp_path / 'vectors.npz'
    queries = tmp_path / 'queries.npz'
    np.savez(vectors, ticket_ids=np.asarray(ids), vectors=x)
    np.savez(queries, condition_ids=np.asarray(['C01']), vectors=x[:1])
    rows = []
    for i, ident in enumerate(ids):
        label = None if i % 4 == 0 else i % 2
        if i < 128 and known_training_classes == 'single':
            label = None if label is None else 1
        if i < 128 and known_training_classes == 'none':
            label = None
        rows.append({'ticket_id': ident, 'split': 'train' if i < 128 else 'test', 'label': label, 'body': f'synthetic body {i}'})
    (condition / 'labeled.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
    (condition / 'manifest.json').write_text(json.dumps({'condition_id': 'C01'}), encoding='utf-8')
    calls = []
    class FakeFitted:
        threshold = .5
        def predict(self, test): return np.ones(len(test), dtype=np.int8)
        def predict_selective(self, test, alpha): return self.predict(test)
        def score(self, test): return np.full(len(test), .8)
    def check_fit(name, train, labels, **kwargs):
        calls.append((name, len(train), labels))
        unsupervised = name in {'name_gmm', 'spherical_kmeans'}
        if unsupervised:
            assert len(train) == 128 and labels is None
        else:
            assert len(train) == (0 if known_training_classes == 'none' else 96)
            assert np.all(labels >= 0)
            if known_training_classes != 'binary':
                raise ValueError('synthetic insufficient training classes')
        return FakeFitted()
    monkeypatch.setattr(runner, 'fit_operator', check_fit)
    result = runner.run_condition(condition, vectors, queries, tmp_path / 'result.json')
    assert result['operator_count'] == len(calls) == len(METHODS)
    assert result['test_pseudo_label_counts']['unknown'] == 32
    for method in result['methods']:
        metrics = method['test_metrics']
        assert metrics['reference_count'] == 96 and metrics['reference_coverage'] == .75
        assert sum(row['pseudo_label'] is None for row in method['predictions']) == 32
        failed = known_training_classes != 'binary' and method['method'] not in {'name_gmm', 'spherical_kmeans'}
        assert method['status'] == ('failed' if failed else 'completed')
        assert metrics['coverage'] == (0 if failed else 1)
        assert {row['prediction'] for row in method['predictions']} == ({-1} if failed else {1})


@pytest.mark.parametrize("collision", ["business", "canonical"])
def test_group_leak_is_rejected_before_loading_vectors_or_fitting(tmp_path, monkeypatch, collision):
    import retrieval_agent_evals.run_methods as runner
    condition = tmp_path / "condition"
    condition.mkdir()
    rows = [{"ticket_id": "train", "split": "train", "label": 1, "title": "same", "summary": "summary", "body": "raw-a"},
            {"ticket_id": "test", "split": "test", "label": 0, "title": "different", "summary": "summary", "body": "raw-b"}]
    if collision == "business":
        rows[1]["ticket_id"] = rows[0]["ticket_id"]
    else:
        rows[1]["title"] = rows[0]["title"]
    (condition / "labeled.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    def forbidden(*args, **kwargs): raise AssertionError("Leaking experiment must not load vectors or fit")
    monkeypatch.setattr(runner.np, "load", forbidden)
    monkeypatch.setattr(runner, "fit_operator", forbidden)
    with pytest.raises(ValueError, match="crosses train/test"):
        runner.run_condition(condition, tmp_path / "missing.npz", tmp_path / "missing-query.npz", tmp_path / "out.json")
    assert not (tmp_path / "out.json").exists()
