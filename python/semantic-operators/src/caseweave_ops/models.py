"""Shared-label model competition. No LLM calls, corpus scans, or task state.

Training uses scikit-learn. A fitted binary linear decision function is folded
into a dot product, following sklearn.linear_model._base.LinearClassifierMixin.
Scores are margins/probabilities depending on estimator, NOT quality guarantees.
"""
from dataclasses import dataclass
from time import perf_counter
from typing import Any
import numpy as np
from joblib import Parallel, delayed, parallel_config
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.svm import LinearSVC
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


def model_bank(*, sparse=False, seed=0):
    """Four deliberately different candidates; no online hyperparameter grid."""
    return [
        Candidate("dense_lr", "dense", LogisticRegression(C=1., max_iter=400), True),
        Candidate("sparse_svm" if sparse else "dense_svm", "sparse" if sparse else "dense",
                  LinearSVC(C=1., dual="auto", max_iter=3000, random_state=seed), not sparse),
        Candidate("dense_mlp", "dense", MLPClassifier(hidden_layer_sizes=(32,),
                  alpha=.01, max_iter=250, random_state=seed, early_stopping=False), True),
        Candidate("dense_hgb", "dense", HistGradientBoostingClassifier(max_iter=80,
                  max_leaf_nodes=15, l2_regularization=1., random_state=seed)),
    ]


def _fit(candidate, views, y):
    valid = y >= 0  # Undetermined is never relabeled as negative.
    X, labels = views[candidate.view][valid], y[valid]
    if np.unique(labels).size != 2:
        raise ValueError("Need determinate positive AND negative training examples")
    started = perf_counter()
    scaler = StandardScaler().fit(X) if candidate.scale else None
    Z = scaler.transform(X) if scaler is not None else X
    candidate.estimator.fit(Z, labels, sample_weight=compute_sample_weight("balanced", labels))
    result = Fitted(candidate.name, candidate.view, candidate.estimator, scaler,
                    perf_counter() - started)
    if isinstance(candidate.estimator, (LogisticRegression, LinearSVC)):
        w = candidate.estimator.coef_[0].copy()
        b = float(candidate.estimator.intercept_[0])
        if scaler is not None:
            w = w / scaler.scale_
            b -= float(scaler.mean_ @ w)
        # Keep training precision. No silent float32/quantization approximation.
        result.weight, result.bias = w, b
    return result


def fit_models(views, y, *, workers=1, candidates=None, seed=0):
    """Parallelize SMALL labeled data only. Worker pools cap nested BLAS threads."""
    y = np.asarray(y, dtype=np.int8)
    candidates = candidates or model_bank(sparse="sparse" in views, seed=seed)
    if workers == 1:
        with threadpool_limits(limits=1):
            return [_fit(c, views, y) for c in candidates]
    with parallel_config(backend="loky", n_jobs=min(workers, len(candidates)),
                         inner_max_num_threads=1, max_nbytes="1M"):
        return Parallel()(delayed(_fit)(c, views, y) for c in candidates)


def operating_point(y, scores, *, precision_target=.95, recall_target=.95, weights=None):
    """Tune threshold on a SEPARATE selection set, treating score ties as a unit.

    Nonuniform evaluation samples require inverse inclusion weights. Training
    class weights are NOT evaluation weights. This is empirical model selection.
    """
    y, scores = np.asarray(y), np.asarray(scores)
    weights = np.ones(len(y)) if weights is None else np.asarray(weights)
    valid = y >= 0
    y, scores, weights = y[valid], scores[valid], weights[valid]
    if not len(y) or np.unique(y).size != 2:
        raise ValueError("Selection set needs both determinate classes")
    order = np.argsort(-scores, kind="stable")
    y, scores, weights = y[order], scores[order], weights[order]
    ends = np.r_[np.flatnonzero(scores[:-1] != scores[1:]), len(scores)-1]
    tp = np.cumsum(weights*y)[ends]
    selected = np.cumsum(weights)[ends]
    p, r = tp/selected, tp/np.sum(weights*y)
    f1 = np.divide(2*p*r, p+r, out=np.zeros_like(p), where=p+r > 0)
    feasible = (p >= precision_target) & (r >= recall_target)
    pool = np.flatnonzero(feasible)
    idx = pool[np.argmax(r[pool])] if len(pool) else int(np.argmax(f1))
    return {"threshold": float(scores[ends[idx]]), "precision": float(p[idx]),
            "recall": float(r[idx]), "f1": float(f1[idx]), "feasible_on_selection": bool(feasible[idx]),
            "selection_unknown": int(np.count_nonzero(~valid))}


def choose_model(models, views, y, *, corpus_size, precision_target=.95, recall_target=.95,
                 weights=None, feature_seconds_per_row=None):
    """Pick cheapest empirically feasible model, or best provisional challenger.

    Timings are selection-block microbenchmarks, not production latency promises.
    Selection metrics describe this holdout only, not population quality bounds.
    """
    board = []
    feature_cost = feature_seconds_per_row or {}
    for model in models:
        X = views[model.view]
        with threadpool_limits(limits=1):
            scores = model.score(X)  # warm-up, then measure its actual serving path
            times = []
            for _ in range(3):
                t = perf_counter(); model.score(X); times.append(perf_counter()-t)
        point = operating_point(y, scores, precision_target=precision_target,
                                recall_target=recall_target, weights=weights)
        seconds = float(np.median(times))/len(y) + feature_cost.get(model.view, 0.)
        board.append({"name": model.name, "view": model.view, **point,
                      "fit_seconds": model.fit_seconds, "score_seconds_per_row": seconds,
                      "estimated_execution_seconds": model.fit_seconds + corpus_size*seconds})
    feasible = [i for i, row in enumerate(board) if row["feasible_on_selection"]]
    winner = min(feasible, key=lambda i: board[i]["estimated_execution_seconds"]) if feasible else max(
        range(len(board)), key=lambda i: (board[i]["f1"], -board[i]["estimated_execution_seconds"]))
    return models[winner], board[winner]["threshold"], board
