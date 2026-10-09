"""Frozen strict pointwise and test-batch transductive zero-shot operators."""
from __future__ import annotations

import numpy as np
from sklearn.cluster import KMeans
from sklearn.mixture import GaussianMixture
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler


ZERO_SHOT_METHODS = {
    "dual_description_margin": {
        "regime": "strict_pointwise", "learning_signal": "frozen_positive_and_negative_description_embeddings",
        "source": "fixed dual semantic prototypes; no ticket-vector fitting",
        "config": {"score": "cosine_positive_minus_cosine_negative", "threshold": 0.0,
                   "prediction_rule": "score>=0"},
    },
    "query_otsu_test_batch": {
        "regime": "test_batch_transductive", "learning_signal": "unlabeled_test_vectors_plus_query_anchor",
        "source": "Otsu threshold on query-projection scores",
        "config": {"projection": "cosine_to_query", "score": "cosine_to_query",
                   "threshold": "max_between_class_variance", "tie": "lowest_threshold"},
    },
    "name_gmm_test_batch": {
        "regime": "test_batch_transductive", "learning_signal": "unlabeled_test_vectors_plus_query_anchor",
        "source": "V4 NameGMM; test-only 1D query projection",
        "config": {"components": 2, "n_init": 8, "covariance_type": "full", "reg_covar": 1e-5,
                   "positive": "higher_projection_mean", "component_tie": "lowest_index",
                   "threshold": 0.5, "degenerate_projection": "constant_score_0.5"},
    },
    "self_core_gmm_test_batch": {
        "regime": "test_batch_transductive", "learning_signal": "unlabeled_test_vectors_plus_query_anchor",
        "source": "adapted V4 SelfCoreGMM signature and core relation score; GMM regularization fixed for this experiment",
        "config": {"signature": {"core_size": 6, "candidate_fraction": 0.35, "knn_neighbors": 6,
                      "rank_weights_name_centrality": [0.62, 0.38],
                      "prototype_selection": "score_then_farthest_first", "farthest_score_weights": [0.75, 0.25]},
                   "core_score_weights_name_center_proto_max_proto_mean": [0.15, 0.30, 0.40, 0.15],
                   "gmm_components": 2, "gmm_n_init": 8, "gmm_covariance_type": "full",
                   "gmm_reg_covar": 1e-5, "component_tie": "lowest_index",
                   "threshold": 0.5, "degenerate_projection": "constant_score_0.5"},
    },
    "name_core_gmm_test_batch": {
        "regime": "test_batch_transductive", "learning_signal": "unlabeled_test_vectors_plus_query_anchor",
        "source": "adapted V5 NameCoreGMM; relation feature mixture refit on test batch",
        "config": {"signature": {"core_size": 6, "candidate_fraction": 0.35, "knn_neighbors": 6,
                      "rank_weights_name_centrality": [0.62, 0.38],
                      "prototype_selection": "score_then_farthest_first", "farthest_score_weights": [0.75, 0.25]},
                   "features": ["name", "center", "proto_max"], "positive_direction": [0.50, 0.20, 0.30],
                   "components": 2, "n_init": 10, "covariance_type": "full", "reg_covar": 1e-5,
                   "component_tie": "lowest_index", "threshold": 0.5},
    },
    "multi_view_gmm_test_batch": {
        "regime": "test_batch_transductive", "learning_signal": "unlabeled_test_vectors_plus_query_anchor",
        "source": "adapted V5 MultiViewGMM; relation feature mixture refit on test batch",
        "config": {"signature": {"core_size": 6, "candidate_fraction": 0.35, "knn_neighbors": 6,
                      "rank_weights_name_centrality": [0.62, 0.38],
                      "prototype_selection": "score_then_farthest_first", "farthest_score_weights": [0.75, 0.25]},
                   "features": ["name", "center", "proto_max", "proto_mean", "proto_std", "proto_max_minus_name"],
                   "positive_direction": [0.35, 0.15, 0.25, 0.15, -0.05, 0.05],
                   "components": 2, "n_init": 10, "covariance_type": "full", "reg_covar": 1e-5,
                   "component_tie": "lowest_index", "threshold": 0.5},
    },
    "kmeans_test_batch": {
        "regime": "test_batch_transductive", "learning_signal": "unlabeled_test_vectors_plus_query_anchor",
        "source": "V5 static KMeans(K=2)+NameAnchor",
        "config": {"clusters": 2, "n_init": 30, "algorithm": "lloyd",
                   "positive": "center_with_higher_query_cosine",
                   "anchor_tie": "lowest_cluster_id",
                   "score": "cosine_to_selected_positive_center", "prediction": "assigned_cluster_membership"},
    },
    "spherical_kmeans_test_batch": {
        "regime": "test_batch_transductive", "learning_signal": "unlabeled_test_vectors_plus_query_anchor",
        "source": "V5 static spherical KMeans(K=2)+NameAnchor",
        "config": {"clusters": 2, "n_init": 10, "max_iter": 100, "positive": "center_with_higher_query_cosine",
                   "anchor_tie": "lowest_cluster_id",
                   "score": "cosine_to_selected_positive_center", "prediction": "assigned_cluster_membership"},
    },
}


def _unit(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    return x / max(float(np.linalg.norm(x)), 1e-12)


def _rows(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)


def predict_one(vector: np.ndarray, positive_anchor: np.ndarray,
                negative_anchor: np.ndarray) -> dict:
    """逐票比较冻结的正、负业务描述原型，不读取或拟合其他工单。"""
    x = _unit(vector)
    score = float(x @ _unit(positive_anchor) - x @ _unit(negative_anchor))
    return {"score": score, "prediction": int(score >= 0.0),
            "config": ZERO_SHOT_METHODS["dual_description_margin"]["config"]}


def _rank01(x: np.ndarray) -> np.ndarray:
    return np.argsort(np.argsort(x, kind="stable"), kind="stable").astype(np.float64) / max(len(x) - 1, 1)


def _signature(x: np.ndarray, anchor: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """从无标签批次计算邻域中心性、核心原型和中心，不接触标注。"""
    n = len(x)
    if n == 1:
        centrality = np.ones(1)
    else:
        k = min(6, n - 1)
        dist, _ = NearestNeighbors(n_neighbors=k + 1, metric="cosine", algorithm="brute").fit(x).kneighbors(x)
        centrality = (1.0 - dist[:, 1:]).mean(axis=1)
    name_sim = x @ anchor
    base = 0.62 * _rank01(name_sim) + 0.38 * _rank01(centrality)
    candidate_n = max(6, min(n, int(np.ceil(n * 0.35))))
    candidates = np.argsort(base, kind="stable")[-candidate_n:][::-1]
    selected = [int(candidates[0])]
    while len(selected) < min(6, candidate_n):
        pool = np.asarray([i for i in candidates.tolist() if i not in selected], dtype=np.int64)
        distance = 1.0 - x[pool] @ x[np.asarray(selected)].T
        utility = 0.75 * distance.min(axis=1) + 0.25 * base[pool]
        selected.append(int(pool[np.argmax(utility)]))
    prototypes = x[np.asarray(selected)]
    center = _unit(prototypes.mean(axis=0))
    return center, prototypes, name_sim


def _relation_features(x: np.ndarray, anchor: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    center, prototypes, name_sim = _signature(x, anchor)
    center_sim = x @ center
    proto = x @ prototypes.T
    proto_max, proto_mean, proto_std = proto.max(axis=1), proto.mean(axis=1), proto.std(axis=1)
    features = np.column_stack([name_sim, center_sim, proto_max, proto_mean, proto_std,
                                proto_max - name_sim])
    core_score = 0.15 * name_sim + 0.30 * center_sim + 0.40 * proto_max + 0.15 * proto_mean
    return features, core_score, anchor


def _fit_gmm(scores: np.ndarray, seed: int, *, n_init: int = 8) -> tuple[np.ndarray, np.ndarray]:
    if len(scores) < 6 or float(np.std(scores)) < 1e-8:
        probability = np.full(len(scores), 0.5, dtype=np.float64)
        return probability, (probability >= 0.5).astype(np.int8)
    model = GaussianMixture(n_components=2, covariance_type="full", n_init=n_init,
                            random_state=seed, reg_covar=1e-5).fit(scores.reshape(-1, 1))
    positive = int(np.argmax(model.means_.ravel()))
    probability = model.predict_proba(scores.reshape(-1, 1))[:, positive]
    return probability, (probability >= 0.5).astype(np.int8)


def _otsu(scores: np.ndarray) -> tuple[float, np.ndarray]:
    values = np.unique(scores)
    if len(values) < 2:
        threshold = float(values[0]) if len(values) else 0.0
        return threshold, (scores >= threshold).astype(np.int8)
    ordered = np.sort(scores, kind="stable")
    prefix = np.cumsum(ordered)
    n = len(ordered)
    # 每个切分只比较相邻不同值间的阈值；同分取最小阈值。
    cuts = np.flatnonzero(ordered[:-1] < ordered[1:])
    left_n = cuts + 1
    left_sum = prefix[cuts]
    right_n = n - left_n
    right_sum = prefix[-1] - left_sum
    variance = (left_n * right_n / n**2) * (left_sum / left_n - right_sum / right_n) ** 2
    best = int(np.argmax(variance))
    threshold = float((ordered[cuts[best]] + ordered[cuts[best] + 1]) / 2.0)
    return threshold, (scores >= threshold).astype(np.int8)


def _spherical_kmeans(x: np.ndarray, seed: int, n_init: int = 10,
                      max_iter: int = 100) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    best_labels, best_centers, best_loss = None, None, np.inf
    n = len(x)
    for _ in range(n_init):
        chosen = [int(rng.integers(n))]
        distance = 1.0 - x @ x[chosen[0]]
        while len(chosen) < 2:
            weights = np.clip(distance, 0.0, None) ** 2
            if weights.sum() <= 1e-12:
                chosen.append(int(rng.choice([i for i in range(n) if i not in chosen])))
            else:
                chosen.append(int(rng.choice(n, p=weights / weights.sum())))
            distance = np.minimum(distance, 1.0 - x @ x[chosen[-1]])
        centers = x[np.asarray(chosen)].copy()
        for _ in range(max_iter):
            sim = x @ centers.T
            labels = np.argmax(sim, axis=1)
            updated = centers.copy()
            for cluster in range(2):
                members = x[labels == cluster]
                if len(members):
                    updated[cluster] = _unit(members.mean(axis=0))
                else:
                    updated[cluster] = x[int(np.argmin(sim.max(axis=1)))]
            if np.allclose(updated, centers, atol=1e-6):
                centers = updated
                break
            centers = updated
        labels = np.argmax(x @ centers.T, axis=1)
        loss = float(np.sum(1.0 - (x @ centers.T)[np.arange(n), labels]))
        if loss < best_loss:
            best_labels, best_centers, best_loss = labels, centers, loss
    return best_labels, best_centers


def predict_batch(method: str, X: np.ndarray, query_anchor: np.ndarray,
                  seed: int = 0) -> dict:
    """仅对单条件测试批次做无标签适配；函数没有标签或训练集输入。"""
    if method not in ZERO_SHOT_METHODS or ZERO_SHOT_METHODS[method]["regime"] != "test_batch_transductive":
        raise KeyError(f"not a transductive batch method: {method}")
    x, anchor = _rows(X), _unit(query_anchor)
    if method == "query_otsu_test_batch":
        score = x @ anchor
        threshold, pred = _otsu(score)
        config = {**ZERO_SHOT_METHODS[method]["config"], "threshold_value": threshold}
    elif method == "name_gmm_test_batch":
        score, pred = _fit_gmm(x @ anchor, seed)
        config = dict(ZERO_SHOT_METHODS[method]["config"])
    elif method in {"self_core_gmm_test_batch", "name_core_gmm_test_batch", "multi_view_gmm_test_batch"}:
        features, core_score, _ = _relation_features(x, anchor)
        if method == "self_core_gmm_test_batch":
            score, pred = _fit_gmm(core_score, seed)
        else:
            selected = features[:, [0, 1, 2]] if method == "name_core_gmm_test_batch" else features
            scaler = StandardScaler().fit(selected)
            z = scaler.transform(selected)
            model = GaussianMixture(n_components=2, covariance_type="full", n_init=10,
                                    reg_covar=1e-5, random_state=seed).fit(z)
            direction = np.asarray([0.50, 0.20, 0.30]) if method == "name_core_gmm_test_batch" else np.asarray([0.35, 0.15, 0.25, 0.15, -0.05, 0.05])
            high = int(np.argmax(scaler.inverse_transform(model.means_) @ direction))
            score = model.predict_proba(z)[:, high]
            pred = (score >= 0.5).astype(np.int8)
        config = dict(ZERO_SHOT_METHODS[method]["config"])
    elif method == "kmeans_test_batch":
        model = KMeans(n_clusters=2, n_init=30, random_state=seed, algorithm="lloyd").fit(x)
        centers = _rows(model.cluster_centers_)
        positive = int(np.argmax(centers @ anchor))
        pred = (model.labels_ == positive).astype(np.int8)
        score = x @ centers[positive]
        config = dict(ZERO_SHOT_METHODS[method]["config"])
    else:
        labels, centers = _spherical_kmeans(x, seed)
        positive = int(np.argmax(centers @ anchor))
        pred = (labels == positive).astype(np.int8)
        score = x @ centers[positive]
        config = dict(ZERO_SHOT_METHODS[method]["config"])
    config["seed"] = int(seed)
    return {"scores": np.asarray(score, dtype=np.float64),
            "predictions": np.asarray(pred, dtype=np.int8), "config": config}
