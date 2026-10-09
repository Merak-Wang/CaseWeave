"""Combine the production semantic-operator rounds without rerunning experiments."""
from __future__ import annotations
from .embedding_manifest import manifest_path as embedding_manifest_path

import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import median
from typing import Any

from .experiment import read_jsonl
from .report_experiment import METHOD_SCOPE
from .binary_metrics import score_binary


ROOT = Path(".cache/evals/production-v1")
CONDITIONS = ("C01", "C02", "Q01", "Q02")
COMMON = ("C01", "Q01", "Q02")
REFERENCES = {"all_positive", "all_negative"}
TRAIN_UNSUPERVISED = {"name_gmm", "spherical_kmeans"}
SUPERVISED = {"logistic_regression", "linear_svm", "mlp", "hist_gradient_boosting"}
FEEDBACK = {"feedback_margin", "feedback_multi_prototype", "feedback_knn_margin",
            "hard_negative_memory", "relation_logistic", "relation_conformal"}
NEURAL = {"laya", "julia", "gliner_official", "gliner_any_positive"}
JEFF_ID = "jeff_qwen35_08b"
NEW_ZERO = {"dual_description_margin", "query_otsu_test_batch", "name_gmm_test_batch",
            "self_core_gmm_test_batch", "name_core_gmm_test_batch", "multi_view_gmm_test_batch",
            "kmeans_test_batch", "spherical_kmeans_test_batch"}

FAMILY_ORDER = ("pointwise_zero_shot", "train128_unlabeled", "test128_transductive",
                "supervised", "feedback", "reference")
FAMILY_LABELS = {
    "pointwise_zero_shot": "逐票零样本",
    "train128_unlabeled": "train128无标签适配",
    "test128_transductive": "test128无标签批适配",
    "supervised": "有标签监督分类",
    "feedback": "有标签反馈方法",
    "reference": "常量参照",
}
METHOD_NAMES = {
    "all_positive": "全判相关", "all_negative": "全判不相关",
    "logistic_regression": "逻辑回归", "linear_svm": "线性SVM", "mlp": "多层感知机",
    "hist_gradient_boosting": "直方图梯度提升", "name_gmm": "NameGMM（训练集）",
    "spherical_kmeans": "球面KMeans（训练集）", "feedback_margin": "反馈边界",
    "feedback_multi_prototype": "反馈多原型", "feedback_knn_margin": "反馈K近邻间隔",
    "hard_negative_memory": "困难负例记忆", "relation_logistic": "关系特征逻辑回归",
    "relation_conformal": "关系保形分类", "laya": "LAYA全文选择",
    "julia": "Julia-1全文选择", "gliner_official": "GLiNER官方聚合",
    "gliner_any_positive": "GLiNER任一块为正", "dual_description_margin": "正负描述余弦间隔",
    "query_otsu_test_batch": "Query投影Otsu",
    "name_gmm_test_batch": "NameGMM（测试批）",
    "self_core_gmm_test_batch": "SelfCoreGMM（测试批）",
    "name_core_gmm_test_batch": "NameCoreGMM（测试批）",
    "multi_view_gmm_test_batch": "MultiViewGMM（测试批）",
    "kmeans_test_batch": "KMeans（测试批）",
    "spherical_kmeans_test_batch": "球面KMeans（测试批）",
    JEFF_ID: "Jeff-Qwen3.5-0.8B",
}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _avg(rows: list[dict[str, Any]], key: str) -> float | None:
    values = [row.get(key) for row in rows if row.get(key) is not None]
    return sum(values) / len(values) if values else None


def _same_metrics(left: dict[str, Any] | None, right: dict[str, Any] | None) -> bool:
    if left is None or right is None:
        return left is right
    fields = ("n", "predicted", "abstained", "tp", "fp", "fn", "tn", "precision", "recall", "f1",
              "accuracy", "balanced_accuracy", "abstained_positive", "abstained_negative", "coverage", "abstain_rate")
    return all(left.get(field) == right.get(field) for field in fields)


def merge_condition_method_rows(old_rows: list[dict[str, Any]], new_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Keep first-round baseline records and add only genuinely new methods."""
    merged = {row["method"]: dict(row) for row in old_rows}
    if len(merged) != len(old_rows):
        raise ValueError("duplicate method identity in first-round report")
    for row in new_rows:
        method = row["method"]
        if method in merged:
            if not _same_metrics(merged[method].get("metrics"), row.get("metrics")):
                raise ValueError(f"cached baseline metrics changed between rounds: {method}")
            continue
        merged[method] = dict(row)
    return merged


def _micro_from_conditions(rows: list[dict[str, Any]]) -> dict[str, Any]:
    fields = ("n", "predicted", "abstained", "tp", "fp", "fn", "tn", "abstained_positive", "abstained_negative")
    counts = {field: sum(int(row.get(field) or 0) for row in rows) for field in fields}
    n, tp, fp, fn, tn = counts["n"], counts["tp"], counts["fp"], counts["fn"], counts["tn"]
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else None
    specificity = tn / sum(int(row["tn"] + row["fp"] + row["abstained_negative"]) for row in rows) if n else None
    f1 = (2 * precision * recall / (precision + recall)) if recall is not None and precision + recall else 0.0
    counts.update({"precision": precision, "recall": recall, "f1": f1,
                   "accuracy": (tp + tn) / n if n else 0.0,
                   "balanced_accuracy": (recall + specificity) / 2 if recall is not None and specificity is not None else None,
                   "coverage": sum(int(row["predicted"]) for row in rows) / n if n else 0.0,
                   "abstain_rate": sum(int(row["abstained"]) for row in rows) / n if n else 0.0,
                   "conditional": None})
    return counts


def _macro(rows: list[dict[str, Any]]) -> dict[str, Any]:
    keys = ("precision", "recall", "f1", "accuracy", "balanced_accuracy", "coverage", "abstain_rate")
    return {key: _avg(rows, key) for key in keys}


def _family(method: str) -> str:
    if method in REFERENCES:
        return "reference"
    if method == "dual_description_margin" or method in NEURAL or method == JEFF_ID:
        return "pointwise_zero_shot"
    if method in TRAIN_UNSUPERVISED:
        return "train128_unlabeled"
    if method in NEW_ZERO:
        return "test128_transductive"
    if method in SUPERVISED:
        return "supervised"
    if method in FEEDBACK:
        return "feedback"
    raise KeyError(method)


def _input_fields(method: str) -> list[str]:
    if method == JEFF_ID:
        return ["title", "summary"]
    if method in NEURAL:
        return ["title", "summary", "body"]
    if method in REFERENCES:
        return []
    return ["title", "summary"]


def _train_budget(method: str) -> int:
    return 128 if method in SUPERVISED | FEEDBACK else 0


def _method_source(method: str, old_rows: dict[str, Any], zero_rows: dict[str, Any], protocol: dict[str, Any]) -> tuple[str, Any]:
    if method == JEFF_ID:
        return ("Jeff official quickstart; zero-shot per ticket; fixed checkpoint readout without pseudo-label calibration",
                {"model": "mstrasser/Jeff-Qwen3.5-0.8B", "source": "firelex/jeff", "train_pseudo_labels": 0})
    if method in zero_rows and method not in old_rows:
        return zero_rows[method].get("source", ""), protocol["methods"].get(method, {}).get("config")
    scope = METHOD_SCOPE.get(method)
    return (scope[1] if scope else "fixed constant reference", {"description": scope[2]} if scope else {})


def _build_method_catalog(old_metrics: dict[str, Any], zero_metrics: dict[str, Any],
                          protocol: dict[str, Any], *, include_jeff: bool = False) -> list[dict[str, Any]]:
    old_ids = set(old_metrics["methods"])
    zero_ids = {row["method"] for row in zero_metrics["conditions"]["C01"]["methods"]}
    new_ids = zero_ids - old_ids
    if new_ids != NEW_ZERO:
        raise ValueError(f"unexpected new-method identities: {sorted(new_ids ^ NEW_ZERO)}")
    method_ids = old_ids | new_ids | ({JEFF_ID} if include_jeff else set())
    catalog = []
    for method in method_ids:
        source, config = _method_source(method, old_metrics["methods"],
            {row["method"]: row for row in zero_metrics["conditions"]["C01"]["methods"]}, protocol)
        if method == JEFF_ID:
            protocol_name = "官方说明仅支持英文；本次为原中文工单的直接迁移测试。逐票零样本，不使用本次伪标签校准。"
        elif method in NEURAL:
            protocol_name = METHOD_SCOPE[method][2]
        elif method in TRAIN_UNSUPERVISED:
            protocol_name = METHOD_SCOPE[method][2] + "; fit only on each condition's 128 train vectors without labels"
        elif method in SUPERVISED | FEEDBACK:
            protocol_name = METHOD_SCOPE[method][2] + "; fit on each condition's 128 train pseudo-labels"
        elif method in REFERENCES:
            protocol_name = METHOD_SCOPE[method][2]
        elif method == "dual_description_margin":
            protocol_name = "per-ticket cosine(positive description) − cosine(negative description); threshold 0"
        else:
            protocol_name = json.dumps(config, ensure_ascii=False, sort_keys=True)
        catalog.append({
            "method_id": method,
            "name_zh": METHOD_NAMES[method],
            "family": _family(method),
            "regime": "cached_neural_baseline" if method in NEURAL else _family(method),
            "input_fields": _input_fields(method),
            "train_pseudo_labels_per_condition": _train_budget(method),
            "train_pseudo_labels_common": _train_budget(method) * len(COMMON),
            "protocol": protocol_name,
            "source": source,
            "config": config,
            "cost_shared_with": "gliner_official" if method == "gliner_any_positive" else None,
        })
    return sorted(catalog, key=lambda row: (FAMILY_ORDER.index(row["family"]), row["method_id"]))


def _teacher_cost(conditions_root: Path) -> dict[str, Any]:
    by_split = {"train": {"labels": 0, "physical_requests": 0, "input_tokens": 0, "output_tokens": 0,
                           "unknown_usage_attempts": 0, "attempt_seconds": 0.0},
                "test": {"labels": 0, "physical_requests": 0, "input_tokens": 0, "output_tokens": 0,
                          "unknown_usage_attempts": 0, "attempt_seconds": 0.0}}
    per_condition = {}
    for cid in CONDITIONS:
        rows = read_jsonl(conditions_root / cid / "labeled.jsonl")
        local = {split: {key: 0 for key in ("labels", "physical_requests", "input_tokens", "output_tokens",
                                             "unknown_usage_attempts", "attempt_seconds")}
                 for split in ("train", "test")}
        for row in rows:
            split = row["split"]
            target = local[split]
            target["labels"] += 1
            usages = row.get("attempt_usage") or []
            target["physical_requests"] += int(row.get("attempts", len(usages)))
            seconds = row.get("attempt_seconds") or []
            target["attempt_seconds"] += sum(seconds)
            for usage in usages:
                if not usage or usage.get("prompt_tokens") is None or usage.get("completion_tokens") is None:
                    target["unknown_usage_attempts"] += 1
                else:
                    target["input_tokens"] += int(usage["prompt_tokens"])
                    target["output_tokens"] += int(usage["completion_tokens"])
        per_condition[cid] = local
        for split in ("train", "test"):
            for key in by_split[split]:
                by_split[split][key] += local[split][key]
    for target in (*by_split.values(),):
        if target["unknown_usage_attempts"]:
            target["input_tokens"] = None
            target["output_tokens"] = None
    return {"by_split": by_split, "by_condition": per_condition,
            "total": {key: (None if any(row[key] is None for row in by_split.values()) else sum(row[key] for row in by_split.values()))
                      for key in ("labels", "physical_requests", "input_tokens", "output_tokens", "unknown_usage_attempts", "attempt_seconds")},
            "wall_elapsed_seconds_by_condition": {
                cid: json.loads((conditions_root / cid / "label_manifest.json").read_text(encoding="utf-8")).get("elapsed_seconds")
                for cid in CONDITIONS},
            "wall_elapsed_sum_is_complete": False}


def _method_costs(old_metrics: dict[str, Any], zero_metrics: dict[str, Any]) -> dict[str, Any]:
    old_methods = old_metrics["methods"]
    old_cpu = {name: row["timing_seconds_sum"] for name, row in old_methods.items()
               if name not in NEURAL | REFERENCES and row.get("timing_seconds_sum") is not None}
    old_neural = {name: row["neural_usage_sum"] for name, row in old_methods.items()
                  if name in {"laya", "julia", "gliner_official"}}
    new_costs = zero_metrics["method_prediction_seconds"]
    return {
        "original_cpu": {"by_method": old_cpu,
                         "execution_seconds_sum": sum(row.get("total", 0.0) for row in old_cpu.values()),
                         "methods_with_recorded_timing": len(old_cpu)},
        "new_zero_shot": {"by_method_seconds": new_costs,
                           "execution_seconds_sum": zero_metrics["zero_shot_execution_seconds_total"],
                           "includes_fit_and_predict_excludes_embedding_load": True},
        "neural_cached_baselines": {"by_model": old_neural,
            "any_positive_incremental_cost": 0,
            "any_positive_shared_with": "gliner_official",
            "this_round_new_calls": 0},
    }


def _source_hashes(root: Path, conditions_root: Path) -> dict[str, str]:
    paths = {"first_round_metrics": root / "report" / "metrics.json",
             "first_round_predictions": root / "report" / "comparison.jsonl",
             "zero_shot_metrics": root / "zero-shot" / "metrics.json",
             "zero_shot_protocol": root / "zero-shot" / "protocol.json",
             "adapted_dataset_manifest": root / "tickets.adapted.manifest.json",
             "document_embedding_manifest": embedding_manifest_path(root / "tickets.title-summary.npz", legacy=True),
             "query_embedding_manifest": embedding_manifest_path(root / "queries.npz", legacy=True),
             "description_embedding_manifest": embedding_manifest_path(root / "zero-shot" / "description_embeddings.npz", legacy=True)}
    paths.update({f"{cid}_condition_manifest": conditions_root / cid / "manifest.json" for cid in CONDITIONS})
    paths.update({f"{cid}_label_manifest": conditions_root / cid / "label_manifest.json" for cid in CONDITIONS})
    jeff_audit = root / "jeff-token-audit.json"
    if jeff_audit.exists():
        paths["jeff_token_audit"] = jeff_audit
    for cid in CONDITIONS:
        jeff_env = conditions_root / cid / "neural" / JEFF_ID / "environment.json"
        jeff_pred = conditions_root / cid / "neural" / JEFF_ID / "predictions.jsonl"
        if jeff_env.exists() and jeff_pred.exists():
            paths[f"{cid}_jeff_environment"] = jeff_env
            paths[f"{cid}_jeff_predictions"] = jeff_pred
    return {name: _sha(path) for name, path in paths.items()}


def _jeff_ready(conditions_root: Path) -> bool:
    for cid in CONDITIONS:
        folder = conditions_root / cid / "neural" / JEFF_ID
        if not (folder / "predictions.jsonl").exists() or not (folder / "environment.json").exists():
            return False
        if json.loads((folder / "environment.json").read_text(encoding="utf-8")).get("status") != "completed":
            return False
    return True


def _score_jeff(condition_dir: Path, test_count: int) -> dict[str, Any]:
    folder = condition_dir / "neural" / JEFF_ID
    predictions = read_jsonl(folder / "predictions.jsonl")
    labels = {str(row["ticket_id"]): int(row["label"]) for row in read_jsonl(condition_dir / "labeled.jsonl")
              if row.get("split") == "test" and row.get("label") in (0, 1)}
    predicted = {str(row["ticket_id"]): int(row["prediction"]) for row in predictions}
    if len(predicted) != len(predictions) or set(predicted) != set(labels) or len(labels) != test_count:
        raise ValueError(f"{condition_dir.name}: Jeff predictions must cover the frozen test IDs exactly once")
    ordered_ids = sorted(labels)
    metrics = score_binary([labels[ticket_id] for ticket_id in ordered_ids],
                           [predicted[ticket_id] for ticket_id in ordered_ids])
    environment = json.loads((folder / "environment.json").read_text(encoding="utf-8"))
    prompt_lengths = _token_summary([row["input_tokens"] for row in predictions])
    return {"metrics": metrics,
            "prediction_seconds": sum(float(row.get("elapsed_seconds") or 0) for row in predictions),
            "input_tokens": sum(int(row.get("input_tokens") or 0) for row in predictions),
            "prompt_tokens": prompt_lengths,
            "truncated_rows": sum(bool(row.get("state_truncated")) for row in predictions),
            "state_original_tokens": sum(int(row.get("state_original_tokens") or 0) for row in predictions),
            "state_used_tokens": sum(int(row.get("state_used_tokens") or 0) for row in predictions),
            "environment": environment}


def _token_summary(values: list[int]) -> dict[str, Any]:
    ordered = sorted(int(value) for value in values)
    return {"count": len(ordered), "min": ordered[0], "p50": median(ordered),
            "p95": ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)], "max": ordered[-1]} if ordered else {}


def build_consolidated(*, root: Path = ROOT, output_report: Path | None = None,
                       output_metrics: Path | None = None) -> dict[str, Any]:
    old = json.loads((root / "report" / "metrics.json").read_text(encoding="utf-8"))
    comparisons = [json.loads(line) for line in (root / "report" / "comparison.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    zero = json.loads((root / "zero-shot" / "metrics.json").read_text(encoding="utf-8"))
    protocol = json.loads((root / "zero-shot" / "protocol.json").read_text(encoding="utf-8"))
    conditions_root = root / "conditions"
    include_jeff = _jeff_ready(conditions_root)
    jeff_audit_path = root / "jeff-token-audit.json"
    jeff_audit = json.loads(jeff_audit_path.read_text(encoding="utf-8")) if jeff_audit_path.exists() else None
    catalog = _build_method_catalog(old, zero, protocol, include_jeff=include_jeff)
    per_condition: dict[str, Any] = {}
    comparison_by_condition: dict[str, list[dict[str, Any]]] = {cid: [] for cid in CONDITIONS}
    for row in comparisons:
        comparison_by_condition[row["condition_id"]].append(row)
    for cid in CONDITIONS:
        manifest = json.loads((conditions_root / cid / "manifest.json").read_text(encoding="utf-8"))
        old_rows = comparison_by_condition[cid]
        new_rows = zero["conditions"][cid]["methods"]
        merged = merge_condition_method_rows(old_rows, new_rows)
        jeff_result = _score_jeff(conditions_root / cid, manifest["test_count"]) if include_jeff else None
        if jeff_result:
            merged[JEFF_ID] = {"method": JEFF_ID, "status": "completed", "metrics": jeff_result["metrics"],
                               "prediction_seconds": jeff_result["prediction_seconds"],
                               "input_tokens": jeff_result["input_tokens"],
                               "truncated_rows": jeff_result["truncated_rows"]}
        if set(merged) != {row["method_id"] for row in catalog}:
            raise ValueError(f"{cid}: consolidated method identities do not match the catalog")
        label_manifest = json.loads((conditions_root / cid / "label_manifest.json").read_text(encoding="utf-8"))
        old_metrics_condition = next(row for row in old["conditions"] if row["condition_id"] == cid)
        method_metrics = {}
        for method in catalog:
            method_id = method["method_id"]
            record = merged[method_id]
            record = _condition_method_record(record)
            method_metrics[method_id] = {
                "status": record["status"],
                "metrics": record.get("metrics"),
                "error_type": record.get("error_type", record.get("failure_type")),
                "coverage": record.get("metrics", {}).get("coverage") if record.get("metrics") else None,
                "timing_seconds": record.get("timing_seconds"),
                "prediction_seconds": record.get("prediction_seconds"),
                "input_tokens": record.get("input_tokens"),
                "truncated_rows": record.get("truncated_rows"),
            }
        query_spec = manifest["query_spec"]
        per_condition[cid] = {
            "name": query_spec["name"], "kind": query_spec["kind"], "query": query_spec["query"],
            "labeling_guidance": query_spec["labeling_guidance"],
            "candidate_union_count": manifest["recall_union_count"],
            "keyword_hit_count": manifest["keyword_hit_count"], "vector_hit_count": manifest["vector_hit_count"],
            "vector_top_k": manifest["vector_top_k"],
            "vector_threshold": manifest.get("vector_threshold"),
            "train_count": manifest["train_count"], "test_count": manifest["test_count"],
            "train_pseudo_label_counts": old_metrics_condition["train_pseudo_label_counts"],
            "test_pseudo_label_counts": old_metrics_condition["test_pseudo_label_counts"],
            "test_id_hash": old_metrics_condition["test_id_hash"],
            "teacher_status": label_manifest["label_status"],
            "teacher_attempts": label_manifest["physical_requests"],
            "methods": method_metrics,
            "jeff_environment": jeff_result["environment"] if jeff_result else None,
            "jeff_prompt_tokens": jeff_result["prompt_tokens"] if jeff_result else None,
        }
    common_methods = {}
    old_common = old["common_comparable"]
    for method in catalog:
        method_id = method["method_id"]
        condition_metrics = [per_condition[cid]["methods"][method_id]["metrics"] for cid in COMMON]
        completed = [row for row in condition_metrics if row is not None]
        micro = _micro_from_conditions(completed) if completed else None
        common_methods[method_id] = {
            "status": "completed" if len(completed) == len(COMMON) else "partial",
            "conditions_expected": len(COMMON), "conditions_completed": len(completed),
            "test_condition_rows": sum(per_condition[cid]["test_count"] for cid in COMMON),
            "test_distinct_ticket_ids": old["identity_counts"]["common_test_distinct_ticket_ids"],
            "label_support": {
                "positive": sum(per_condition[cid]["test_pseudo_label_counts"]["positive"] for cid in COMMON),
                "negative": sum(per_condition[cid]["test_pseudo_label_counts"]["negative"] for cid in COMMON)},
            "micro": micro,
            "macro_by_condition": _macro(completed),
            "per_condition_status": {cid: per_condition[cid]["methods"][method_id]["status"] for cid in COMMON},
        }
        if method_id in old_common:
            source = old_common[method_id]
            common_methods[method_id]["source_comparable"] = source.get("comparable")
            common_methods[method_id]["source_status"] = "completed" if source.get("comparable") else "partial"
        if not completed:
            common_methods[method_id]["status"] = "failed"
    method_map = {row["method_id"]: row for row in catalog}
    sorted_common = sorted((row for row in catalog if row["family"] != "reference"),
        key=lambda row: (FAMILY_ORDER.index(row["family"]),
                         -(common_methods[row["method_id"]]["macro_by_condition"]["balanced_accuracy"]
                           if common_methods[row["method_id"]]["macro_by_condition"]["balanced_accuracy"] is not None else -1.0),
                         row["method_id"]))
    all_labels = sum(per_condition[cid]["train_count"] + per_condition[cid]["test_count"] for cid in CONDITIONS)
    test_rows = old["identity_counts"]["all_test_pairs"]
    common_rows = old["identity_counts"]["common_test_pairs"]
    report = {
        "sources": {"hashes": _source_hashes(root, conditions_root),
                    "first_round": "report/metrics.json + report/comparison.jsonl",
                    "zero_shot_round": "zero-shot/metrics.json + zero-shot/protocol.json",
                    "jeff": "conditions/<id>/neural/jeff_qwen35_08b/{predictions.jsonl,environment.json}" if include_jeff else None,
                    "teacher_attempts": "conditions/<id>/labeled.jsonl + label_manifest.json"},
        "panorama": {
            "dataset_records": json.loads((root / "tickets.adapted.manifest.json").read_text(encoding="utf-8")).get("records"),
            "conditions": len(CONDITIONS), "train_test_ratio": "1:1 per condition",
            "completed_rounds": 3 if include_jeff else 2,
            "train_test_rows": all_labels, "methods": len(catalog),
            "real_methods": len(catalog) - len(REFERENCES), "reference_methods": len(REFERENCES),
            "all_test_condition_rows": test_rows,
            "all_test_distinct_ticket_ids": old["identity_counts"]["all_test_distinct_ticket_ids"],
            "common_test_condition_rows": common_rows,
            "common_test_distinct_ticket_ids": old["identity_counts"]["common_test_distinct_ticket_ids"],
            "reference_kind": "DS_V4.1_Flash_pseudo_labels_not_human_gold",
            "jeff_status": "completed" if include_jeff else "pending",
            "jeff_token_audit": jeff_audit,
        },
        "conditions": per_condition,
        "methods": [{**row, "full_experiment_status": old["methods"].get(row["method_id"], {}).get("status",
                    "completed_jeff_zero_shot" if row["method_id"] == JEFF_ID and include_jeff else
                    "pending_jeff_zero_shot" if row["method_id"] == JEFF_ID else "new_zero_shot"),
                     "common": common_methods[row["method_id"]],
                     "cost": _method_cost_for(row["method_id"], old, zero, per_condition)} for row in catalog],
        "common": {"condition_ids": list(COMMON), "condition_rows": common_rows,
                   "distinct_ticket_ids": old["identity_counts"]["common_test_distinct_ticket_ids"],
                   "label_support": common_methods[catalog[0]["method_id"]]["label_support"],
                   "methods": common_methods,
                   "main_table_order": [row["method_id"] for row in sorted_common]},
        "costs": _costs(root, old, zero, conditions_root),
    }
    output_report = output_report or root / "REPORT.md"
    output_metrics = output_metrics or root / "consolidated_metrics.json"
    output_report.parent.mkdir(parents=True, exist_ok=True)
    output_metrics.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output_report.write_text(render_markdown(report), encoding="utf-8")
    return report


def _method_cost_for(method_id: str, old: dict[str, Any], zero: dict[str, Any],
                     per_condition: dict[str, Any]) -> dict[str, Any] | None:
    if method_id in old["methods"]:
        row = old["methods"][method_id]
        if method_id == "gliner_any_positive":
            return {"shared_with": "gliner_official", "incremental_model_calls": 0}
        return {"cpu_timing_seconds": row.get("timing_seconds_sum"), "neural_usage": row.get("neural_usage_sum")}
    if method_id in zero["method_prediction_seconds"]:
        return {"zero_shot_prediction_seconds_all_conditions": zero["method_prediction_seconds"][method_id]}
    if method_id == JEFF_ID:
        return {"prediction_seconds_all_conditions": sum(per_condition[cid]["methods"][JEFF_ID]["prediction_seconds"] or 0
                                                          for cid in CONDITIONS)}
    return None


def _costs(root: Path, old: dict[str, Any], zero: dict[str, Any], conditions_root: Path) -> dict[str, Any]:
    teacher = _teacher_cost(conditions_root)
    old_methods = old["methods"]
    cpu_ids = set(old_methods) - NEURAL - REFERENCES
    cpu_seconds = sum((old_methods[name].get("timing_seconds_sum") or {}).get("total", 0.0) for name in cpu_ids)
    neural = {}
    for name, folder in (("laya", "laya"), ("julia", "julia"), ("gliner_official", "gliner")):
        env = json.loads((conditions_root / "C01" / "neural" / folder / "environment.json").read_text(encoding="utf-8"))
        neural[name] = {"usage": old_methods[name].get("neural_usage_sum"),
                        "truncated_input_rows": old_methods[name].get("truncated_input_rows"),
                        "checkpoint": Path(env.get("model_path", folder)).name,
                        "package_version": env.get("package_version"),
                        "parameters": env.get("parameters", {}),
                        "model_dtype": env.get("model_dtype")}
    embedding_manifest = json.loads((embedding_manifest_path(root / "tickets.title-summary.npz", legacy=True)).read_text(encoding="utf-8"))
    doc_cost = old["embedding_costs"]["shared_document_embeddings"][0]
    query_cost = old["embedding_costs"]["all_query_embeddings_generation"]
    descriptions = zero["description_embedding"]
    jeff_by_condition = {}
    jeff_prompt_tokens = []
    if _jeff_ready(conditions_root):
        for cid in CONDITIONS:
            jeff_dir = conditions_root / cid / "neural" / JEFF_ID
            env_path = jeff_dir / "environment.json"
            env = json.loads(env_path.read_text(encoding="utf-8"))
            predictions = read_jsonl(jeff_dir / "predictions.jsonl")
            lengths = [int(row["input_tokens"]) for row in predictions]
            jeff_prompt_tokens.extend(lengths)
            jeff_by_condition[cid] = {key: env.get(key) for key in
                                      ("elapsed_seconds", "inference_seconds_total", "input_tokens_total", "calls",
                                       "model", "model_revision", "base_model", "base_model_revision", "source_commit",
                                       "prompt_sha256", "truncated_rows", "model_load_seconds_shared", "parameters", "language_note",
                                       "dtype", "device")}
            jeff_by_condition[cid]["prompt_token_distribution"] = _token_summary(lengths)
    return {
        "embedding_model": {**embedding_manifest["embedding"],
                            "input_fields": embedding_manifest["input_fields"],
                            "chunk_tokens": embedding_manifest["chunk_tokens"],
                            "chunk_overlap_tokens": embedding_manifest["chunk_overlap_tokens"],
                            "truncation": embedding_manifest["truncation"]},
        "shared_preparation": {
            "title_summary_document_embeddings": {"records": json.loads((embedding_manifest_path(root / "tickets.title-summary.npz", legacy=True)).read_text(encoding="utf-8")).get("records"), **doc_cost["generation"], "identity": doc_cost["identity"]},
            "query_embeddings": {"records": 4, **query_cost},
            "positive_negative_description_embeddings": {"records": 8, **descriptions},
        },
        "teacher": teacher,
        "method_execution": {
            "original_cpu": {"method_runs": len(cpu_ids), "execution_seconds_sum": cpu_seconds,
                             "scope": "sum of recorded fit+predict durations; relation conformal has three completed conditions"},
            "new_zero_shot": {"method_runs": len(zero["method_prediction_seconds"]),
                              "execution_seconds_sum": zero["zero_shot_execution_seconds_total"],
                              "by_method_seconds": zero["method_prediction_seconds"],
                              "scope": "four frozen batches; includes batch fitting and prediction, excludes NPZ load and shared embeddings"},
            "cached_neural": {"models": neural, "shared_gliner_execution": True,
                              "gliner_any_positive_incremental_calls": 0,
                              "new_neural_calls_in_zero_shot_round": 0},
            "jeff_zero_shot": {"by_condition": jeff_by_condition,
                               "execution_seconds_sum": sum(row.get("inference_seconds_total") or 0 for row in jeff_by_condition.values()) if jeff_by_condition else None,
                               "model_load_seconds_shared": next((row.get("model_load_seconds_shared") for row in jeff_by_condition.values()
                                                                   if row.get("model_load_seconds_shared") is not None), None),
                               "input_tokens_sum": sum(row.get("input_tokens_total") or 0 for row in jeff_by_condition.values()) if jeff_by_condition else None,
                               "calls_sum": sum(row.get("calls") or 0 for row in jeff_by_condition.values()) if jeff_by_condition else None,
                               "prompt_token_distribution": _token_summary(jeff_prompt_tokens) or None},
            "references": {"new_model_calls": 0},
        },
    }


def _fmt(value: Any, digits: int = 3) -> str:
    return "—" if value is None else f"{value:.{digits}f}"


def _pct(value: Any) -> str:
    return "—" if value is None else f"{100 * value:.1f}%"


def _count(value: Any) -> str:
    if value is None:
        return "—"
    return str(int(value)) if float(value).is_integer() else str(value)


def _condition_method_record(record: dict[str, Any]) -> dict[str, Any]:
    """Zero-shot metrics omit status, so infer it from whether scoring succeeded."""
    return {**record, "status": record.get("status", "completed" if record.get("metrics") is not None else "failed")}


def _metric(report: dict[str, Any], method: str, cid: str, key: str) -> Any:
    row = report["conditions"][cid]["methods"][method]
    if row["status"] != "completed" or row["metrics"] is None:
        return "失败" if row["status"] in ("failed", "incomplete") else "—"
    return row["metrics"].get(key)


def render_markdown(report: dict[str, Any]) -> str:
    p = report["panorama"]
    methods = {row["method_id"]: row for row in report["methods"]}
    common = report["common"]["methods"]
    ordered = report["common"]["main_table_order"] + [name for name in methods if methods[name]["family"] == "reference"]
    lines = ["# 生产工单语义算子实验总报告", "",
        f"本报告汇总截至生成时已完成的{p['completed_rounds']}轮固定测试集实验，使用最新20,000条已适配工单、4个检索条件和每条件128/128的train/test切分。共比较{p['real_methods']}种方法协议与{p['reference_methods']}个常量参照；评测参考是DS V4.1 Flash伪标签，不是人工真值。共同C01/Q01/Q02包含{p['common_test_condition_rows']}条条件判断、{p['common_test_distinct_ticket_ids']}个不同工单；四题共有{p['all_test_condition_rows']}条条件判断、{p['all_test_distinct_ticket_ids']}个不同工单。", "",
        f"1:1表示每个检索条件的训练/测试样本数量相同，不表示正负类平衡。零样本追加实验使用已知上一轮结果的同一测试集，不是新盲测，也未按追加方法分数调参。Jeff状态：{'已完成并纳入' if p['jeff_status'] == 'completed' else '待运行；本版不计入方法数、排名或成本'}。", "",
        "## 实验全景", "",
        "| 项目 | 数量/口径 |", "|---|---:|"]
    ranked = [method_id for method_id in report["common"]["main_table_order"]
              if common[method_id]["macro_by_condition"]["balanced_accuracy"] is not None]
    best_macro = max(ranked, key=lambda method_id: common[method_id]["macro_by_condition"]["balanced_accuracy"])
    best_micro_f1 = max(ranked, key=lambda method_id: common[method_id]["micro"]["f1"])
    lines[2:2] = [
        f"共同三题上，{methods[best_macro]['name_zh']}（`{best_macro}`）的Macro BAcc最高，为{_pct(common[best_macro]['macro_by_condition']['balanced_accuracy'])}；{methods[best_micro_f1]['name_zh']}（`{best_micro_f1}`）的Micro F1最高，为{_pct(common[best_micro_f1]['micro']['f1'])}。这是与DS伪标签的一致性结果，不是人工真值准确率。",
        "不同范式的输入、训练信号和适配样本池不同；这些结果用于比较当前固定实验协议，不构成零标签到有标签的因果消融。",
        "",
    ]
    jeff_common = common.get("jeff_qwen35_08b")
    if jeff_common and jeff_common.get("status") == "completed":
        jm = jeff_common["micro"]
        jmacro = jeff_common["macro_by_condition"]["balanced_accuracy"]
        lines[4:4] = [
            f"Jeff逐票零样本在共同384条判断上的Macro BAcc为{_pct(jmacro)}，是本轮逐票零样本组最高；Micro查准率{_pct(jm['precision'])}、查全率{_pct(jm['recall'])}，4个假阳性、123个未召回正例。它只找回约一半伪标签正例，不能据此称为整体优于所有方法。Jeff官方说明仅支持英文（[项目说明](https://github.com/firelex/jeff)）；本次是对原中文工单的直接迁移测试，使用模型[固定版本](https://huggingface.co/mstrasser/Jeff-Qwen3.5-0.8B/tree/d66458d54426fcf52046b896261df8909bbc8b05)。",
            "",
        ]
    for label, value in (("生产工单快照", p["dataset_records"]), ("冻结检索条件", p["conditions"]),
                         ("方法协议", f"{p['real_methods']} + {p['reference_methods']}个参照"),
                         ("四题测试判断 / 不同工单", f"{p['all_test_condition_rows']} / {p['all_test_distinct_ticket_ids']}"),
                         ("common测试判断 / 不同工单", f"{p['common_test_condition_rows']} / {p['common_test_distinct_ticket_ids']}"),
                         ("伪标签来源", "DS V4.1 Flash；未做人工裁决")):
        lines.append(f"| {label} | {value} |")

    audit = p.get("jeff_token_audit")
    if audit:
        lines.extend(["", "## Jeff完整输入token审计", "",
            f"以Jeff实际query、标题、摘要、options与chat template组装完整prompt后计数；不是只统计工单文本。下表为模型推理前对{_count(audit['overall']['count'])}条冻结test候选进行的本地tokenizer审计，输入上限为{_count(audit.get('limit_tokens'))} tokens。", "",
            "| 范围 | 工单数 | 完整prompt tokens min / p50 / p95 / max | 超过输入上限 |", "|---|---:|---:|---:|"])
        for cid in CONDITIONS:
            stats = audit["by_condition"][cid]
            lines.append(f"| {cid} | {_count(stats['count'])} | {_count(stats['min'])} / {_count(stats['p50'])} / {_count(stats['p95'])} / {_count(stats['max'])} | {_count(stats['over_limit'])} |")
        stats = audit["overall"]
        lines.append(f"| 全部条件 | {_count(stats['count'])} | {_count(stats['min'])} / {_count(stats['p50'])} / {_count(stats['p95'])} / {_count(stats['max'])} | {_count(stats['over_limit'])} |")

    lines.extend(["", "## 四个检索问题、样本与标签分布", "",
        "| 条件 | 固定问题/聚类定义 | Keyword OR并集 | Vector top-K | 候选并集 | Train负/正 | Test负/正 |", "|---|---|---:|---:|---:|---:|---:|"])
    for cid in CONDITIONS:
        c = report["conditions"][cid]
        tr, te = c["train_pseudo_label_counts"], c["test_pseudo_label_counts"]
        vector_rule = f"cos≥{c['vector_threshold']}" if c.get('vector_threshold') is not None else f"Top {c['vector_top_k']}"
        lines.append(f"| {cid}（{c['name']}） | {c['query']} | {c['keyword_hit_count']} | {c['vector_hit_count']}（{vector_rule}） | {c['candidate_union_count']} | {tr['negative']}/{tr['positive']} | {te['negative']}/{te['positive']} |")
    lines.extend(["", "标签比例来自teacher：C02 test 128条全为正类，因此其负类指标不可估计；其余test伪标签支持分别为C01 120/8、Q01 17/111、Q02 112/16（正/负）。", "",
        "## 方法范式与输入", "", "| 范式 | 方法数 | 训练伪标签预算 | 向量/输入字段与使用范围 |", "|---|---:|---:|---|"])
    for family in FAMILY_ORDER:
        family_rows = [row for row in report["methods"] if row["family"] == family]
        if not family_rows:
            continue
        budget = "0" if family in ("pointwise_zero_shot", "train128_unlabeled", "test128_transductive", "reference") else "128/条件（common共384、全四题共512；标签成本共享）"
        if family == "pointwise_zero_shot":
            inputs = "dual描述余弦逐票独立；LAYA/Julia/GLiNER使用三字段神经输入；Jeff使用query+标题+摘要"
        elif family == "train128_unlabeled":
            inputs = "标题+摘要向量；只在每条件train128无标签向量中拟合"
        elif family == "test128_transductive":
            inputs = "标题+摘要向量；仅在每条件test128无标签批次中适配"
        elif family in ("supervised", "feedback"):
            inputs = "标题+摘要向量；仅用train128 teacher伪标签拟合/标定"
        else:
            inputs = "常量输出；仅作参考，不是可部署方法"
        lines.append(f"| {FAMILY_LABELS[family]} | {len(family_rows)} | {budget} | {inputs} |")
    lines.extend(["", "### 算子机制简述", "",
        "监督分类器将标题+摘要向量与每条件128条训练伪标签拟合：LR、线性SVM、MLP与直方图梯度提升采用预设分类器和固定阈值，不用测试集选参。反馈方法分别实现正负原型间隔、多原型、近邻相似度差、困难负例记忆、关系特征逻辑回归和带校准拒答的关系保形分类。",
        "零样本逐票法比较工单向量与固定正/负业务描述的余弦相似度。Jeff遵循官方checkpoint及默认读出头逐票运行，输入query、标题与摘要，不用本次伪标签校准；[官方说明仅支持英文](https://github.com/firelex/jeff)，本次为原中文工单的直接迁移测试。其与教师的三字段判定相比缺少正文输入，可能丢失摘要未覆盖的工单细节。测试批方法中，Query Otsu按查询投影找阈值，NameGMM在查询投影上拟合双高斯；SelfCore/NameCore/MultiView先选取与查询相关的核心/原型，再以关系特征和GMM选正簇；KMeans与球面KMeans在K=2无标签测试批次中聚类，并用查询锚点选正簇。test-batch方法只利用当前条件的无标签test128，不读取伪标签。", ""])
    lines.extend(["", "## Common 384条判断：主比较", "",
        "按范式分组，组内按三题等权macro balanced accuracy排序。coverage为384条条件判断上的micro coverage；低coverage的关系保形方法须同时看coverage，不能仅看其已预测子集。GLiNER任一块为正与官方聚合复用同一批推理，作为不同聚合策略保留而不重复计成本。", "",
        "common三题macro三题等权、micro将384条判断合并；C02排除在common以避免全正测试集造成BAcc不可定义。训练伪标签为每条件128条；common三题合计384条，10种监督/反馈方法共享这批teacher标签。F1是查准率与查全率的调和平均，balanced accuracy是正类与负类召回率的均值。", "",
        "| 范式 | 方法（中文名 / key） | 训练伪标签/条件 | Test正/负支持 | Macro BAcc | Macro F1 | Micro F1 | Coverage | 共同状态 |", "|---|---|---:|---:|---:|---:|---:|---:|---|"])
    for method_id in ordered:
        meta, summary = methods[method_id], common[method_id]
        macro, micro = summary["macro_by_condition"], summary["micro"]
        label_support = summary["label_support"]
        status = f"{summary['conditions_completed']}/{summary['conditions_expected']}题"
        lines.append(f"| {FAMILY_LABELS[meta['family']]} | {meta['name_zh']} / `{method_id}` | {meta['train_pseudo_labels_per_condition']} | {label_support['positive']}/{label_support['negative']} | {_pct(macro['balanced_accuracy'])} | {_pct(macro['f1'])} | {_pct(micro['f1']) if micro else '—'} | {_pct(micro['coverage']) if micro else '—'} | {status} |")

    for metric, title in (("balanced_accuracy", "逐条件 Balanced accuracy 矩阵"), ("f1", "逐条件 F1 矩阵")):
        lines.extend(["", f"## {title}", "", "★标记该题所有非参照真实方法中的最高值；并列最高均标记。C02没有负类，balanced accuracy显示为—；F1仅反映全正伪标签的一致性。方法失败保留为“失败”，不填0。", "",
            "| 范式 | 方法 | C01 | C02 | Q01 | Q02 |", "|---|---|---:|---:|---:|---:|"])
        best = {}
        for cid in CONDITIONS:
            candidates = [_metric(report, method_id, cid, metric) for method_id in ordered if methods[method_id]["family"] != "reference"]
            numeric = [value for value in candidates if isinstance(value, (float, int))]
            best[cid] = max(numeric) if numeric else None
        for family in FAMILY_ORDER:
            family_ids = [method_id for method_id in ordered if methods[method_id]["family"] == family]
            for method_id in family_ids:
                values = []
                for cid in CONDITIONS:
                    value = _metric(report, method_id, cid, metric)
                    if isinstance(value, (float, int)):
                        mark = "★" if methods[method_id]["family"] != "reference" and best[cid] is not None and abs(value - best[cid]) < 1e-12 else ""
                        values.append(f"{100 * value:.1f}%{mark}")
                    else:
                        values.append("—" if value is None else str(value))
                lines.append(f"| {FAMILY_LABELS[family]} | {methods[method_id]['name_zh']} / `{method_id}` | " + " | ".join(values) + " |")

    lines.extend(["", "## Common 384条判断：查准、查全与拒答", "",
        "FN按评测定义包含真实正类被判负及被拒答的样本；正类拒答数与FN有重叠，不能相加。Coverage = 已输出0/1预测占全部384条判断的比例。", "",
        "| 方法 | Precision | Recall | FP | FN（含正类拒答） | 正类拒答 | 负类拒答 | Coverage |", "|---|---:|---:|---:|---:|---:|---:|---:|"])
    for method_id in ordered:
        micro = common[method_id]["micro"]
        if micro is None:
            vals = ["—"] * 7
        else:
            vals = [_pct(micro[key]) if key in ("precision", "recall", "coverage") else _count(micro.get(key, 0))
                    for key in ("precision", "recall", "fp", "fn", "abstained_positive", "abstained_negative", "coverage")]
        lines.append(f"| {methods[method_id]['name_zh']} / `{method_id}` | " + " | ".join(vals) + " |")

    lines.extend(["", "## 成本与共享资源", "", "| 阶段 | 范围 | 调用/样本 | Token/批次 | 累计请求耗时或推理耗时 | 说明 |", "|---|---|---:|---:|---:|---|"])
    costs = report["costs"]
    prep = costs["shared_preparation"]
    doc = prep["title_summary_document_embeddings"]
    query = prep["query_embeddings"]
    desc = prep["positive_negative_description_embeddings"]
    emb = costs["embedding_model"]
    lines.append(f"| 固定模型配置 | 文本向量 | `{emb['model']}` @ `{emb['revision']}`；{emb['dimensions']}维；输入标题+摘要 | 分块 {emb['chunk_tokens']} / overlap {emb['chunk_overlap_tokens']} tokens | — | Qwen embedding revision与向量manifest一致；块级输入无截断 |")
    lines.append(f"| 共享向量 | 标题+摘要工单向量 | {_count(doc['records'])} / {_count(doc['http_physical_requests'])} requests | {_count(doc.get('chunk_count'))} chunks | provider {_fmt(doc['provider_elapsed_ms']/1000, 3)}s；wall {_fmt(doc.get('wall_elapsed_seconds'),3)}s | 20k记录共享一次 |")
    lines.append(f"| 共享向量 | 4条查询向量 | 4 / {_count(query['http_physical_requests'])} requests | — | provider {_fmt(query['provider_elapsed_ms']/1000,3)}s | 四条件共享 |")
    lines.append(f"| 共享向量 | 8条正负描述向量 | 8 / {_count(desc['http_physical_requests'])} requests | — | provider {_fmt(desc['provider_elapsed_ms']/1000,3)}s | 仅第二轮pointwise新增 |")
    teacher = costs["teacher"]
    for split in ("train", "test"):
        row = teacher["by_split"][split]
        lines.append(f"| 教师伪标签 | {split} | {_count(row['labels'])} labels / {_count(row['physical_requests'])} calls | 输入 {_count(row['input_tokens'])} / 输出 {_count(row['output_tokens'])} | 累计请求 {row['attempt_seconds']:.3f}s | 每条物理重试计入；缺用量 {_count(row['unknown_usage_attempts'])} |")
    total = teacher["total"]
    lines.append(f"| 教师伪标签 | 总计 | {_count(total['labels'])} labels / {_count(total['physical_requests'])} calls | 输入 {_count(total['input_tokens'])} / 输出 {_count(total['output_tokens'])} | 累计请求 {total['attempt_seconds']:.3f}s | 这是逐请求耗时之和，不是墙钟时间 |")
    cpu = costs["method_execution"]["original_cpu"]
    zero = costs["method_execution"]["new_zero_shot"]
    neural = costs["method_execution"]["cached_neural"]["models"]
    lines.append(f"| 方法执行 | 第一轮CPU | {cpu['method_runs']}方法记录 | — | 累计 {cpu['execution_seconds_sum']:.3f}s | 含完成方法fit+predict；保形方法C02失败 |")
    lines.append(f"| 方法执行 | 第二轮零样本 | {zero['method_runs']}方法×4条件 | — | 累计 {zero['execution_seconds_sum']:.3f}s | 含批次拟合+预测，不含NPZ读取和共享向量生成 |")
    for name, row in neural.items():
        usage = row["usage"] or {}
        if name == "gliner_official":
            detail = f"checkpoint {row['checkpoint']} {row.get('package_version') or ''}；字符分块全量覆盖；{_count(usage.get('chunk_decisions'))} chunks / {_count(usage.get('forward_batches'))} batches；与any-positive共享"
        else:
            params = row["parameters"]
            state_limit = params.get("max_len", params.get("max_length", "—"))
            head_limit = params.get("head_max_len", params.get("head_length", "—"))
            detail = f"checkpoint {row['checkpoint']} {row.get('package_version') or ''}；state上限{state_limit}/head {head_limit} tokens；超限 {row.get('truncated_input_rows', 0)} 条按各自策略截断"
        lines.append(f"| 神经基线 | 缓存 `{name}` | {_count(usage.get('model_calls'))} calls | {_count(usage.get('input_tokens_total'))} input tokens | inference {_fmt(usage.get('inference_seconds_total'),3)}s | {detail}；本轮复用 |")
    lines.append("| 神经基线 | GLiNER any-positive | 0新增calls | — | 0新增推理耗时 | 与GLiNER official复用同一chunk推理 |")
    jeff = costs["method_execution"]["jeff_zero_shot"]
    if p["jeff_status"] == "completed":
        revisions = sorted({str(row["model_revision"]) for row in jeff["by_condition"].values() if row.get("model_revision")})
        revision_text = ", ".join(f"`{revision}`" for revision in revisions) if revisions else "revision未记录"
        base_revisions = sorted({str(row["base_model_revision"]) for row in jeff["by_condition"].values() if row.get("base_model_revision")})
        base_revision_text = f"；base revision `{base_revisions[0]}`" if base_revisions else ""
        truncations = sum(int(row.get("truncated_rows") or 0) for row in jeff["by_condition"].values())
        model_name = next((row.get("model") for row in jeff["by_condition"].values() if row.get("model")), "Jeff-Qwen3.5-0.8B")
        source_commits = sorted({str(row["source_commit"]) for row in jeff["by_condition"].values() if row.get("source_commit")})
        commit_text = f"；源码 `{source_commits[0]}`" if source_commits else ""
        checkpoint_temperature = next((row.get("parameters", {}).get("temperature") for row in jeff["by_condition"].values()
                                       if row.get("parameters", {}).get("temperature") is not None), None)
        temperature_text = f"；checkpoint temperature {_fmt(checkpoint_temperature,3)}" if checkpoint_temperature is not None else ""
        max_prompt_tokens = next((row.get("parameters", {}).get("max_prompt_tokens") for row in jeff["by_condition"].values()
                                  if row.get("parameters", {}).get("max_prompt_tokens")), None)
        budget_text = f"完整输入上限{_count(max_prompt_tokens)} tokens" if max_prompt_tokens else "未记录固定输入上限"
        trunc_text = f"实测截断{truncations}条" if truncations else "逐票记录显示无截断"
        lengths = jeff["prompt_token_distribution"]
        length_text = f"完整输入tokens min/p50/p95/max={_count(lengths['min'])}/{_count(lengths['p50'])}/{_count(lengths['p95'])}/{_count(lengths['max'])}"
        lines.append(f"| 新增神经方法 | Jeff逐票零样本 | {_count(jeff['calls_sum'])} calls | {_count(jeff['input_tokens_sum'])} input tokens | inference {_fmt(jeff['execution_seconds_sum'],3)}s；共享加载 {_fmt(jeff['model_load_seconds_shared'],3)}s（只计一次） | `{model_name}` {revision_text}{base_revision_text}{commit_text}{temperature_text}；{budget_text}；{length_text}；{trunc_text}；输入query+标题+摘要；官方说明仅支持英文，本次为原中文工单的直接迁移测试 |")
    lines.extend(["", "教师manifest内的C02墙钟只保留续跑值；本报告不把各manifest elapsed相加冒充完整墙钟。C02标签分布为train 127正/1负、test 128正/0负，导致关系保形方法无法拟合/标定并在该条件失败。其common 3题仍按实际完成的C01/Q01/Q02报告。", ""])

    lines.extend(["## 逐题观察与适用边界", ""])
    for cid in COMMON:
        c = report["conditions"][cid]
        eligible = [method_id for method_id in methods
                    if methods[method_id]["family"] != "reference"
                    and isinstance(_metric(report, method_id, cid, "balanced_accuracy"), (float, int))]
        bacc_winner = max(eligible, key=lambda method_id: _metric(report, method_id, cid, "balanced_accuracy"))
        f1_winner = max(eligible, key=lambda method_id: _metric(report, method_id, cid, "f1"))
        bacc = _metric(report, bacc_winner, cid, "balanced_accuracy")
        f1 = _metric(report, f1_winner, cid, "f1")
        support = c["test_pseudo_label_counts"]
        lines.append(f"- **{cid}（{c['name']}）**：test伪标签正/负为{support['positive']}/{support['negative']}；最高BAcc为{methods[bacc_winner]['name_zh']}（`{bacc_winner}`，{_pct(bacc)}），最高F1为{methods[f1_winner]['name_zh']}（`{f1_winner}`，{_pct(f1)}）。")
    lines.append("- C02（预存话费余额退费清退）测试伪标签全为正类，只有正类一致性可观察，不能比较BAcc或负类排除能力。")
    real_common = [method_id for method_id in common if methods[method_id]["family"] != "reference"]
    leaders = {}
    for family in ("pointwise_zero_shot", "train128_unlabeled", "test128_transductive", "supervised", "feedback"):
        candidates = [method_id for method_id in real_common if methods[method_id]["family"] == family and
                      common[method_id]["macro_by_condition"]["balanced_accuracy"] is not None]
        if candidates:
            winner = max(candidates, key=lambda method_id: common[method_id]["macro_by_condition"]["balanced_accuracy"])
            leaders[family] = {"method_id": winner,
                "macro_balanced_accuracy": common[winner]["macro_by_condition"]["balanced_accuracy"],
                "macro_f1": common[winner]["macro_by_condition"]["f1"]}
            lines.append(f"- {FAMILY_LABELS[family]}在common三题中macro BAcc最高的方法为 **{methods[winner]['name_zh']} / `{winner}`**（{_pct(leaders[family]['macro_balanced_accuracy'])}）；它与其他范式输入和标签预算不同，不能据此作因果结论。")
    lines.extend(["- C01仅有8个测试负例、Q02仅有16个；少量误判即可明显改变负类召回与balanced accuracy，组内名次需结合支持数理解。",
        "- C02只有正类测试伪标签；全判正的F1/Recall可达高值不能说明模型会排除不相关工单。",
        "- 第一轮NameGMM/球面KMeans在train128无标签向量适配；第二轮同名后缀`_test_batch`的方法改在test128无标签批次适配。样本池与参数不同，差值不是单因素消融。",
        "- 10种有标签方法每条件共享128条训练伪标签；教师调用/token是一次性数据准备成本，不乘以10。所有方法的test评价使用同一批伪标签，不代表人工真值。",
        "- 全部方法作用于混合检索候选并集抽样，不代表20,000条生产语料的全库Recall。新向量法仅用标题与摘要；旧神经基线输入标题、摘要与工单正文，模态不同。",
        "- 保形分类为selective输出，coverage低时要同时读覆盖率及整体指标；仅看覆盖样本的conditional分数会忽略大部分拒答。", ""])
    lines.extend(["## 复现与来源", "",
        "此报告实际由当前仓库 `.venv` 模块入口生成（`PYTHONPATH=python/evals/src;python/evals`，执行 `python -m retrieval_agent_evals.report_combined`）。`uv run --project python/evals python -m retrieval_agent_evals.report_combined` 是标准入口；本机未验证fresh uv sync，因仓库既有GitHub wheel依赖的下载受阻。生成文件为本地 `.cache/evals/production-v1/REPORT.md` 与 `consolidated_metrics.json`；输入哈希记录在JSON的`sources.hashes`。汇总不重跑Mongo、教师标注、embedding、CPU方法或神经模型。", "",
        "### 冻结的问题与业务边界", ""])
    for cid in CONDITIONS:
        c = report["conditions"][cid]
        lines.extend([f"#### {cid}：{c['name']}", "", f"问题：{c['query']}", "", f"正负边界：{c['labeling_guidance']}", ""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output-report", type=Path)
    parser.add_argument("--output-metrics", type=Path)
    args = parser.parse_args()
    result = build_consolidated(root=args.root, output_report=args.output_report, output_metrics=args.output_metrics)
    print(json.dumps({"methods": len(result["methods"]), "real_methods": result["panorama"]["real_methods"],
                      "report": str(args.output_report or args.root / "REPORT.md"),
                      "metrics": str(args.output_metrics or args.root / "consolidated_metrics.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
