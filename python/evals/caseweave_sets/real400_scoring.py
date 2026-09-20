"""Score complete CaseWeave result sets. Python standard library only.

The reference data stays outside the product. This module never runs a teacher,
retriever, classifier, or substitute agent.
"""
from __future__ import annotations

import json
from pathlib import Path
from statistics import mean
from typing import Any



def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8-sig") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def prf(tp: int, returned: int, positives: int) -> dict[str, float | None]:
    precision = tp / returned if returned else float(positives == 0)
    recall = tp / positives if positives else None
    if positives == 0:
        f1 = float(returned == 0)
    else:
        f1 = 2 * tp / (returned + positives)
    return {"precision": precision, "recall": recall, "f1": f1}


def score_query(ref: dict[str, Any], prediction: dict[str, Any] | None) -> dict[str, Any]:
    pos, neg, unclear = (set(ref[k]) for k in ("relevant_ids", "nonrelevant_ids", "insufficient_ids"))
    universe = pos | neg | unclear
    base = {"query_id": ref["query_id"], "title": ref["title"],
            "reference_positives": len(pos), "reference_insufficient": len(unclear),
            "reference_scope_size": len(universe)}
    if prediction is None or prediction.get("execution_status") == "not_run":
        return {**base, "execution_status": "not_run", "metrics": None,
                "set_evaluation_pass": False, "report_semantics": "not_graded"}
    status = prediction.get("execution_status", "unspecified")
    raw = prediction["returned_ids"]
    returned = set(raw)
    hit, fp, unsupported, outside = returned & pos, returned & neg, returned & unclear, returned - universe
    missed = pos - returned
    # Strict precision counts unsupported/out-of-scope confirmations against the
    # returned set. Unknown source facts are NOT relabeled as known negatives.
    metrics = prf(len(hit), len(returned), len(pos))
    binary_p = len(hit) / (len(hit) + len(fp)) if hit or fp else None
    metrics["known_binary_precision"] = binary_p
    duplicates = len(raw) - len(returned)
    unresolved_raw = prediction.get("unresolved_ids")
    unresolved = set(unresolved_raw or [])
    overlap = returned & unresolved
    exact = returned == pos
    diagnostics = {
        "tp": len(hit), "fp_known_negative": len(fp), "fn": len(missed),
        "unsupported_accepts": len(unsupported), "out_of_scope_count": len(outside),
        "returned_unique_count": len(returned), "duplicate_count": duplicates,
        "accepted_and_unresolved_overlap": sorted(overlap),
        "false_positive_ids": sorted(fp), "false_negative_ids": sorted(missed),
        "unsupported_ids": sorted(unsupported), "out_of_scope_ids": sorted(outside),
        "unresolved_supplied": unresolved_raw is not None,
        "unresolved_gold_positive_count": len(unresolved & pos) if unresolved_raw is not None else None,
        "unresolved_insufficient_recall": len(unresolved & unclear) / len(unclear)
            if unresolved_raw is not None and unclear else None,
        "unresolved_out_of_scope_ids": sorted(unresolved - universe),
    }
    group_recall = {name: len(returned & set(ids)) / len(ids)
                    for name, ids in ref.get("subgroups", {}).items() if ids}
    # Optional product telemetry: absence remains unknown, never zero.
    usage = {k: prediction.get(k) for k in ("elapsed_seconds", "fit_count", "model_requests",
              "input_tokens", "output_tokens", "teacher_record_count")}
    teacher_raw = prediction.get("teacher_judged_ids")
    scored_raw = prediction.get("scored_ids")
    usage["teacher_unique_ids_observed"] = len(set(teacher_raw) & universe) if teacher_raw is not None else None
    usage["scored_domain_count"] = len(set(scored_raw) & universe) if scored_raw is not None else None
    usage["scored_domain_recall"] = len(set(scored_raw) & pos) / len(pos) if scored_raw is not None and pos else None
    ml = prediction.get("ml_predictions")
    ml_result = None
    if ml is not None and teacher_raw is not None:
        uncalled = set(ml) & universe - set(teacher_raw)
        evaluated = uncalled & (pos | neg)
        ml_positive = {i for i in evaluated if ml[i] == 1}
        ml_result = {"inferred_without_teacher_count": len(uncalled), "known_binary_evaluated": len(evaluated),
                     "reference_positives_in_domain": len(evaluated & pos),
                     "tp": len(ml_positive & pos), "fp": len(ml_positive & neg),
                     "fn": len((evaluated & pos) - ml_positive),
                     "scope": "only actually ML-predicted IDs not teacher-judged in this task",
                     **prf(len(ml_positive & pos), len(ml_positive), len(evaluated & pos))}
    report_count = prediction.get("report_confirmed_count")
    count_match = report_count == len(returned) if report_count is not None else None
    delivered_cleanly = not duplicates and not outside and not overlap and not (unresolved - universe)
    return {**base, "execution_status": status, "metrics": metrics, **diagnostics,
            "reference_set_exact_match": exact,
            "set_evaluation_pass": status == "completed" and exact and delivered_cleanly,
            "subgroup_recall": group_recall,
            "worst_subgroup_recall": min(group_recall.values()) if group_recall else None,
            "report_count_matches_result": count_match,
            "report_semantics": "not_graded", "usage": usage, "ml_without_teacher": ml_result}


def evaluate(references: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> dict[str, Any]:
    ids = {r["query_id"] for r in references}
    indexed = {}
    for pred in predictions:
        qid = pred["query_id"]
        if qid not in ids or qid in indexed:
            raise ValueError(f"Unknown or duplicate query_id: {qid}")
        if not isinstance(pred.get("returned_ids"), list) or not all(isinstance(i, str) for i in pred["returned_ids"]):
            raise ValueError(f"{qid}: returned_ids must be a string list")
        indexed[qid] = pred
    results = [score_query(r, indexed.get(r["query_id"])) for r in references]
    completed = [r for r in results if r["execution_status"] == "completed"]
    totals = {k: sum(r[k] for r in completed) for k in ("tp", "fp_known_negative", "fn", "unsupported_accepts", "out_of_scope_count")}
    macro = {k: mean(v) if (v := [r['metrics'][k] for r in completed if r['metrics'][k] is not None]) else None
             for k in ("precision", "recall", "f1")}
    micro = prf(totals["tp"], sum(r["returned_unique_count"] for r in completed),
                sum(r["reference_positives"] for r in completed)) if completed else None
    return {"benchmark": "CaseWeave Real400 Q10", "reference_kind": "assistant_reviewed_not_human_adjudicated",
            "queries": results, "summary": {"total_queries": len(results), "completed_queries": len(completed),
            "attempted_queries": sum(r["execution_status"] != "not_run" for r in results),
            "exact_set_passes": sum(r["set_evaluation_pass"] for r in results),
            "execution_coverage": len(completed) / len(results),
            "macro_completed": macro, "micro_completed": micro, "counts_completed": totals,
            "not_completed_ids": [r["query_id"] for r in results if r["execution_status"] != "completed"]},
            "notes": ["Means cover completed queries only; inspect execution coverage and every failure.",
                      "Label 2 means reviewed source insufficiency, not a known negative or an unjudged record.",
                      "Strict precision penalizes unsupported confirmations and out-of-scope IDs.",
                      "Exact-set pass is not a report-semantics pass or a production SLA.",
                      "Missing telemetry stays null; this scorer does not execute an agent or label records."]}

