"""Training-group OOF selection and frozen binary voting with up to three selected members.

The reference is local teacher feedback, not independent business truth. No
holdout labels/features are accepted by the selector. Nothing calls an LLM.
"""
from dataclasses import dataclass
from copy import deepcopy
from hashlib import sha256
from itertools import combinations
from time import perf_counter
import re
import numpy as np
from threadpoolctl import threadpool_limits
from . import models as model_api
from .types import digest

GROUP_PROJECTION = "business-and-canonical-nfkc-whitespace-v1"
DEFAULT_METHODS = ("dense_lr", "dense_svm", "dense_mlp", "dense_hgb",
                   "feedback_margin", "relation_logistic")


def validate_group_metadata(value):
    if not isinstance(value, dict) or set(value) - {"business_hash", "canonical_hash", "group_projection"}:
        raise ValueError("Invalid local group metadata")
    for name in ("business_hash", "canonical_hash"):
        if name in value and (not isinstance(value[name], str) or not re.fullmatch(r"[a-f0-9]{64}", value[name])):
            raise ValueError("Invalid trusted group hash")
    if value and value.get("group_projection") != GROUP_PROJECTION:
        raise ValueError("Unsupported local group projection")
    return dict(value)


def group_closure(row_groups):
    """Union both trusted identity types transitively; missing evidence stays None."""
    metadata = [validate_group_metadata(v) for v in row_groups]
    parents = list(range(len(metadata)))
    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]; i = parents[i]
        return i
    tokens = {}
    verified = np.zeros(len(metadata), dtype=bool)
    for i, item in enumerate(metadata):
        verified[i] = bool(item.get("business_hash") and item.get("canonical_hash"))
        # Even partially known rows can bridge two verified aliases. They cannot
        # themselves be admitted as independent training/evaluation evidence.
        for name in ("business_hash", "canonical_hash"):
            if name in item:
                token = (name, item[name])
                if token in tokens:
                    a, b = find(i), find(tokens[token]); parents[b] = a
                else:
                    tokens[token] = i
    members = {}
    for i, item in enumerate(metadata):
        members.setdefault(find(i), set()).update((name, item[name])
            for name in ("business_hash", "canonical_hash") if name in item)
    identities = {root: digest([GROUP_PROJECTION, sorted(values)]) for root, values in members.items()}
    return np.asarray([identities[find(i)] if verified[i] else None for i in range(len(metadata))], dtype=object)


def group_roles(ids, row_groups, *, seed=0, heldout_fraction=.3):
    if len(ids) != len(row_groups) or len(set(map(int, ids))) != len(ids):
        raise ValueError("Group roles require distinct aligned IDs")
    groups = group_closure(row_groups)
    return {int(i): "unverified" if group is None else
            "final_holdout" if int(sha256(f"{seed}:{group}".encode()).hexdigest()[:16], 16) / 2**64 < heldout_fraction
            else "training" for i, group in zip(ids, groups)}


def binary_report(y, predictions):
    y, predictions = np.asarray(y), np.asarray(predictions)
    if y.shape != predictions.shape or not np.isin(y, [-1, 0, 1]).all():
        raise ValueError("Binary evaluation arrays must align")
    known = y >= 0
    valid = known & np.isin(predictions, [0, 1])
    tp = int(np.count_nonzero(valid & (y == 1) & (predictions == 1)))
    selected = int(np.count_nonzero(valid & (predictions == 1)))
    positive = int(np.count_nonzero(known & (y == 1)))
    precision, recall = tp/max(1, selected), tp/max(1, positive)
    return {"precision": precision, "recall": recall,
        "f1": 2*precision*recall/max(1e-12, precision+recall),
        "coverage": float(valid.sum()/max(1, known.sum())),
        "reference_coverage": float(known.sum()/max(1, len(y))),
        "agreement": float(np.count_nonzero(valid & (y == predictions))/max(1, valid.sum())),
        "reference_records": int(known.sum()), "reference_unknown": int((~known).sum()),
        "prediction_unknown": int(np.count_nonzero(known & ~valid))}


def _votes(scores, threshold):
    result = np.full(len(scores), -1, dtype=np.int8)
    valid = np.isfinite(scores)
    result[valid] = (np.asarray(scores)[valid] >= threshold).astype(np.int8)
    return result


def pair_vote(left, right):
    left, right = np.asarray(left), np.asarray(right)
    result = np.full(len(left), -1, dtype=np.int8)
    valid = np.isin(left, [0, 1]) & np.isin(right, [0, 1])
    # 左票为训练OOF较好的模型，平票用它打破，绝不形成语义第三类。
    result[valid] = left[valid]
    return result


def majority_vote(votes):
    values = np.asarray(votes)
    result = np.full(values.shape[1], -1, dtype=np.int8)
    valid = np.isin(values, [0, 1]).all(axis=0)
    count = values[:, valid].sum(axis=0)
    result[valid] = np.where(count * 2 == len(values), values[0, valid], count * 2 > len(values))
    return result


@dataclass
class FrozenSelection:
    members: tuple
    thresholds: tuple
    manifest: dict

    @property
    def name(self):
        return "+".join(model.name for model in self.members)

    def score_views(self, views):
        if len(self.members) == 1:
            return self.members[0].score(views[self.members[0].view])
        votes = [_votes(model.score(views[model.view]), threshold)
            for model, threshold in zip(self.members, self.thresholds)]
        values = np.asarray(votes)
        valid = np.isin(values, [0, 1]).all(axis=0)
        scores = values.mean(axis=0)
        ties = valid & (scores == .5)
        scores[ties] += np.where(values[0, ties] == 1, 1e-8, -1e-8)
        return np.where(valid, scores, np.nan)

    @property
    def threshold(self):
        return self.thresholds[0] if len(self.members) == 1 else .5


class FitBudgetExceeded(TimeoutError):
    pass


class SelectionUnavailable(ValueError):
    def __init__(self, failures, fit_count, fit_seconds):
        super().__init__("No candidate completed strict group cross-fit")
        self.failures, self.fit_count, self.fit_seconds = failures, fit_count, fit_seconds


def select_group_crossfit(views, y, groups, *, methods=None, fusion="selective", seed=0,
                          precision_target=.95, recall_target=.95, budget_seconds=30., check=None):
    """Fit candidates/thresholds/membership using training groups ONLY.

    Every OOF score excludes that row's entire alias group from scaler/fit.
    Relation logistic adds another group cross-fit inside each outer fit fold.
    Failed candidates are isolated. Completed single candidates survive a budget
    boundary; an unfinished candidate is never published. No final holdout input.
    """
    if fusion not in {"single", "selective"}:
        raise ValueError("Unknown online fusion mode")
    y, groups = np.asarray(y), np.asarray(groups, dtype=object)
    if not np.isin(y, [0, 1]).all():
        raise ValueError("Group cross-fit labels must be determinate binary")
    y = y.astype(np.int8)
    if len(groups) != len(y) or any(g is None for g in groups):
        raise ValueError("Strict group cross-fit requires verified groups")
    if any(len(set(y[groups == group])) != 1 for group in set(groups)):
        raise ValueError("Conflicting teacher labels inside an alias group")
    splits = model_api.group_folds(y, groups, seed=seed)
    candidates = model_api.model_bank(sparse="sparse" in views, seed=seed,
        methods=list(methods or DEFAULT_METHODS))
    started = perf_counter()
    board, fitted, oof_votes, failures = [], {}, {}, []
    fit_count = 0
    def boundary():
        if check is not None:
            check()
        if perf_counter()-started >= budget_seconds:
            raise FitBudgetExceeded("Online fit budget exhausted")
    for candidate in candidates:
        try:
            scores = np.full(len(y), np.nan)
            with threadpool_limits(limits=1):
                for fit, held in splits:
                    boundary()
                    model = model_api._fit(deepcopy(candidate), {name: X[fit] for name, X in views.items()},
                        y[fit], groups=groups[fit])
                    fit_count += 1
                    scores[held] = model.score(views[model.view][held])
                    boundary()
                point = model_api.operating_point(y, scores, precision_target=precision_target,
                    recall_target=recall_target)
                boundary()
                serving = model_api._fit(deepcopy(candidate), views, y, groups=groups)
                fit_count += 1
                if check is not None:
                    check()
            vote = _votes(scores, point["threshold"])
            report = binary_report(y, vote)
            board.append({"name": candidate.name, "view": candidate.view, **point,
                "fit_seconds": serving.fit_seconds, "threshold_metrics_oof": report})
            fitted[candidate.name], oof_votes[candidate.name] = serving, vote
        except FitBudgetExceeded:
            failures.append({"name": candidate.name, "error": "fit_budget_exhausted"})
            break
        except Exception as exc:
            failures.append({"name": candidate.name, "error": type(exc).__name__})
    if not board:
        raise SelectionUnavailable(failures, fit_count, perf_counter()-started)
    def rank(row):
        return (row["feasible_on_selection"], row["f1"], row["coverage"], -row["fit_seconds"])
    best = max(board, key=rank)
    chosen, thresholds = [best["name"]], [best["threshold"]]
    selected_report = best["threshold_metrics_oof"]
    reason = "single_requested" if fusion == "single" else "no_oof_diversity_gain"
    pair_board = []
    if fusion == "selective":
        for size in range(2, min(3, len(board)) + 1):
          for cohort in combinations(board, size):
            cohort = sorted(cohort, key=rank, reverse=True)
            votes = [oof_votes[row['name']] for row in cohort]
            disagreement = float(np.mean(np.any(np.asarray(votes) != votes[0], axis=0)))
            # Identical voters add no complementary information.
            if disagreement <= 0:
                continue
            report = binary_report(y, majority_vote(votes))
            pair_board.append({"members": [row['name'] for row in cohort],
                "disagreement": disagreement, **report})
            # 分歧也产生二分类票；只有训练OOF改善才能选融合。
            if report["f1"] > selected_report["f1"] + 1e-9 and report["precision"] >= best["precision"]:
                chosen, thresholds = [row['name'] for row in cohort], [row['threshold'] for row in cohort]
                selected_report, reason = report, "oof_diversity_gain"
    manifest = {"protocol": "online-group-crossfit-v1", "group_projection": GROUP_PROJECTION,
        "fusion": fusion, "methods": [candidate.name for candidate in candidates],
        "members": chosen, "member_thresholds": thresholds, "selection_reason": reason,
        "vote_rule": "binary_majority_oof_best_tiebreak", "confidence_basis": "winning_vote_fraction_uncalibrated",
        "single_baseline": {"name": best["name"], "threshold": best["threshold"],
            **best["threshold_metrics_oof"]}, "selected_ensemble": len(chosen) > 1,
        "threshold_metrics_oof": selected_report, "reference_basis": "teacher",
        "business_accuracy": "not_measured", "final_holdout_used_for_selection": False,
        "training_groups": len(set(groups)), "crossfit_folds": len(splits),
        "models": board, "pairs": pair_board, "candidate_failures": failures,
        "fit_count": fit_count, "fit_seconds": perf_counter()-started,
        "training_cohort": digest([groups.tolist(), y.tolist()])}
    return FrozenSelection(tuple(fitted[name] for name in chosen), tuple(thresholds), manifest), manifest
