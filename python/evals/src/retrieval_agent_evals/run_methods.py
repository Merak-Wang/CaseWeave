"""Fit the registered operators on frozen train labels and score test agreement."""
from __future__ import annotations
from .embedding_manifest import manifest_path as embedding_manifest_path

import argparse
import json
import hashlib
import time
from pathlib import Path
from typing import Any

import numpy as np

from .binary_metrics import score_binary
from .experiment import read_jsonl, validate_group_holdout
from .operators import METHODS, fit_operator


def _reference_labels(rows: list[dict]) -> np.ndarray:
    values = [row.get("label") for row in rows]
    if any(value is not None and value not in {-1, 0, 1} for value in values):
        raise ValueError("Pseudo labels must be binary or unknown (null/-1)")
    return np.asarray([-1 if value is None else value for value in values], dtype=np.int8)


def _prediction_rows(rows: list[dict], predictions: np.ndarray, references: np.ndarray) -> list[dict]:
    return [{"ticket_id": row["ticket_id"], "prediction": int(value),
             "pseudo_label": int(reference) if reference >= 0 else None}
            for row, value, reference in zip(rows, predictions, references, strict=True)]


def run_condition(condition_dir: Path, embeddings_file: Path, query_embeddings_file: Path,
                  output: Path, *, seed: int = 0, conformal_alpha: float = 0.1) -> dict[str, Any]:
    rows = read_jsonl(condition_dir / "labeled.jsonl")
    holdout = validate_group_holdout(rows)
    train = [row for row in rows if row["split"] == "train"]
    test = [row for row in rows if row["split"] == "test"]
    if len(train) != 128 or len(test) != 128:
        raise ValueError(f"Expected frozen 128/128 train/test, got {len(train)}/{len(test)}")
    vectors = np.load(embeddings_file, allow_pickle=False)
    all_ids = vectors["ticket_ids"].tolist()
    vector_matrix = vectors["vectors"]
    vector_map = {ticket_id: vector_matrix[i] for i, ticket_id in enumerate(all_ids)}
    if any(row["ticket_id"] not in vector_map for row in rows):
        raise ValueError("A candidate is missing from the production corpus embeddings")
    query_data = np.load(query_embeddings_file, allow_pickle=False)
    condition_manifest = json.loads((condition_dir / "manifest.json").read_text(encoding="utf-8"))
    condition_id = condition_manifest["condition_id"]
    query_ids = query_data["condition_ids"].tolist()
    if condition_id not in query_ids:
        raise ValueError(f"No query anchor for {condition_id}")
    anchor = query_data["vectors"][query_ids.index(condition_id)]
    x_train = np.stack([vector_map[row["ticket_id"]] for row in train]).astype(np.float32)
    x_test = np.stack([vector_map[row["ticket_id"]] for row in test]).astype(np.float32)
    y_train = _reference_labels(train)
    y_test = _reference_labels(test)
    known_train = y_train >= 0
    results = []
    for name in METHODS:
        unsupervised = name in {"name_gmm", "spherical_kmeans"}
        started = time.perf_counter()
        try:
            # 无反馈方法保留所有向量；教师失败样本从监督训练中排除，不补成负例。
            fitted = fit_operator(name, x_train if unsupervised else x_train[known_train],
                                  None if unsupervised else y_train[known_train], anchor=anchor, seed=seed)
            fit_seconds = time.perf_counter() - started
            predict_started = time.perf_counter()
            predictions = fitted.predict_selective(x_test, alpha=conformal_alpha) if name == "relation_conformal" else fitted.predict(x_test)
            scores = fitted.score(x_test)
            predict_seconds = time.perf_counter() - predict_started
            results.append({"method": name, "status": "completed",
                            "fit_input_records": len(train) if unsupervised else int(known_train.sum()),
                            "learning_signal": "unlabeled_train_vectors_plus_query_anchor" if unsupervised else "train_pseudo_labels",
                            "threshold": None if name == "relation_conformal" else float(fitted.threshold),
                            "threshold_source": "predefined method rule; no test tuning",
                            "config": {"seed": seed, "conformal_alpha": conformal_alpha if name == "relation_conformal" else None},
                            "timing_seconds": {"fit": fit_seconds, "predict_and_score": predict_seconds,
                                               "total": fit_seconds + predict_seconds},
                            "test_metrics": score_binary(y_test, predictions),
                            "test_scores": [float(value) for value in scores],
                            "predictions": _prediction_rows(test, predictions, y_test)})
        except Exception as error:
            fit_seconds = time.perf_counter() - started
            # 训练/预测失败是内部unknown，不能发布同类常量或伪造负例。
            unknown_predictions = np.full(len(test), -1, dtype=np.int8)
            results.append({"method": name, "status": "failed",
                            "fit_input_records": len(train) if unsupervised else int(known_train.sum()),
                            "error_type": type(error).__name__, "error_message": str(error),
                            "learning_signal": "unlabeled_train_vectors_plus_query_anchor" if unsupervised else "train_pseudo_labels",
                            "timing_seconds": {"fit_and_failure": fit_seconds, "total": fit_seconds},
                            "test_metrics": score_binary(y_test, unknown_predictions),
                            "test_scores": None, "predictions": _prediction_rows(test, unknown_predictions, y_test)})
    em = json.loads(embedding_manifest_path(embeddings_file, legacy=True).read_text(encoding="utf-8")) if embedding_manifest_path(embeddings_file, legacy=True).exists() else None
    query_manifest_path = embedding_manifest_path(query_embeddings_file, legacy=True)
    qm = json.loads(query_manifest_path.read_text(encoding="utf-8")) if query_manifest_path.exists() else None
    timing_fields = ("http_physical_requests", "provider_elapsed_ms", "wall_elapsed_seconds", "chunk_count")
    embedding_generation = {
        "document": {key: em[key] for key in timing_fields if key in em} if em else None,
        "query": {key: qm[key] for key in timing_fields if key in qm} if qm else None,
    }
    result = {
        "condition_id": condition_id,
        "reference_kind": "DS_V4.1_Flash_pseudo_labels_not_human_gold",
        "test_scope": "fixed_128_candidate_test_split",
        **holdout,
        "split_seed": condition_manifest.get("split_seed"),
        "split_mode": condition_manifest.get("split_mode", "imported_verified_holdout"),
        "test_split_hash": hashlib.sha256("\n".join(sorted(row["ticket_id"] for row in test)).encode()).hexdigest(),
        "embedding_identity": em.get("embedding") if em else None,
        "embedding_generation": embedding_generation if any(embedding_generation.values()) else None,
        "query_embedding_identity": qm.get("embedding") if qm else None,
        "train_pseudo_label_counts": {"irrelevant": int((y_train == 0).sum()), "relevant": int((y_train == 1).sum()),
                                      "unknown": int((y_train < 0).sum())},
        "test_pseudo_label_counts": {"irrelevant": int((y_test == 0).sum()), "relevant": int((y_test == 1).sum()),
                                     "unknown": int((y_test < 0).sum())},
        "operator_count": len(results),
        "recall_scope": "candidate pool only; full-corpus recall is unknown without complete human qrels",
        "methods": results,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--condition", type=Path, required=True)
    parser.add_argument("--embeddings", type=Path, required=True)
    parser.add_argument("--query-embeddings", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--conformal-alpha", type=float, default=0.1)
    args = parser.parse_args()
    result = run_condition(args.condition, args.embeddings, args.query_embeddings, args.output,
                           seed=args.seed, conformal_alpha=args.conformal_alpha)
    print(json.dumps({"condition_id": result["condition_id"], "operator_count": result["operator_count"],
                      "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
