"""Shared-label model competition. No LLM calls, corpus scans, or task state.

Training uses scikit-learn. A fitted binary linear decision function is folded
into a dot product, following sklearn.linear_model._base.LinearClassifierMixin.
Scores are margins/probabilities depending on estimator, NOT quality guarantees.
"""
from dataclasses import dataclass
from time import perf_counter
from typing import Any
from sklearn.model_selection import StratifiedGroupKFold
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, ExtraTreesClassifier
from sklearn.linear_model import LogisticRegression, RidgeClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.svm import LinearSVC, SVC
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.utils.class_weight import compute_sample_weight
from threadpoolctl import threadpool_limits


@dataclass
class Candidate:
    name: str
    view: str
    estimator: Any
    scale: bool = False


@dataclass
class Fitted:
    name: str
    view: str
    estimator: Any
    scaler: Any
    fit_seconds: float
    weight: Any = None
    bias: float = 0.

    def score(self, X):
        if self.weight is not None:
            return np.asarray(X @ self.weight + self.bias).ravel()
        Z = self.scaler.transform(X) if self.scaler is not None else X
        if hasattr(self.estimator, "decision_function"):
            return self.estimator.decision_function(Z)
        return self.estimator.predict_proba(Z)[:, 1]


def model_bank(*, sparse=False, seed=0, methods=None):
    """互补候选共享同一S2伪标签；固定参数，不做在线网格搜索。"""
    bank = [
        Candidate("dense_lr", "dense", LogisticRegression(C=1., max_iter=400), True),
        Candidate("sparse_svm" if sparse else "dense_svm", "sparse" if sparse else "dense",
                  LinearSVC(C=1., dual="auto", max_iter=3000, random_state=seed), not sparse),
        Candidate("dense_mlp", "dense", MLPClassifier(hidden_layer_sizes=(32,),
                  alpha=.01, max_iter=250, random_state=seed, early_stopping=False), True),
        Candidate("dense_hgb", "dense", HistGradientBoostingClassifier(max_iter=80,
                  max_leaf_nodes=15, l2_regularization=1., random_state=seed)),
    ]

    if sparse:
        bank.append(Candidate("dense_svm", "dense", LinearSVC(C=1., dual="auto", max_iter=3000, random_state=seed), True))
    bank.extend([
        Candidate("feedback_margin", "dense", FeedbackMargin()),
        Candidate("relation_logistic", "dense", RelationLogistic(seed)),
        Candidate("dense_ridge", "dense", RidgeClassifier(alpha=10.), True),
        Candidate("dense_rbf_svm", "dense", SVC(C=1., kernel="rbf", gamma="scale", probability=False), True),
        Candidate("dense_extra_trees", "dense", ExtraTreesClassifier(n_estimators=64, max_depth=8, min_samples_leaf=2, n_jobs=1, random_state=seed)),
        Candidate("dense_gaussian_nb", "dense", GaussianNB(var_smoothing=1e-7)),
        Candidate("dense_knn", "dense", KNeighborsClassifier(n_neighbors=5, metric="cosine", weights="distance", algorithm="brute")),
    ])
    if methods is None:
        return bank
    if not isinstance(methods, (list, tuple)) or not methods or len(set(methods)) != len(methods):
        raise ValueError("methods must be a nonempty distinct model-name list")
    lookup = {c.name: c for c in bank}
    if any(name not in lookup for name in methods):
        raise ValueError("Unknown or unavailable online method")
    return [lookup[name] for name in methods]


def group_folds(y, groups, *, seed=0, maximum=3):
    """Every row's group stays outside its fit fold, including same-text aliases."""
    y, groups = np.asarray(y), np.asarray(groups)
    if len(y) != len(groups) or set(np.unique(y)) != {0, 1}:
        raise ValueError("Group cross-fit requires both determinate classes")
    counts = [len(set(groups[y == label])) for label in (0, 1)]
    folds = min(maximum, *counts)
    if folds < 2:
        raise ValueError("Group cross-fit needs two independent groups per class")
    splits = list(StratifiedGroupKFold(n_splits=folds, shuffle=True,
        random_state=seed).split(np.zeros(len(y)), y, groups))
    for fit, held in splits:
        if set(groups[fit]) & set(groups[held]) or set(np.unique(y[fit])) != {0, 1}:
            raise ValueError("Group cross-fit fold has insufficient independent classes")
    return splits


def _unit_rows(x):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim != 2 or not np.isfinite(x).all():
        raise ValueError("Dense features must be finite")
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)


def _unit(x):
    return x / max(float(np.linalg.norm(x)), 1e-12)


class FeedbackMargin:
    """Complementary cosine prototype view; labels are local teacher feedback."""
    def fit(self, x, y, sample_weight=None):
        x = _unit_rows(x)
        self.pos = _unit(x[y == 1].mean(axis=0))
        self.neg = _unit(x[y == 0].mean(axis=0))
        return self

    def decision_function(self, x):
        x = _unit_rows(x)
        return x @ self.pos - x @ self.neg


def _diverse(x, count):
    count = min(count, len(x))
    chosen = [int(np.argmax(x @ _unit(x.mean(axis=0))))]
    distance = 1 - x @ x[chosen[0]]
    while len(chosen) < count:
        remaining = np.setdiff1d(np.arange(len(x)), chosen)
        nxt = int(remaining[np.argmax(distance[remaining])])
        chosen.append(nxt)
        distance = np.minimum(distance, 1 - x @ x[nxt])
    return x[chosen]


def relation_state(x, y):
    pos, neg = x[y == 1], x[y == 0]
    if not len(pos) or not len(neg):
        raise ValueError("Relation prototypes require both classes")
    return (_unit(pos.mean(axis=0)), _unit(neg.mean(axis=0)),
            _diverse(pos, 3), _diverse(neg, 4), pos[0])


def relation_features(x, state):
    pos, neg, pp, nn, leader = state
    ps, ns = x @ pos, x @ neg
    pm, nm = (x @ pp.T).max(axis=1), (x @ nn.T).max(axis=1)
    return np.column_stack([ps, ns, ps-ns, pm, nm, pm-nm, x @ leader, pm-ps])


class RelationLogistic:
    """Nested group cross-fit features, then full-training prototypes for serving."""
    def __init__(self, seed=0):
        self.seed = seed

    def fit(self, x, y, sample_weight=None, groups=None):
        x = _unit_rows(x)
        if groups is None:
            raise ValueError("Relation logistic requires trusted group identities")
        features = np.empty((len(x), 8), dtype=np.float64)
        for fit, held in group_folds(y, groups, seed=self.seed):
            features[held] = relation_features(x[held], relation_state(x[fit], y[fit]))
        self.model = LogisticRegression(C=1., max_iter=400, random_state=self.seed)
        self.model.fit(features, y, sample_weight=sample_weight)
        self.state = relation_state(x, y)
        return self

    def decision_function(self, x):
        return self.model.decision_function(relation_features(_unit_rows(x), self.state))


def _fit(candidate, views, y, *, groups=None):
    y = np.asarray(y)
    if y.ndim != 1 or not np.isin(y, [-1, 0, 1]).all():
        raise ValueError("Training labels must be determinate binary or unknown")
    if isinstance(candidate.estimator, RelationLogistic) and groups is None:
        raise ValueError("Relation logistic requires trusted group identities")
    valid = y >= 0  # Undetermined is never relabeled as negative.
    X, labels = views[candidate.view][valid], y[valid]
    if np.unique(labels).size != 2:
        raise ValueError("Need determinate positive AND negative training examples")
    started = perf_counter()
    scaler = StandardScaler().fit(X) if candidate.scale else None
    Z = scaler.transform(X) if scaler is not None else X
    extra = {"groups": np.asarray(groups)[valid]} if isinstance(candidate.estimator, RelationLogistic) else {}
    if isinstance(candidate.estimator, KNeighborsClassifier):
        candidate.estimator.fit(Z, labels)
    else:
        candidate.estimator.fit(Z, labels, sample_weight=compute_sample_weight("balanced", labels), **extra)
    result = Fitted(candidate.name, candidate.view, candidate.estimator, scaler,
                    perf_counter() - started)
    if isinstance(candidate.estimator, (LogisticRegression, LinearSVC, RidgeClassifier)):
        w = np.asarray(candidate.estimator.coef_).reshape(-1).copy()
        b = float(np.asarray(candidate.estimator.intercept_).reshape(-1)[0])
        if scaler is not None:
            w = w / scaler.scale_
            b -= float(scaler.mean_ @ w)
        # Keep training precision. No silent float32/quantization approximation.
        result.weight, result.bias = w, b
    return result


def operating_point(y, scores, *, precision_target=.95, recall_target=.95, weights=None):
    """OOF/selection-only threshold. Nonfinite scores stay unknown, never negative."""
    y, scores = np.asarray(y), np.asarray(scores, dtype=np.float64)
    weights = np.ones(len(y)) if weights is None else np.asarray(weights, dtype=np.float64)
    if y.ndim != 1 or scores.shape != y.shape or weights.shape != y.shape:
        raise ValueError("Selection arrays must align")
    if not np.isin(y, [-1, 0, 1]).all() or not np.isfinite(weights).all() or (weights <= 0).any():
        raise ValueError("Selection labels/weights are invalid")
    known = y >= 0
    valid = known & np.isfinite(scores)
    if not valid.any() or set(np.unique(y[valid])) != {0, 1}:
        raise ValueError("Selection needs finite scores for both determinate classes")
    positive_weight = float(weights[known & (y == 1)].sum())
    ys, ss, ws = y[valid], scores[valid], weights[valid]
    order = np.argsort(-ss, kind="stable")
    ys, ss, ws = ys[order], ss[order], ws[order]
    ends = np.r_[np.flatnonzero(ss[:-1] != ss[1:]), len(ss)-1]
    tp = np.cumsum(ws*ys)[ends]
    selected = np.cumsum(ws)[ends]
    p, r = tp/selected, tp/positive_weight
    f1 = np.divide(2*p*r, p+r, out=np.zeros_like(p), where=p+r > 0)
    coverage = float(valid.sum()/max(1, known.sum()))
    feasible = (p >= precision_target) & (r >= recall_target) & (coverage == 1.)
    pool = np.flatnonzero(feasible)
    idx = pool[np.argmax(r[pool])] if len(pool) else int(np.argmax(f1))
    return {"threshold": float(ss[ends[idx]]), "precision": float(p[idx]),
            "recall": float(r[idx]), "f1": float(f1[idx]), "feasible_on_selection": bool(feasible[idx]),
            "selection_unknown": int(np.count_nonzero(~valid)), "coverage": coverage,
            "nonfinite_scores": int(np.count_nonzero(known & ~np.isfinite(scores)))}
