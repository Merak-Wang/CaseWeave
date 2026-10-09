"""Run frozen zero-shot methods using only test vectors and fixed anchors."""
from __future__ import annotations
from .embedding_manifest import manifest_path as embedding_manifest_path

import argparse
import hashlib
import json
import time
from pathlib import Path
from typing import Any

import numpy as np

from .experiment import digest, read_jsonl
from .zero_shot import ZERO_SHOT_METHODS, predict_batch, predict_one


PRODUCTION = Path(".cache/evals/production-v1")
ZERO_ROOT = PRODUCTION / "zero-shot"
CONDITIONS = ("C01", "C02", "Q01", "Q02")


def _embedding_map(path: Path, key: str) -> tuple[dict[str, int], np.ndarray]:
    archive = np.load(path, allow_pickle=False)
    names = archive[key].tolist()
    return {str(name): index for index, name in enumerate(names)}, archive["vectors"]


def _query_spec_hash(path: Path) -> str:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    payload = json.dumps(manifest["query_spec"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def freeze_protocol(*, conditions_root: Path, embeddings: Path, query_embeddings: Path,
                    class_descriptions: Path, description_embeddings: Path,
                    output: Path) -> dict[str, Any]:
    """Freeze methods, exact description text and all prediction input hashes."""
    descriptions = json.loads(class_descriptions.read_text(encoding="utf-8-sig"))
    expected_descriptions = {f"{cid}:{polarity}" for cid in CONDITIONS for polarity in ("positive", "negative")}
    if {row["condition_id"] for row in descriptions} != expected_descriptions:
        raise ValueError("class descriptions must contain the frozen positive/negative pair for each condition")
    methods = {name: dict(spec) for name, spec in ZERO_SHOT_METHODS.items()}
    if len(methods) != 8:
        raise ValueError("the zero-shot protocol requires exactly eight frozen methods")
    document_manifest = json.loads(embedding_manifest_path(embeddings, legacy=True).read_text(encoding="utf-8"))
    query_manifest = json.loads(embedding_manifest_path(query_embeddings, legacy=True).read_text(encoding="utf-8"))
    description_manifest = json.loads(embedding_manifest_path(description_embeddings, legacy=True).read_text(encoding="utf-8"))
    protocol = {
        "version": 1,
        "conditions": list(CONDITIONS),
        "methods": methods,
        "global_config": {"seed": 0},
        "class_descriptions": descriptions,
        "embedding_identities": {"documents": document_manifest["embedding"],
                                  "queries": query_manifest["embedding"],
                                  "descriptions": description_manifest["embedding"]},
        "files": {
            "query_specs_sha256": {cid: _query_spec_hash(conditions_root / cid / "manifest.json") for cid in CONDITIONS},
            "candidate_sets": {cid: digest(conditions_root / cid / "candidates.jsonl") for cid in CONDITIONS},
            "document_embeddings": digest(embeddings),
            "query_embeddings": digest(query_embeddings),
            "class_descriptions": digest(class_descriptions),
            "description_embeddings": digest(description_embeddings),
        },
        "protocol_scope": {
            "labels_read": False,
            "train_vectors_used": False,
            "independent_methods_are_pointwise": True,
            "transductive_methods_see_only_each_condition_test_batch": True,
            "test_size_per_condition": 128,
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(protocol, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return protocol


def run_condition(condition_dir: Path, *, embeddings: Path, query_embeddings: Path,
                  description_embeddings: Path, protocol_path: Path,
                  output: Path) -> dict[str, Any]:
    """Predict in sorted test-ticket order; never open the label file."""
    protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
    cid = condition_dir.name
    if _query_spec_hash(condition_dir / "manifest.json") != protocol["files"]["query_specs_sha256"][cid]:
        raise ValueError(f"{cid}: frozen query spec changed")
    if digest(condition_dir / "candidates.jsonl") != protocol["files"]["candidate_sets"][cid]:
        raise ValueError(f"{cid}: frozen candidate set changed")
    for path, key in ((embeddings, "document_embeddings"), (query_embeddings, "query_embeddings"),
                      (description_embeddings, "description_embeddings")):
        if digest(path) != protocol["files"][key]:
            raise ValueError(f"{path}: frozen zero-shot input changed")

    test_rows = sorted((row for row in read_jsonl(condition_dir / "candidates.jsonl")
                        if row["split"] == "test"), key=lambda row: str(row["ticket_id"]))
    if len(test_rows) != 128 or len({row["ticket_id"] for row in test_rows}) != 128:
        raise ValueError(f"{cid}: expected 128 unique frozen test candidates")
    vector_index, vector_matrix = _embedding_map(embeddings, "ticket_ids")
    test_ids = [str(row["ticket_id"]) for row in test_rows]
    x_test = np.stack([vector_matrix[vector_index[ticket_id]] for ticket_id in test_ids]).astype(np.float32)
    query_index, query_matrix = _embedding_map(query_embeddings, "condition_ids")
    description_index, description_matrix = _embedding_map(description_embeddings, "condition_ids")
    query_anchor = query_matrix[query_index[cid]]
    positive_anchor = description_matrix[description_index[f"{cid}:positive"]]
    negative_anchor = description_matrix[description_index[f"{cid}:negative"]]

    methods = []
    for name, spec in protocol["methods"].items():
        method_started = time.perf_counter()
        if spec["regime"] == "strict_pointwise":
            scored = [predict_one(vector, positive_anchor, negative_anchor) for vector in x_test]
            scores = np.asarray([item["score"] for item in scored], dtype=np.float64)
            predictions = np.asarray([item["prediction"] for item in scored], dtype=np.int8)
            config = scored[0]["config"]
            fit_scope = "per_test_ticket_no_other_examples"
            regime = "zero_example_independent"
        else:
            result = predict_batch(name, x_test, query_anchor, seed=0)
            scores = np.asarray(result["scores"], dtype=np.float64)
            predictions = np.asarray(result["predictions"], dtype=np.int8)
            config = result["config"]
            fit_scope = "fixed_128_test_vectors_without_labels"
            regime = "zero_label_transductive_batch"
        if scores.shape != (128,) or predictions.shape != (128,):
            raise ValueError(f"{name}: expected one score and prediction per test ticket")
        elapsed = time.perf_counter() - method_started
        methods.append({
            "method": name,
            **spec,
            "implementation_regime": spec["regime"],
            "regime": regime,
            "status": "completed",
            "fit_scope": fit_scope,
            "config": config,
            "prediction_seconds": elapsed,
            "scores": [{"ticket_id": ticket_id, "score": float(score),
                        "input_sha256": hashlib.sha256(
                            f"【标题】{row['title']}\n【摘要】{row['summary']}".encode("utf-8")).hexdigest()}
                       for ticket_id, row, score in zip(test_ids, test_rows, scores, strict=True)],
            "predictions": [{"ticket_id": ticket_id, "prediction": int(prediction),
                             "input_sha256": hashlib.sha256(
                                 f"【标题】{row['title']}\n【摘要】{row['summary']}".encode("utf-8")).hexdigest()}
                            for ticket_id, row, prediction in zip(test_ids, test_rows, predictions, strict=True)],
        })

    input_hashes = {str(row["ticket_id"]): hashlib.sha256(
        f"【标题】{row['title']}\n【摘要】{row['summary']}".encode("utf-8")).hexdigest()
        for row in test_rows}
    result = {
        "condition_id": cid,
        "protocol_sha256": digest(protocol_path),
        "candidate_sha256": digest(condition_dir / "candidates.jsonl"),
        "test_id_sha256": hashlib.sha256("\n".join(test_ids).encode()).hexdigest(),
        "test_count": 128,
        "document_embedding_sha256": protocol["files"]["document_embeddings"],
        "query_embedding_sha256": protocol["files"]["query_embeddings"],
        "description_embedding_sha256": protocol["files"]["description_embeddings"],
        "input_policy": {"labels_read": False, "train_vectors_used": False},
        "input_sha256_by_ticket": input_hashes,
        "methods": methods,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    freeze = sub.add_parser("freeze", help="write the immutable zero-shot protocol")
    freeze.add_argument("--conditions-root", type=Path, default=PRODUCTION / "conditions")
    freeze.add_argument("--embeddings", type=Path, default=PRODUCTION / "tickets.title-summary.npz")
    freeze.add_argument("--query-embeddings", type=Path, default=PRODUCTION / "queries.npz")
    freeze.add_argument("--class-descriptions", type=Path, default=ZERO_ROOT / "class_descriptions.json")
    freeze.add_argument("--description-embeddings", type=Path, default=ZERO_ROOT / "description_embeddings.npz")
    freeze.add_argument("--output", type=Path, default=ZERO_ROOT / "protocol.json")
    predict = sub.add_parser("predict", help="predict using the frozen protocol without labels")
    predict.add_argument("--conditions-root", type=Path, default=PRODUCTION / "conditions")
    predict.add_argument("--embeddings", type=Path, default=PRODUCTION / "tickets.title-summary.npz")
    predict.add_argument("--query-embeddings", type=Path, default=PRODUCTION / "queries.npz")
    predict.add_argument("--description-embeddings", type=Path, default=ZERO_ROOT / "description_embeddings.npz")
    predict.add_argument("--protocol", type=Path, default=ZERO_ROOT / "protocol.json")
    predict.add_argument("--output-root", type=Path, default=ZERO_ROOT / "predictions")
    args = parser.parse_args()
    if args.command == "freeze":
        protocol = freeze_protocol(conditions_root=args.conditions_root, embeddings=args.embeddings,
            query_embeddings=args.query_embeddings, class_descriptions=args.class_descriptions,
            description_embeddings=args.description_embeddings, output=args.output)
        print(json.dumps({"protocol": str(args.output), "methods": len(protocol["methods"])}))
        return 0
    for cid in CONDITIONS:
        result = run_condition(args.conditions_root / cid, embeddings=args.embeddings,
            query_embeddings=args.query_embeddings, description_embeddings=args.description_embeddings,
            protocol_path=args.protocol, output=args.output_root / f"{cid}.json")
        print(json.dumps({"condition_id": cid, "methods": len(result["methods"]), "test_count": result["test_count"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
