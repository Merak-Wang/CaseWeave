"""Metrics for binary membership decisions, including selective abstention."""
from __future__ import annotations

from typing import Mapping, Any

import numpy as np


def score_binary(y_true, y_pred, *, usage: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Score known 0/1 references; -1 reference is unknown and prediction is abstain."""
    truth = np.asarray(y_true, dtype=np.int8)
    pred = np.asarray(y_pred, dtype=np.int8)
    if truth.shape != pred.shape:
        raise ValueError("y_true and y_pred must have identical shape")
    if truth.ndim != 1 or not np.isin(truth, [-1, 0, 1]).all() or not np.isin(pred, [-1, 0, 1]).all():
        raise ValueError("labels must be one-dimensional arrays of -1, 0 or 1")
    active = pred != -1
    known = truth != -1
    evaluated = active & known
    reference_count = int(known.sum())
    t, p = truth[evaluated], pred[evaluated]
    tp_c = int(np.sum((t == 1) & (p == 1)))
    fp_c = int(np.sum((t == 0) & (p == 1)))
    fn_c = int(np.sum((t == 1) & (p == 0)))
    tn_c = int(np.sum((t == 0) & (p == 0)))
    cp = tp_c / (tp_c + fp_c) if tp_c + fp_c else None
    cr = tp_c / (tp_c + fn_c) if tp_c + fn_c else None
    cf = (2 * cp * cr / (cp + cr) if cp + cr else 0.0) if cp is not None and cr is not None else None
    tp = tp_c
    fp = fp_c
    fn = int(np.sum((truth == 1) & (pred != 1)))
    tn = tn_c
    precision = (tp / (tp + fp) if tp + fp else 0.0) if reference_count else None
    recall = tp / int(np.sum(truth == 1)) if np.any(truth == 1) else None
    specificity = tn / int(np.sum(truth == 0)) if np.any(truth == 0) else None
    f1 = (2 * precision * recall / (precision + recall) if recall is not None and precision + recall else 0.0) if reference_count else None
    count = len(truth)
    result: dict[str, Any] = {
        "n": count, "predicted": int(active.sum()), "abstained": int((~active).sum()),
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": precision, "recall": recall, "f1": f1,
        "accuracy": (tp + tn) / reference_count if reference_count else None,
        "balanced_accuracy": (recall + specificity) / 2 if recall is not None and specificity is not None else None,
        "conditional": {
            "tp": tp_c, "fp": fp_c, "fn": fn_c, "tn": tn_c,
            "precision": cp, "recall": cr, "f1": cf,
            "accuracy": (tp_c + tn_c) / len(t) if len(t) else None,
            "balanced_accuracy": (cr + tn_c / (tn_c + fp_c)) / 2 if cr is not None and tn_c + fp_c else None,
        },
        "abstained_positive": int(np.sum((truth == 1) & ~active)),
        "abstained_negative": int(np.sum((truth == 0) & ~active)),
        "coverage": float(active.mean()) if count else 0.0,
        "reference_count": reference_count, "reference_unknown": count - reference_count,
        "reference_coverage": reference_count / count if count else 0.0,
        "evaluated": int(evaluated.sum()),
        "evaluated_coverage": int(evaluated.sum()) / reference_count if reference_count else None,
        "abstain_rate": float((~active).mean()) if count else 0.0,
    }
    if usage is not None:
        result["usage"] = dict(usage)
    return result
