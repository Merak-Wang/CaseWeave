import json

import numpy as np
from threadpoolctl import threadpool_limits

from retrieval_agent_evals.run_zero_shot import freeze_protocol, run_condition
from retrieval_agent_evals.zero_shot import ZERO_SHOT_METHODS


CONDITIONS = ("C01", "C02", "Q01", "Q02")


def _write_jsonl(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def _fixture(tmp_path):
    rng = np.random.default_rng(321)
    root = tmp_path / "conditions"
    root.mkdir()
    doc_ids = []
    doc_vectors = []
    for cid in CONDITIONS:
        case = root / cid
        case.mkdir()
        query_spec = {"condition_id": cid, "query": f"query {cid}", "labeling_guidance": f"guidance {cid}"}
        (case / "manifest.json").write_text(json.dumps({"condition_id": cid, "query_spec": query_spec}), encoding="utf-8")
        train = rng.normal(size=(128, 8)).astype(np.float32)
        test = np.vstack([
            rng.normal(loc=1.0, scale=0.2, size=(64, 8)),
            rng.normal(loc=-1.0, scale=0.2, size=(64, 8)),
        ]).astype(np.float32)
        ids = [f"{cid}-train-{i:03}" for i in range(128)] + [f"{cid}-test-{i:03}" for i in range(128)]
        rows = [{"ticket_id": ticket_id, "split": "train", "label": i % 2,
                 "title": f"train title {i}", "summary": f"train summary {i}"}
                for i, ticket_id in enumerate(ids[:128])]
        rows += [{"ticket_id": ticket_id, "split": "test", "label": i % 2,
                  "title": f"test title {i}", "summary": f"test summary {i}"}
                 for i, ticket_id in enumerate(ids[128:])]
        _write_jsonl(case / "candidates.jsonl", rows)
        doc_ids.extend(ids)
        doc_vectors.extend(np.vstack([train, test]))
    embeddings = tmp_path / "tickets.npz"
    np.savez(embeddings, ticket_ids=np.asarray(doc_ids), vectors=np.asarray(doc_vectors, dtype=np.float32))
    embeddings.with_suffix(".manifest.json").write_text(json.dumps({"embedding": {"model": "fixture-doc"}}), encoding="utf-8")
    queries = tmp_path / "queries.npz"
    np.savez(queries, condition_ids=np.asarray(CONDITIONS),
             vectors=np.tile(np.asarray([[1.0, 0, 0, 0, 0, 0, 0, 0]], dtype=np.float32), (4, 1)))
    queries.with_suffix(".manifest.json").write_text(json.dumps({"embedding": {"model": "fixture-query"}}), encoding="utf-8")
    descriptions = tmp_path / "descriptions.json"
    descriptions.write_text(json.dumps([
        {"condition_id": f"{cid}:{side}", "query": f"{side} description {cid}"}
        for cid in CONDITIONS for side in ("positive", "negative")
    ]), encoding="utf-8")
    description_embeddings = tmp_path / "description-embeddings.npz"
    anchors = np.tile(np.asarray([[1.0, 0, 0, 0, 0, 0, 0, 0]], dtype=np.float32), (8, 1))
    anchors[1::2] *= -1
    description_ids = [f"{cid}:{side}" for cid in CONDITIONS for side in ("positive", "negative")]
    np.savez(description_embeddings, condition_ids=np.asarray(description_ids), vectors=anchors)
    description_embeddings.with_suffix(".manifest.json").write_text(json.dumps({"embedding": {"model": "fixture-descriptions"}}), encoding="utf-8")
    protocol = tmp_path / "protocol.json"
    output = tmp_path / "out.json"
    return {"root": root, "embeddings": embeddings, "queries": queries,
            "descriptions": descriptions, "description_embeddings": description_embeddings,
            "protocol": protocol, "output": output}


def _freeze(paths):
    freeze_protocol(conditions_root=paths["root"], embeddings=paths["embeddings"],
                    query_embeddings=paths["queries"], class_descriptions=paths["descriptions"],
                    description_embeddings=paths["description_embeddings"], output=paths["protocol"])


def _run(paths):
    return run_condition(paths["root"] / "C01", embeddings=paths["embeddings"],
                         query_embeddings=paths["queries"], description_embeddings=paths["description_embeddings"],
                         protocol_path=paths["protocol"], output=paths["output"])


def _by_method(result):
    return {row["method"]: row for row in result["methods"]}


def _assert_predictions_equal(first, second):
    a, b = _by_method(first), _by_method(second)
    assert set(a) == set(b) == set(ZERO_SHOT_METHODS)
    for name in a:
        assert {row["ticket_id"]: row["prediction"] for row in a[name]["predictions"]} == {
            row["ticket_id"]: row["prediction"] for row in b[name]["predictions"]}
        assert {row["ticket_id"]: row["score"] for row in a[name]["scores"]} == {
            row["ticket_id"]: row["score"] for row in b[name]["scores"]}


def test_public_run_condition_ignores_labels_and_train_rows_and_is_id_stable(tmp_path):
    paths = _fixture(tmp_path)
    _freeze(paths)
    with threadpool_limits(limits=1):
        baseline = _run(paths)

        # No label file exists; altering embedded pseudo-label values also leaves the protocol's predictions alone.
        case = paths["root"] / "C01"
        rows = [json.loads(line) for line in (case / "candidates.jsonl").read_text(encoding="utf-8").splitlines()]
        for row in rows:
            row["label"] = 1 - row["label"]
        _write_jsonl(case / "candidates.jsonl", rows)
        _freeze(paths)
        relabeled = _run(paths)
        _assert_predictions_equal(baseline, relabeled)

        # Replace all training text and vectors, then remove train rows and their vectors entirely.
        rows = [json.loads(line) for line in (case / "candidates.jsonl").read_text(encoding="utf-8").splitlines()]
        for row in rows:
            if row["split"] == "train":
                row["title"], row["summary"] = "changed train text", "changed train metadata"
        _write_jsonl(case / "candidates.jsonl", rows)
        archive = np.load(paths["embeddings"], allow_pickle=False)
        ids, vectors = archive["ticket_ids"].tolist(), archive["vectors"].copy()
        archive.close()
        train_mask = np.asarray([not ticket_id.startswith("C01-train-") for ticket_id in ids])
        vectors[np.asarray([ticket_id.startswith("C01-train-") for ticket_id in ids])] += 100
        np.savez(paths["embeddings"], ticket_ids=np.asarray(ids)[train_mask], vectors=vectors[train_mask])
        _freeze(paths)
        changed_train = _run(paths)
        _assert_predictions_equal(baseline, changed_train)

        rows = [row for row in rows if row["split"] == "test"]
        _write_jsonl(case / "candidates.jsonl", list(reversed(rows)))
        archive = np.load(paths["embeddings"], allow_pickle=False)
        ids, vectors = archive["ticket_ids"].tolist(), archive["vectors"].copy()
        archive.close()
        order = np.arange(len(ids))[::-1]
        np.savez(paths["embeddings"], ticket_ids=np.asarray(ids)[order], vectors=vectors[order])
        _freeze(paths)
        reordered_without_train = _run(paths)
        _assert_predictions_equal(baseline, reordered_without_train)


def test_public_run_condition_pointwise_score_is_independent_of_other_test_vectors(tmp_path):
    paths = _fixture(tmp_path)
    _freeze(paths)
    with threadpool_limits(limits=1):
        baseline = _run(paths)
        archive = np.load(paths["embeddings"], allow_pickle=False)
        ids, vectors = archive["ticket_ids"].tolist(), archive["vectors"].copy()
        archive.close()
        target_id = "C01-test-000"
        changed_id = "C01-test-001"
        vectors[ids.index(changed_id)] *= -10
        np.savez(paths["embeddings"], ticket_ids=np.asarray(ids), vectors=vectors)
        _freeze(paths)
        changed = _run(paths)
    first = _by_method(baseline)["dual_description_margin"]
    second = _by_method(changed)["dual_description_margin"]
    score = lambda method: next(row["score"] for row in method["scores"] if row["ticket_id"] == target_id)
    prediction = lambda method: next(row["prediction"] for row in method["predictions"] if row["ticket_id"] == target_id)
    assert score(first) == score(second)
    assert prediction(first) == prediction(second)
