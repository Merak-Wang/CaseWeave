"""Freeze one query pool's unlabeled predictions; no feedback or teacher calls.

The formulas/parameters follow evals.zero_shot's dual description, NameGMM and
KMeans baselines. This production module uses only this package's declared
numpy/sklearn dependencies. It deliberately does not import the eval package.
These are identity-bound proxy candidates, never verified business decisions.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from hashlib import sha256
from typing import Callable, Sequence

import numpy as np
from sklearn.cluster import KMeans
from sklearn.mixture import GaussianMixture

from .types import Decision, ProtocolError, Record, StaleTask, digest


UNLABELED_METHODS = {
    "dual_description_margin": {
        "regime": "strict_pointwise", "score_kind": "dual_description_cosine_margin",
        "config": {"threshold": 0.0, "positive": "positive_minus_negative_description"},
    },
    "name_gmm": {
        "regime": "query_fixed_pool_unlabeled", "score_kind": "unlabeled_mixture_membership",
        "config": {"components": 2, "n_init": 8, "covariance_type": "full", "reg_covar": 1e-5,
                   "positive": "higher_query_projection_mean", "threshold": 0.5},
    },
    "kmeans": {
        "regime": "query_fixed_pool_unlabeled", "score_kind": "cosine_to_query_selected_cluster_center",
        "config": {"clusters": 2, "n_init": 30, "algorithm": "lloyd",
                   "positive": "higher_query_cosine_center", "prediction": "assigned_cluster_membership"},
    },
}


def _check_cancelled(cancelled: Callable[[], bool] | None) -> None:
    if cancelled is not None and cancelled():
        raise asyncio.CancelledError("Unlabeled query adaptation cancelled")


def _unit(value, dimension: int) -> np.ndarray | None:
    try:
        x = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if x.shape != (dimension,) or not np.isfinite(x).all():
        return None
    norm = float(np.linalg.norm(x))
    return x / norm if np.isfinite(norm) and norm > 1e-12 else None


def _record_fingerprint(record: Record) -> str:
    # Observation covers actual passages/attributes; vectors and embedding space
    # cover changes not represented by the source identity alone.
    return digest([record.identity, record.observation_key, record.embedding_id, record.vectors])


def fit_numeric_unlabeled(method, x, anchor, negative=None, *, seed=0):
    """Fit the existing unlabeled formulas on normalized vectors, without text I/O."""
    fit_count = 0
    failure = None
    computed_scores = computed_predictions = None
    if anchor is None:
        failure = "query_anchor_missing_or_invalid"
    elif method == "dual_description_margin":
        if negative is None:
            failure = "negative_description_anchor_missing_or_invalid"
        else:
            computed_scores = x @ anchor - x @ negative
            computed_predictions = computed_scores > 0.0
    elif len(x) < (6 if method == "name_gmm" else 2):
        failure = "insufficient_unlabeled_pool"
    elif float(np.std(x @ anchor)) < 1e-8:
        # The old NameGMM fallback (.5 -> all positive) is not evidence.
        failure = "degenerate_unlabeled_projection"
    else:
        try:
            if method == "name_gmm":
                projected = x @ anchor
                model = GaussianMixture(n_components=2, covariance_type="full", n_init=8,
                    reg_covar=1e-5, random_state=seed)
                fit_count += 1
                model.fit(projected[:, None])
                if not model.converged_:
                    failure = "unlabeled_fit_not_converged"
                else:
                    positive = int(np.argmax(model.means_.ravel()))
                    computed_scores = model.predict_proba(projected[:, None])[:, positive]
                    computed_predictions = computed_scores >= 0.5
            else:
                model = KMeans(n_clusters=2, n_init=30, random_state=seed, algorithm="lloyd")
                fit_count += 1
                model.fit(x)
                centers = model.cluster_centers_
                centers = centers / np.maximum(np.linalg.norm(centers, axis=1, keepdims=True), 1e-12)
                directions = centers @ anchor
                if len(np.unique(model.labels_)) < 2:
                    failure = "unlabeled_fit_degenerate"
                else:
                    positive = int(np.argmax(directions))
                    computed_scores = x @ centers[positive]
                    computed_predictions = model.labels_ == positive
        except Exception:
            # Do not expose feature arrays or arbitrary estimator messages.
            failure = "unlabeled_fit_failed"
    return computed_scores, computed_predictions, fit_count, failure


class QueryUnlabeledAdapter:
    """Fit once per scope/predicate; predict is an immutable fixed-pool lookup.

    vectors are one aligned dense embedding per Record, in embedding_id's space.
    A changed pool, predicate, embedding model or scope requires a new adapter.
    Caller must still run Scope.check and the host's normal admission checks.
    A sklearn fit cannot be interrupted inside its native kernel: cancellation
    is checked before/after fitting and before/after lookup, preventing publish.
    """

    def __init__(self, method: str, *, scope_key: str, predicate_key: str,
                 embedding_id: str, seed: int = 0):
        if method not in UNLABELED_METHODS:
            raise ProtocolError("unrecognized_unlabeled_method")
        if not all(isinstance(value, str) and value for value in (scope_key, predicate_key, embedding_id)):
            raise ProtocolError("unlabeled_scope_predicate_and_embedding_identity_required")
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**32 - 1:
            raise ProtocolError("invalid_unlabeled_seed")
        self._configuration = (method, scope_key, predicate_key, embedding_id, seed)
        self._manifest = None
        self._entries: dict[str, tuple[str, str, str, float | None, str | None]] = {}

    @property
    def method(self) -> str:
        return self._configuration[0]

    @property
    def scope_key(self) -> str:
        return self._configuration[1]

    @property
    def predicate_key(self) -> str:
        return self._configuration[2]

    @property
    def embedding_id(self) -> str:
        return self._configuration[3]

    @property
    def seed(self) -> int:
        return self._configuration[4]

    @property
    def manifest(self) -> dict:
        if self._manifest is None:
            raise ProtocolError("fixed_pool_not_fitted")
        return deepcopy(self._manifest)

    def fit(self, records: Sequence[Record], vectors, query_anchor=None, *,
            negative_anchor=None, cancelled: Callable[[], bool] | None = None) -> dict:
        if self._manifest is not None:
            raise ProtocolError("fixed_pool_already_fitted")
        _check_cancelled(cancelled)
        records = tuple(records)
        if len({record.ref for record in records}) != len(records):
            raise ProtocolError("fixed_pool_record_refs_must_be_unique")
        try:
            raw = np.asarray(vectors, dtype=np.float64)
        except (TypeError, ValueError):
            raise ProtocolError("invalid_unlabeled_vector_matrix") from None
        if raw.ndim != 2 or raw.shape[0] != len(records) or raw.shape[1] < 1:
            raise ProtocolError("unlabeled_vectors_must_align_with_records")
        # Stable canonical ordering also removes input-order dependence from fit.
        order = sorted(range(len(records)), key=lambda i: records[i].identity)
        records = tuple(records[i] for i in order)
        raw = raw[order].copy()
        fingerprints = [_record_fingerprint(record) for record in records]
        dimension = raw.shape[1]
        anchor = _unit(query_anchor, dimension)
        negative = _unit(negative_anchor, dimension)
        norms = np.linalg.norm(raw, axis=1)
        available = np.isfinite(raw).all(axis=1) & np.isfinite(norms) & (norms > 1e-12)
        available &= np.array([not r.embedding_id or r.embedding_id == self.embedding_id for r in records], dtype=bool)
        labels = np.full(len(records), "undetermined", dtype=object)
        scores: list[float | None] = [None] * len(records)
        errors: list[str | None] = ["missing_or_invalid_vector_or_embedding_space"] * len(records)
        usable = np.flatnonzero(available)
        x = raw[usable] / norms[usable, None]
        computed_scores, computed_predictions, fit_count, failure = fit_numeric_unlabeled(
            self.method, x, anchor, negative, seed=self.seed)
        _check_cancelled(cancelled)
        for position, source in enumerate(usable):
            i = int(source)
            if failure is not None:
                errors[i] = failure
                continue
            value = float(computed_scores[position])
            if not np.isfinite(value):
                errors[i] = "unlabeled_score_not_finite"
            else:
                labels[i] = "accept" if computed_predictions[position] else "exclude"
                scores[i], errors[i] = value, None
        matrix_fingerprint = sha256(raw.tobytes(order="C")).hexdigest()
        anchor_fingerprint = digest([None if anchor is None else anchor.tolist(),
                                     None if negative is None else negative.tolist()])
        pool_key = digest(["query-unlabeled-v1", self.scope_key, self.predicate_key, self.method,
                           self.embedding_id, self.seed, fingerprints, matrix_fingerprint, anchor_fingerprint])
        entries = {record.ref: (record.identity, fingerprints[i], str(labels[i]), scores[i], errors[i])
                   for i, record in enumerate(records)}
        _check_cancelled(cancelled)
        self._entries = entries
        self._manifest = {
            "version": 1, "pool_key": pool_key, "scope_key": self.scope_key,
            "predicate_key": self.predicate_key, "method": self.method,
            "embedding_id": self.embedding_id, "seed": self.seed,
            "regime": UNLABELED_METHODS[self.method]["regime"],
            "config": deepcopy(UNLABELED_METHODS[self.method]["config"]),
            "score_kind": UNLABELED_METHODS[self.method]["score_kind"],
            "pool_records": len(records), "usable_vectors": len(usable), "fit_count": fit_count,
            "unknown_records": int(np.sum(labels == "undetermined")),
            "online_feedback_training": False, "teacher_calls": 0,
            "quality": "unmeasured", "authority": "proxy_candidates_only",
        }
        return self.manifest

    def predict(self, records: Sequence[Record], *, scope_key: str | None = None,
                cancelled: Callable[[], bool] | None = None) -> tuple[Decision, ...]:
        if self._manifest is None:
            raise ProtocolError("fixed_pool_not_fitted")
        if scope_key is not None and scope_key != self.scope_key:
            raise StaleTask("Unlabeled fixed pool scope changed")
        _check_cancelled(cancelled)
        output = []
        for record in records:
            _check_cancelled(cancelled)
            entry = self._entries.get(record.ref)
            label, score, error = "undetermined", None, "record_not_in_fixed_pool"
            if entry is not None:
                identity, fingerprint, saved_label, saved_score, saved_error = entry
                if identity != record.identity or fingerprint != _record_fingerprint(record):
                    error = "record_changed_since_fixed_pool_fit"
                else:
                    label, score, error = saved_label, saved_score, saved_error
            output.append(Decision(record.ref, record.identity, self.predicate_key, label,
                basis="unresolved" if label == "undetermined" else "proxy",
                reason="无反馈语义候选，尚未复核业务判据。", error=error, confidence=None,
                inference={"method": self.method, "pool_key": self._manifest["pool_key"],
                    "score": score, "score_kind": self._manifest["score_kind"],
                    "regime": self._manifest["regime"], "quality": "unmeasured"}))
        _check_cancelled(cancelled)
        return tuple(output)
