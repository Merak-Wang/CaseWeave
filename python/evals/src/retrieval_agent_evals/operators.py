"""Binary membership operators for offline semantic-operator experiments."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.cluster import KMeans
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.svm import LinearSVC
from sklearn.mixture import GaussianMixture
from sklearn.model_selection import StratifiedKFold
from sklearn.utils.class_weight import compute_sample_weight


METHODS = (
    "logistic_regression", "linear_svm", "mlp", "hist_gradient_boosting",
    "name_gmm", "spherical_kmeans", "feedback_margin",
    "feedback_multi_prototype", "feedback_knn_margin", "hard_negative_memory",
    "relation_logistic", "relation_conformal",
)


def _normalize(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)


def _unit(x: np.ndarray) -> np.ndarray:
    return x / max(float(np.linalg.norm(x)), 1e-12)


def _diverse(x: np.ndarray, k: int) -> np.ndarray:
    x = _normalize(x)
    k = min(max(1, int(k)), len(x))
    if len(x) <= k:
        return x
    center = _unit(x.mean(axis=0))
    ids = [int(np.argmax(x @ center))]
    distance = 1 - x @ x[ids[0]]
    while len(ids) < k:
        nxt = int(np.argmax(distance))
        ids.append(nxt)
        distance = np.minimum(distance, 1 - x @ x[nxt])
    return x[ids]


def _spherical_kmeans(x: np.ndarray, seed: int, iterations: int = 100) -> np.ndarray:
    """Cosine assignment with a unit-normalized mean update."""
    rng = np.random.default_rng(seed)
    centers = x[rng.choice(len(x), 2, replace=False)].copy()
    for _ in range(iterations):
        labels = np.argmax(x @ centers.T, axis=1)
        updated = np.stack([_unit(x[labels == k].mean(axis=0)) if np.any(labels == k) else centers[k]
                            for k in range(2)])
        if np.allclose(updated, centers, atol=1e-6):
            break
        centers = updated
    return centers


def _relation_features(x: np.ndarray, pos: np.ndarray, neg: np.ndarray,
                       pp: np.ndarray, np_: np.ndarray, leader: np.ndarray) -> np.ndarray:
    x = _normalize(x)
    ps, ns = x @ pos, x @ neg
    pps, nps = (x @ pp.T).max(axis=1), (x @ np_.T).max(axis=1)
    return np.column_stack([ps, ns, ps - ns, pps, nps, pps - nps,
                            x @ leader, pps - ps]).astype(np.float32)


def _relation_state(x: np.ndarray, y: np.ndarray) -> tuple:
    p, n = x[y == 1], x[y == 0]
    return (_unit(p.mean(axis=0)), _unit(n.mean(axis=0)),
            _diverse(p, 3), _diverse(n, 4), p[0])


def _cross_fit_relation_features(x: np.ndarray, y: np.ndarray, seed: int) -> np.ndarray:
    # 每行训练特征的中心、原型和leader仅来自其他折，不能以自身为同类证据。
    folds = min(5, int(np.bincount(y, minlength=2).min()))
    if folds < 2:
        raise ValueError("relation_logistic cross-fit needs at least two examples per class")
    features = np.empty((len(x), 8), dtype=np.float32)
    splitter = StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed)
    for fit_ids, heldout_ids in splitter.split(x, y):
        features[heldout_ids] = _relation_features(x[heldout_ids], *_relation_state(x[fit_ids], y[fit_ids]))
    return features


@dataclass
class FittedOperator:
    name: str
    model: object
    threshold: float = 0.0
    state: object = None
    conformal: bool = False
    scaler: object = None

    def score(self, x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=np.float32)
        if self.name in {"logistic_regression", "mlp", "hist_gradient_boosting"}:
            z = self.scaler.transform(x) if self.scaler is not None else x
            return self.model.predict_proba(z)[:, 1]
        if self.name == "linear_svm":
            z = self.scaler.transform(x) if self.scaler is not None else x
            return self.model.decision_function(z)
        x = _normalize(x)
        if self.name == "name_gmm":
            anchor, mixture, positive_component = self.state
            return mixture.predict_proba(x @ anchor[:, None])[:, positive_component]
        if self.name == "spherical_kmeans":
            centers, positive_component = self.state
            sims = x @ centers.T
            return sims[:, positive_component] - sims[:, 1 - positive_component]
        if self.name in {"feedback_margin", "feedback_multi_prototype", "feedback_knn_margin", "hard_negative_memory"}:
            pos, neg = self.state
            ps, ns = x @ pos.T, x @ neg.T
            if self.name == "feedback_knn_margin":
                k = min(3, pos.shape[0], neg.shape[0])
                return np.partition(ps, -k, axis=1)[:, -k:].mean(axis=1) - np.partition(ns, -k, axis=1)[:, -k:].mean(axis=1)
            return ps.max(axis=1) - ns.max(axis=1) if self.name != "feedback_margin" else ps[:, 0] - ns[:, 0]
        if self.name == "relation_logistic":
            pos, neg, pp, np_, leader = self.state
            return self.model.decision_function(_relation_features(x, pos, neg, pp, np_, leader))
        if self.name == "relation_conformal":
            pos, neg, pos_cal, neg_cal = self.state
            margin = x @ pos - x @ neg
            p_pos = (1 + (pos_cal[:, None] >= -margin[None, :]).sum(axis=0)) / (len(pos_cal) + 1)
            p_neg = (1 + (neg_cal[:, None] >= margin[None, :]).sum(axis=0)) / (len(neg_cal) + 1)
            return np.log(p_pos) - np.log(p_neg)
        raise KeyError(self.name)

    def predict(self, x: np.ndarray, threshold: float | None = None) -> np.ndarray:
        return (self.score(x) >= (self.threshold if threshold is None else threshold)).astype(np.int8)

    def predict_selective(self, x: np.ndarray, alpha: float = 0.1) -> np.ndarray:
        if self.name != "relation_conformal":
            raise ValueError("selective prediction is available for relation_conformal")
        pos, neg, pos_cal, neg_cal = self.state
        x = _normalize(x)
        margin = x @ pos - x @ neg
        p_pos = (1 + (pos_cal[:, None] >= -margin[None, :]).sum(axis=0)) / (len(pos_cal) + 1)
        p_neg = (1 + (neg_cal[:, None] >= margin[None, :]).sum(axis=0)) / (len(neg_cal) + 1)
        pred = np.full(len(x), -1, dtype=np.int8)
        pred[p_pos >= alpha] = 1
        pred[p_neg >= alpha] = 0
        conflict = (p_pos >= alpha) & (p_neg >= alpha)
        pred[conflict] = -1
        return pred


def fit_operator(name: str, X_train: np.ndarray, y_train: np.ndarray | None = None, *,
                 anchor: np.ndarray | None = None, seed: int = 0, **params) -> FittedOperator:
    """Fit an operator using train vectors only; anchor is the query embedding."""
    if name not in METHODS:
        raise KeyError(name)
    x_raw = np.asarray(X_train, dtype=np.float32)
    x = _normalize(x_raw)
    y = None if y_train is None else np.asarray(y_train, dtype=np.int8)
    if name in {"name_gmm", "spherical_kmeans"}:
        if anchor is None:
            raise ValueError(f"{name} requires the query anchor embedding")
        a = _unit(np.asarray(anchor, dtype=np.float32))
        if name == "name_gmm":
            projected = x @ a
            gm = GaussianMixture(n_components=2, random_state=seed, n_init=8).fit(projected[:, None])
            positive = int(np.argmax(gm.means_.ravel()))
            return FittedOperator(name, gm, 0.5, (a, gm, positive))
        centers = _spherical_kmeans(x, seed)
        positive = int(np.argmax(centers @ a))
        return FittedOperator(name, None, 0.0, (centers, positive))
    if y is None or set(np.unique(y)) != {0, 1}:
        raise ValueError(f"{name} requires both positive and negative training labels")
    if name in {"logistic_regression", "mlp", "hist_gradient_boosting", "linear_svm"}:
        if name == "logistic_regression": model = LogisticRegression(C=1., max_iter=400, random_state=seed)
        elif name == "mlp": model = MLPClassifier(hidden_layer_sizes=(32,), alpha=.01, max_iter=250, random_state=seed, early_stopping=False)
        elif name == "hist_gradient_boosting": model = HistGradientBoostingClassifier(max_iter=80, max_leaf_nodes=15, l2_regularization=1., random_state=seed)
        else: model = LinearSVC(C=1., dual="auto", max_iter=3000, random_state=seed)
        scaler = StandardScaler().fit(x_raw) if name in {"logistic_regression", "linear_svm", "mlp"} else None
        z = scaler.transform(x_raw) if scaler is not None else x_raw
        model.fit(z, y, sample_weight=compute_sample_weight("balanced", y))
        fitted = FittedOperator(name, model, scaler=scaler)
    else:
        p, n = x[y == 1], x[y == 0]
        pos, neg = _unit(p.mean(axis=0))[None, :], _unit(n.mean(axis=0))[None, :]
        if name == "feedback_multi_prototype":
            kp = min(int(params.get("positive_prototypes", 3)), len(p))
            kn = min(int(params.get("negative_prototypes", 3)), len(n))
            pos = _normalize(KMeans(n_clusters=kp, n_init=10, random_state=seed).fit(p).cluster_centers_)
            neg = _normalize(KMeans(n_clusters=kn, n_init=10, random_state=seed + 1).fit(n).cluster_centers_)
        elif name == "feedback_knn_margin":
            pos, neg = p, n
        elif name == "hard_negative_memory":
            pos, neg = _diverse(p, params.get("positive_memory", 4)), _diverse(n, params.get("negative_memory", 8))
        if name == "relation_logistic":
            features = _cross_fit_relation_features(x, y, seed)
            model = LogisticRegression(class_weight="balanced", max_iter=2000, random_state=seed).fit(features, y)
            # 预测时仅使用完整训练集的状态；测试行从不参与原型或中心构造。
            fitted = FittedOperator(name, model, state=_relation_state(x, y))
        elif name == "relation_conformal":
            # 按类别留出校准样本，中心拟合与 p 值校准不共用行。
            rng = np.random.default_rng(seed)
            if len(p) < 2 or len(n) < 2:
                raise ValueError("relation_conformal needs at least two examples per class")
            split_p = min(len(p) - 1, max(1, len(p) * 3 // 4))
            split_n = min(len(n) - 1, max(1, len(n) * 3 // 4))
            fit_p, cal_p = np.split(rng.permutation(len(p)), [split_p])
            fit_n, cal_n = np.split(rng.permutation(len(n)), [split_n])
            pos_center, neg_center = _unit(p[fit_p].mean(axis=0)), _unit(n[fit_n].mean(axis=0))
            pos_cal = np.sort(-((p[cal_p] @ pos_center) - (p[cal_p] @ neg_center)))
            neg_cal = np.sort((n[cal_n] @ pos_center) - (n[cal_n] @ neg_center))
            fitted = FittedOperator(name, None, 0.0, (pos_center, neg_center, pos_cal, neg_cal), True)
        else:
            fitted = FittedOperator(name, None, state=(pos, neg))
    # 固定边界避免在训练拟合分数上挑阈值造成乐观偏差。
    fitted.threshold = 0.5 if name in {"logistic_regression", "mlp", "hist_gradient_boosting"} else 0.0
    return fitted
