from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from .errors import ServiceError
from .vector_cache import VECTOR_CACHE_FORMAT_VERSION, VectorCacheStore


RAG_PROTOCOL_VERSION = "retrieval-agent.rag.v1"
RANKING_TOKENIZER_VERSION = "unicode-han-bigram-v1"
BM25F_VERSION = f"bm25f-v1:{RANKING_TOKENIZER_VERSION}"
DENSE_RANKING_VERSION = "exact-cosine-v1"
DENSE_PROJECTION_VERSION = "ticket-search-projection-v1"
FUSION_VERSION = "weighted-rrf-v1"
DEFAULT_EMBEDDING_INSTRUCTION = (
    "Given a support ticket search query, retrieve historical tickets with matching "
    "symptoms, products, constraints, and resolution context."
)
DEFAULT_RERANKER_INSTRUCTION = (
    "Given a support ticket search query, determine whether the historical ticket "
    "describes the same user problem and compatible constraints."
)
DEFAULT_FIELDS = {
    "title": {"weight": 3.0, "b": 0.2},
    "summary": {"weight": 1.5, "b": 0.65},
    "body": {"weight": 1.0, "b": 0.75},
    "metadata": {"weight": 0.75, "b": 0.3},
}
_NON_HAN_BODY = frozenset("_.:/-")


def _han(character: str) -> bool:
    code = ord(character)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0x20000 <= code <= 0x2FA1F
    )


def _letter_or_number(character: str) -> bool:
    return unicodedata.category(character)[0] in {"L", "N"}


def tokenize_ranking_text(text: str) -> list[str]:
    """Match the versioned mixed Han/Latin tokenizer formerly owned by TypeScript."""
    normalized = unicodedata.normalize("NFKC", text).lower()
    tokens: list[str] = []
    index = 0
    while index < len(normalized):
        character = normalized[index]
        if _han(character):
            end = index + 1
            while end < len(normalized) and _han(normalized[end]):
                end += 1
            run = list(normalized[index:end])
            tokens.extend(run)
            tokens.extend(run[offset] + run[offset + 1] for offset in range(len(run) - 1))
            index = end
            continue
        if _letter_or_number(character):
            end = index + 1
            while end < len(normalized):
                candidate = normalized[end]
                if _han(candidate) or not (_letter_or_number(candidate) or candidate in _NON_HAN_BODY):
                    break
                end += 1
            tokens.append(normalized[index:end])
            index = end
            continue
        index += 1
    return tokens


def _string(value: Any, label: str, maximum: int = 100_000, allow_empty: bool = True) -> str:
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value.strip()):
        raise ServiceError(400, "INVALID_REQUEST", f"{label} is invalid.")
    return value


def _number(value: Any, label: str, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ServiceError(400, "INVALID_REQUEST", f"{label} is invalid.")
    result = float(value)
    if minimum is not None and result < minimum:
        raise ServiceError(400, "INVALID_REQUEST", f"{label} is invalid.")
    return result


def _integer(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ServiceError(400, "INVALID_REQUEST", f"{label} is invalid.")
    return value


def _document(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ServiceError(400, "INVALID_REQUEST", "ranking document is invalid.")
    return {
        "id": _string(value.get("id"), "document id", 500, allow_empty=False),
        "contentHash": _string(value.get("contentHash"), "content hash", 500, allow_empty=False),
        "title": _string(value.get("title"), "document title", 20_000),
        "summary": _string(value.get("summary"), "document summary", 50_000),
        "body": _string(value.get("body"), "document body"),
        "metadata": _string(value.get("metadata"), "document metadata", 50_000),
    }


def _documents(value: Any, max_scan: int) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise ServiceError(400, "INVALID_REQUEST", "documents must be an array.")
    if len(value) > max_scan:
        raise ServiceError(413, "SCAN_LIMIT", "Authorized document count exceeds the ranking capacity.")
    result = [_document(item) for item in value]
    ids = [item["id"] for item in result]
    if len(ids) != len(set(ids)):
        raise ServiceError(400, "INVALID_REQUEST", "ranking document ids must be unique.")
    return result


def _profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ServiceError(400, "INVALID_REQUEST", "ranking profile is required.")
    embedding = value.get("embeddingIdentity")
    reranker = value.get("rerankerIdentity")
    if embedding is not None:
        if not isinstance(embedding, dict):
            raise ServiceError(400, "INVALID_REQUEST", "embedding identity is invalid.")
        embedding = {
            "model": _string(embedding.get("model"), "embedding model", 500, allow_empty=False),
            "revision": _string(embedding.get("revision"), "embedding revision", 500, allow_empty=False),
            "dimensions": _integer(embedding.get("dimensions"), "embedding dimensions", 1),
        }
    if reranker is not None:
        if not isinstance(reranker, dict):
            raise ServiceError(400, "INVALID_REQUEST", "reranker identity is invalid.")
        reranker = {
            "model": _string(reranker.get("model"), "reranker model", 500, allow_empty=False),
            "revision": _string(reranker.get("revision"), "reranker revision", 500, allow_empty=False),
        }
    fusion = value.get("fusion", {})
    bm25f = value.get("bm25f", {})
    if not isinstance(fusion, dict) or not isinstance(bm25f, dict):
        raise ServiceError(400, "INVALID_REQUEST", "ranking profile options are invalid.")
    result = {
        "embeddingIdentity": embedding,
        "rerankerIdentity": reranker,
        "embeddingInstruction": _string(
            value.get("embeddingInstruction", DEFAULT_EMBEDDING_INSTRUCTION), "embedding instruction", 4_000,
            allow_empty=False,
        ),
        "rerankerInstruction": _string(
            value.get("rerankerInstruction", DEFAULT_RERANKER_INSTRUCTION), "reranker instruction", 4_000,
            allow_empty=False,
        ),
        "embeddingBatchSize": _integer(value.get("embeddingBatchSize", 16), "embedding batch size", 1),
        "minimumDenseScore": _number(value.get("minimumDenseScore", 0.1), "minimum dense score"),
        "denseTopK": _integer(value.get("denseTopK", 15), "dense top K", 1),
        "modelDeadlineMs": _integer(value.get("modelDeadlineMs", 120_000), "model deadline", 100),
        "rerankerEnabled": value.get("rerankerEnabled", False),
        "rerankTopN": _integer(value.get("rerankTopN", 20), "rerank top N", 1),
        "allowKeywordFallback": value.get("allowKeywordFallback", False),
        "fusion": {
            "rankConstant": _number(fusion.get("rankConstant", 60), "fusion rank constant", 0.000001),
            "keywordWeight": _number(fusion.get("keywordWeight", 0.55), "keyword weight", 0),
            "vectorWeight": _number(fusion.get("vectorWeight", 0.45), "vector weight", 0),
        },
        "bm25f": bm25f,
    }
    if not isinstance(result["rerankerEnabled"], bool) or not isinstance(result["allowKeywordFallback"], bool):
        raise ServiceError(400, "INVALID_REQUEST", "ranking profile flags are invalid.")
    if result["denseTopK"] > 100:
        raise ServiceError(400, "INVALID_REQUEST", "dense top K cannot exceed 100.")
    if result["fusion"]["keywordWeight"] + result["fusion"]["vectorWeight"] <= 0:
        raise ServiceError(400, "INVALID_REQUEST", "fusion weights cannot both be zero.")
    return result


def profile_version(profile: dict[str, Any]) -> str:
    serializable = {
        "version": "quick-hybrid-v1",
        "embeddingIdentity": profile["embeddingIdentity"],
        "rerankerIdentity": profile["rerankerIdentity"],
        "embeddingInstruction": profile["embeddingInstruction"],
        "rerankerInstruction": profile["rerankerInstruction"],
        "embeddingBatchSize": profile["embeddingBatchSize"],
        "minimumDenseScore": profile["minimumDenseScore"],
        "denseTopK": profile["denseTopK"],
        "fusion": profile["fusion"],
        "bm25f": profile["bm25f"],
        "rerankerEnabled": profile["rerankerEnabled"],
        "rerankTopN": profile["rerankTopN"],
    }
    encoded = _javascript_stable(serializable)
    return f"quick-hybrid-v1:{hashlib.sha256(encoded.encode()).hexdigest()[:16]}"


def _javascript_stable(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else json.dumps(value, allow_nan=False)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_javascript_stable(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            f"{json.dumps(key, ensure_ascii=False)}:{_javascript_stable(value[key])}" for key in sorted(value)
        ) + "}"
    raise TypeError(f"unsupported profile value {type(value).__name__}")


class Bm25fIndex:
    def __init__(self, documents: list[dict[str, str]], options: dict[str, Any]) -> None:
        self.documents = [
            {"id": document["id"], "fields": {field: tokenize_ranking_text(document[field]) for field in DEFAULT_FIELDS}}
            for document in documents
        ]
        self.k1 = _number(options.get("k1", 1.2), "BM25F k1", 0.000001)
        self.minimum_score = _number(options.get("minimumScore", 0), "BM25F minimum score")
        configured_fields = options.get("fields", DEFAULT_FIELDS)
        if not isinstance(configured_fields, dict) or set(configured_fields) != set(DEFAULT_FIELDS):
            raise ServiceError(400, "INVALID_REQUEST", "BM25F fields are invalid.")
        self.fields: dict[str, dict[str, float]] = {}
        for field, raw in configured_fields.items():
            if not isinstance(raw, dict):
                raise ServiceError(400, "INVALID_REQUEST", "BM25F field configuration is invalid.")
            weight = _number(raw.get("weight"), "BM25F field weight", 0)
            b = _number(raw.get("b"), "BM25F field b", 0)
            if b > 1:
                raise ServiceError(400, "INVALID_REQUEST", "BM25F field b is invalid.")
            self.fields[field] = {"weight": weight, "b": b}
        totals = {field: 0 for field in DEFAULT_FIELDS}
        self.document_frequency: dict[str, int] = {}
        for document in self.documents:
            unique: set[str] = set()
            for field in DEFAULT_FIELDS:
                tokens = document["fields"][field]
                totals[field] += len(tokens)
                unique.update(tokens)
            for token in unique:
                self.document_frequency[token] = self.document_frequency.get(token, 0) + 1
        count = max(1, len(self.documents))
        self.average_lengths = {field: totals[field] / count for field in DEFAULT_FIELDS}

    def search(self, query: str, excluded_terms: list[str]) -> tuple[list[dict[str, Any]], float]:
        started = time.perf_counter()
        terms = list(dict.fromkeys(tokenize_ranking_text(query)))
        excluded = set(token for term in excluded_terms for token in tokenize_ranking_text(term))
        hits: list[dict[str, Any]] = []
        for document in self.documents:
            frequencies = {
                field: {token: document["fields"][field].count(token) for token in set(document["fields"][field])}
                for field in DEFAULT_FIELDS
            }
            if any(any(term in frequencies[field] for field in DEFAULT_FIELDS) for term in excluded):
                continue
            score = 0.0
            for term in terms:
                frequency = self.document_frequency.get(term, 0)
                if frequency == 0:
                    continue
                weighted_frequency = 0.0
                for field in DEFAULT_FIELDS:
                    tf = frequencies[field].get(term, 0)
                    if tf == 0:
                        continue
                    average = max(1.0, self.average_lengths[field])
                    normalization = 1 - self.fields[field]["b"] + self.fields[field]["b"] * len(document["fields"][field]) / average
                    weighted_frequency += self.fields[field]["weight"] * tf / normalization
                inverse = math.log(1 + (len(self.documents) - frequency + 0.5) / (frequency + 0.5))
                score += inverse * (self.k1 + 1) * weighted_frequency / (self.k1 + weighted_frequency)
            if score > self.minimum_score:
                hits.append({"documentId": document["id"], "score": score})
        hits.sort(key=lambda item: (-item["score"], item["documentId"]))
        for rank, hit in enumerate(hits, start=1):
            hit["rank"] = rank
        return hits, max(0.0, (time.perf_counter() - started) * 1000)


def _projection(document: dict[str, str]) -> str:
    values = [
        f"title: {document['title']}",
        f"summary: {document['summary']}",
        f"evidence: {document['body']}" if document["body"] else "",
        f"metadata: {document['metadata']}" if document["metadata"] else "",
    ]
    return "\n".join(value for value in values if value)[:12_000]


def _stable(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


@dataclass
class PreparedCorpus:
    rows: dict[str, tuple[int, str]]
    vectors: np.ndarray
    identity: dict[str, Any]


@dataclass
class _PrepareFlight:
    key: str
    completed: threading.Event
    started: float
    total_documents: int
    batch_size: int
    request_ids: set[str] = field(default_factory=set)
    phase: str = "checking_cache"
    revision: int = 1
    completed_documents: int = 0
    resumed_documents: int = 0
    cache_hit: bool = False
    prepared: PreparedCorpus | None = None
    error: BaseException | None = None


class RetrievalRankingBackend:
    """Provider-neutral RAG ranking implementation behind the FastAPI boundary."""

    def __init__(
        self,
        model_backend: Any,
        vector_cache_dir: Path | None = None,
        checkpoint_every_batches: int = 8,
    ) -> None:
        if checkpoint_every_batches < 1:
            raise ValueError("checkpoint_every_batches must be positive")
        self.model_backend = model_backend
        self.vector_cache_dir = vector_cache_dir.resolve() if vector_cache_dir else None
        self.checkpoint_every_batches = checkpoint_every_batches
        self.prepared: PreparedCorpus | None = None
        self._prepare_lock = threading.Lock()
        self._prepare_flight: _PrepareFlight | None = None
        self._prepare_requests: dict[str, _PrepareFlight] = {}

    def descriptor(self) -> dict[str, Any]:
        return {
            "protocolVersion": RAG_PROTOCOL_VERSION,
            "loaded": True,
            "ranking": {
                "strategy": "quick-hybrid-v1", "bm25f": BM25F_VERSION,
                "dense": DENSE_RANKING_VERSION, "fusion": FUSION_VERSION,
                "vectorCache": VECTOR_CACHE_FORMAT_VERSION, "preparationProgressSchema": 1,
            },
        }

    def _verify_model_identity(self, profile: dict[str, Any], require_dense: bool) -> dict[str, Any] | None:
        identity = profile["embeddingIdentity"]
        if not require_dense:
            return identity
        descriptors = self.model_backend.descriptors()
        descriptor = next((item for item in descriptors if item.get("kind") == "embedding" and item.get("loaded")), None)
        if identity is None or descriptor is None or any(
            descriptor.get(key) != identity[source]
            for key, source in (("model", "model"), ("revision", "revision"), ("dimensions", "dimensions"))
        ):
            raise ServiceError(503, "HYBRID_UNAVAILABLE", "Configured embedding identity is not loaded.", retryable=True)
        return identity

    def _identity(self, documents: list[dict[str, str]], identity: dict[str, Any]) -> dict[str, Any]:
        return {
            **identity,
            "projectionVersion": DENSE_PROJECTION_VERSION,
            "documents": [{"id": item["id"], "contentHash": item["contentHash"]} for item in documents],
        }

    def _cache_key(self, identity: dict[str, Any]) -> str:
        return hashlib.sha256(_stable(identity).encode()).hexdigest()

    def _update_progress(self, flight: _PrepareFlight, **changes: Any) -> None:
        with self._prepare_lock:
            for name, value in changes.items():
                setattr(flight, name, value)
            flight.revision += 1

    def preparation_status(self, request_id: str) -> dict[str, Any]:
        with self._prepare_lock:
            flight = self._prepare_requests.get(request_id)
            if flight is None:
                raise ServiceError(404, "PREPARATION_NOT_FOUND", "Ranking preparation request was not found.")
            elapsed_ms = max(0.0, (time.perf_counter() - flight.started) * 1000)
            processed = max(0, flight.completed_documents - flight.resumed_documents)
            rate = processed / (elapsed_ms / 1000) if processed > 0 and elapsed_ms > 0 else 0.0
            remaining = max(0, flight.total_documents - flight.completed_documents)
            eta = remaining / rate * 1000 if rate > 0 else None
            return {
                "schemaVersion": 1,
                "phase": flight.phase,
                "revision": flight.revision,
                "completedDocuments": flight.completed_documents,
                "totalDocuments": flight.total_documents,
                "resumedDocuments": flight.resumed_documents,
                "batchSize": flight.batch_size,
                "cacheHit": flight.cache_hit,
                "elapsedMs": elapsed_ms,
                "documentsPerSecond": rate,
                "estimatedRemainingMs": eta,
            }

    def _vectors(
        self,
        documents: list[dict[str, str]],
        profile: dict[str, Any],
        flight: _PrepareFlight | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        identity = self._identity(documents, self._verify_model_identity(profile, True))
        store = VectorCacheStore(self.vector_cache_dir, self._cache_key(identity), identity)
        cached = store.load_final()
        if cached is not None:
            if flight is not None:
                self._update_progress(
                    flight,
                    completed_documents=len(documents),
                    resumed_documents=len(documents),
                    cache_hit=True,
                )
            return cached, identity
        batch_size = min(profile["embeddingBatchSize"], self.model_backend.max_batch_size)
        checkpoint = store.load_checkpoint()
        resumed = len(checkpoint)
        chunks = [checkpoint] if resumed > 0 else []
        pending: list[np.ndarray] = []
        if flight is not None:
            self._update_progress(
                flight,
                phase="embedding",
                completed_documents=resumed,
                resumed_documents=resumed,
                batch_size=batch_size,
            )
        batch_number = 0
        for offset in range(resumed, len(documents), batch_size):
            batch = documents[offset:offset + batch_size]
            values = np.asarray(self.model_backend.embed(
                [_projection(document) for document in batch], "document", None, identity["dimensions"]
            ), dtype=np.float32)
            if values.shape != (len(batch), identity["dimensions"]):
                raise ServiceError(500, "INVALID_VECTOR", "Document embedding dimensions changed.")
            chunks.append(values)
            pending.append(values)
            batch_number += 1
            completed = offset + len(batch)
            if batch_number % self.checkpoint_every_batches == 0 or completed == len(documents):
                store.append_checkpoint(np.concatenate(pending, axis=0))
                pending.clear()
            if flight is not None:
                self._update_progress(flight, completed_documents=completed)
        vectors = np.concatenate(chunks, axis=0) if chunks else np.empty((0, identity["dimensions"]), dtype=np.float32)
        if vectors.shape != (len(documents), identity["dimensions"]):
            raise ServiceError(500, "INVALID_VECTOR", "Document embedding dimensions changed.")
        if flight is not None:
            self._update_progress(flight, phase="publishing", completed_documents=len(documents))
        store.publish(vectors)
        return vectors, identity

    @staticmethod
    def _prepare_response(prepared: PreparedCorpus, profile: dict[str, Any], started: float) -> dict[str, Any]:
        identity = prepared.identity
        return {
            "documentCount": len(prepared.rows), "model": identity["model"], "revision": identity["revision"],
            "dimensions": identity["dimensions"], "elapsedMs": max(0.0, (time.perf_counter() - started) * 1000),
            "profileVersion": profile_version(profile),
        }

    def prepare(
        self,
        raw_documents: Any,
        raw_profile: Any,
        max_scan: int,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        documents = _documents(raw_documents, max_scan)
        profile = _profile(raw_profile)
        embedding_identity = self._verify_model_identity(profile, True)
        key = self._cache_key(self._identity(documents, embedding_identity))
        batch_size = min(profile["embeddingBatchSize"], self.model_backend.max_batch_size)

        with self._prepare_lock:
            prepared = self.prepared
            if prepared is not None and self._cache_key(prepared.identity) == key:
                if request_id is not None:
                    ready_flight = _PrepareFlight(
                        key=key,
                        completed=threading.Event(),
                        started=started,
                        total_documents=len(documents),
                        batch_size=batch_size,
                        phase="ready",
                        completed_documents=len(documents),
                        resumed_documents=len(documents),
                        cache_hit=True,
                    )
                    ready_flight.completed.set()
                    ready_flight.request_ids.add(request_id)
                    self._prepare_requests[request_id] = ready_flight
                return self._prepare_response(prepared, profile, started)
            flight = self._prepare_flight
            if flight is None:
                flight = _PrepareFlight(
                    key=key,
                    completed=threading.Event(),
                    started=started,
                    total_documents=len(documents),
                    batch_size=batch_size,
                )
                self._prepare_flight = flight
                leader = True
            elif flight.key == key:
                leader = False
            else:
                raise ServiceError(
                    429, "BACKPRESSURE", "A different ranking corpus is already being prepared.", retryable=True
                )
            if request_id is not None:
                flight.request_ids.add(request_id)
                self._prepare_requests[request_id] = flight

        if not leader:
            flight.completed.wait()
            if flight.error is not None:
                raise flight.error
            if flight.prepared is None:
                raise ServiceError(500, "INFERENCE_FAILED", "Shared ranking preparation completed without a result.")
            return self._prepare_response(flight.prepared, profile, started)

        try:
            vectors, identity = self._vectors(documents, profile, flight)
            prepared = PreparedCorpus(
                rows={document["id"]: (row, document["contentHash"]) for row, document in enumerate(documents)},
                vectors=vectors,
                identity=identity,
            )
        except BaseException as error:
            with self._prepare_lock:
                flight.error = error
                flight.phase = "failed"
                flight.revision += 1
                if self._prepare_flight is flight:
                    self._prepare_flight = None
                flight.completed.set()
            raise
        with self._prepare_lock:
            self.prepared = prepared
            flight.prepared = prepared
            flight.phase = "ready"
            flight.completed_documents = len(documents)
            flight.revision += 1
            if self._prepare_flight is flight:
                self._prepare_flight = None
            flight.completed.set()
        return self._prepare_response(prepared, profile, started)

    def _dense(self, documents: list[dict[str, str]], query: str, profile: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        started = time.perf_counter()
        prepared = self.prepared
        selected_rows: list[int] | None = None
        if prepared is not None and all(
            document["id"] in prepared.rows and prepared.rows[document["id"]][1] == document["contentHash"]
            for document in documents
        ):
            vectors, identity = prepared.vectors, prepared.identity
            selected_rows = [prepared.rows[document["id"]][0] for document in documents]
        else:
            vectors, identity = self._vectors(documents, profile)
        [query_vector] = self.model_backend.embed(
            [query], "query", profile["embeddingInstruction"], identity["dimensions"]
        )
        matrix = vectors if selected_rows is None else vectors[selected_rows]
        scores = matrix @ np.asarray(query_vector, dtype=np.float32)
        hits = [
            {"documentId": document["id"], "score": float(scores[index])}
            for index, document in enumerate(documents)
            if math.isfinite(float(scores[index])) and float(scores[index]) >= profile["minimumDenseScore"]
        ]
        hits.sort(key=lambda item: (-item["score"], item["documentId"]))
        # The threshold is only an eligibility guard. It must never turn dense
        # recall into a full-corpus ranking consumed page by page.
        hits = hits[:profile["denseTopK"]]
        for rank, hit in enumerate(hits, start=1):
            hit["rank"] = rank
        return hits, {
            "elapsedMs": max(0.0, (time.perf_counter() - started) * 1000),
            "model": identity["model"], "revision": identity["revision"], "dimensions": identity["dimensions"],
        }

    def rank(self, raw_documents: Any, raw_query: Any, raw_options: Any, raw_profile: Any) -> dict[str, Any]:
        if not isinstance(raw_options, dict):
            raise ServiceError(400, "INVALID_REQUEST", "rank options are required.")
        max_scan = _integer(raw_options.get("maxScan"), "max scan", 1)
        documents = _documents(raw_documents, max_scan)
        if not isinstance(raw_query, dict):
            raise ServiceError(400, "INVALID_REQUEST", "ranking query is required.")
        mode = raw_query.get("mode")
        if mode not in {"keyword", "dense", "hybrid"}:
            raise ServiceError(400, "INVALID_REQUEST", "ranking mode is invalid.")
        profile = _profile(raw_profile)
        query = {
            "text": _string(raw_query.get("text"), "ranking query", 12_000, allow_empty=False),
            "fastPath": raw_query.get("fastPath", False),
            "semanticText": raw_query.get("semanticText"),
            "keywordQuery": raw_query.get("keywordQuery"),
            "semanticHints": raw_query.get("semanticHints", []),
            "excludedTerms": raw_query.get("excludedTerms", []),
            "requiredConcepts": raw_query.get("requiredConcepts", []),
            "mode": mode,
        }
        if not isinstance(query["fastPath"], bool) or not all(isinstance(query[key], list) for key in ("semanticHints", "excludedTerms", "requiredConcepts")):
            raise ServiceError(400, "INVALID_REQUEST", "ranking query fields are invalid.")
        if query["semanticText"] is not None:
            query["semanticText"] = _string(query["semanticText"], "semantic query", 12_000, allow_empty=False)
        if not all(isinstance(item, str) for key in ("semanticHints", "excludedTerms") for item in query[key]):
            raise ServiceError(400, "INVALID_REQUEST", "ranking query terms are invalid.")
        keyword_query = query["keywordQuery"]
        if keyword_query is not None and (
            not isinstance(keyword_query, dict) or keyword_query.get("operator") not in {"and", "or"}
            or not isinstance(keyword_query.get("terms"), list) or not 1 <= len(keyword_query["terms"]) <= 8
            or not all(isinstance(term, str) and term.strip() for term in keyword_query["terms"])
        ):
            raise ServiceError(400, "INVALID_REQUEST", "keyword query is invalid.")
        excluded = {token for term in query["excludedTerms"] for token in tokenize_ranking_text(term)}
        allowed = [document for document in documents if not excluded.intersection(tokenize_ranking_text("\n".join(document.values())))]
        # A fast-path query without usable surface terms is intentionally dense-only.
        # Language is provenance and never selects a different retrieval algorithm.
        keyword_enabled = mode != "dense" and (not query["fastPath"] or keyword_query is not None)
        keyword_allowed = [document for document in allowed if self._keyword_eligible(document, query)] if keyword_enabled else []
        lexical: list[dict[str, Any]] | None = None
        lexical_elapsed = 0.0
        if keyword_enabled:
            text = " ".join(keyword_query["terms"]) if keyword_query and keyword_query["terms"] else query["text"]
            lexical, lexical_elapsed = Bm25fIndex(keyword_allowed, profile["bm25f"]).search(text, query["excludedTerms"])
            if keyword_query is not None:
                seen = {hit["documentId"] for hit in lexical}
                for document in sorted(keyword_allowed, key=lambda item: item["id"]):
                    if document["id"] not in seen:
                        lexical.append({"documentId": document["id"], "rank": len(lexical) + 1, "score": 0.0})
        keyword_execution = None if lexical is None else {
            "channel": "keyword", "implementation": "bm25f", "version": BM25F_VERSION,
            "resultCount": len(lexical), "elapsedMs": lexical_elapsed,
            "querySource": "direct_user_keywords" if query["fastPath"] else "agent_rewrite",
        }
        if mode == "keyword":
            hits = [self._channel_hit(item, "keyword") for item in lexical or []]
            return self._result(mode, "keyword", profile, hits, [keyword_execution], allowed, keyword_allowed, [])
        if profile["embeddingIdentity"] is None:
            if mode == "dense" or not profile["allowKeywordFallback"] or not lexical:
                raise ServiceError(503, "HYBRID_UNAVAILABLE", "Dense retrieval requires a configured embedding identity.", retryable=True)
            hits = [self._channel_hit(item, "keyword") for item in lexical or []]
            return self._result(mode, "keyword_fallback", profile, hits, [keyword_execution], allowed, keyword_allowed, ["dense_unavailable_keyword_fallback"])
        dense_query = "\n".join(filter(None, [query["semanticText"] or query["text"], *query["semanticHints"]]))
        try:
            dense, dense_meta = self._dense(allowed, dense_query, profile)
        except ServiceError:
            if mode == "dense" or not profile["allowKeywordFallback"] or not lexical:
                raise
            hits = [self._channel_hit(item, "keyword") for item in lexical or []]
            return self._result(mode, "keyword_fallback", profile, hits, [keyword_execution], allowed, keyword_allowed, ["dense_failed_keyword_fallback"])
        dense_execution = {
            "channel": "vector", "implementation": "exact_cosine", "version": DENSE_RANKING_VERSION,
            "resultCount": len(dense), **dense_meta,
            "querySource": "direct_user_original" if query["fastPath"] else "agent_rewrite",
        }
        if mode == "dense":
            return self._result(mode, "dense", profile, [self._channel_hit(item, "vector") for item in dense], [dense_execution], allowed, keyword_allowed, [])
        fused = bool(lexical)
        hits = self._fusion(lexical, dense, profile["fusion"]) if fused else [self._channel_hit(item, "vector") for item in dense]
        channels = [keyword_execution, dense_execution]
        warnings = [] if fused else ["keyword_no_hits_dense_only" if lexical is not None else "keyword_unavailable_dense_only"]
        reranker = None
        if profile["rerankerEnabled"] and hits:
            hits, reranker, warning, execution = self._rerank(hits, allowed, query, profile)
            if warning:
                warnings.append(warning)
            if execution:
                channels.append(execution)
        result = self._result(mode, "hybrid" if fused else "dense", profile, hits, channels, allowed, keyword_allowed, warnings)
        if fused:
            result["execution"]["fusion"] = {
                "method": "weighted_rrf", "version": FUSION_VERSION, **profile["fusion"],
            }
        if reranker is not None:
            result["execution"]["reranker"] = reranker
        return result

    def _keyword_eligible(self, document: dict[str, str], query: dict[str, Any]) -> bool:
        searchable = unicodedata.normalize("NFKC", "\n".join(document[field] for field in DEFAULT_FIELDS)).lower()
        keyword = query["keywordQuery"]
        if keyword is not None:
            matches = [unicodedata.normalize("NFKC", term).strip().lower() in searchable for term in keyword["terms"]]
            return all(matches) if keyword["operator"] == "and" else any(matches)
        for concept in query["requiredConcepts"]:
            if not isinstance(concept, dict) or not isinstance(concept.get("alternatives"), list):
                raise ServiceError(400, "INVALID_REQUEST", "required concepts are invalid.")
            alternatives = [unicodedata.normalize("NFKC", item).strip().lower() for item in concept["alternatives"] if isinstance(item, str)]
            if not any(item and item in searchable for item in alternatives):
                return False
        return True

    @staticmethod
    def _channel_hit(hit: dict[str, Any], channel: str) -> dict[str, Any]:
        return {**hit, "channels": [{"channel": channel, "rank": hit["rank"], "score": hit["score"]}]}

    @staticmethod
    def _fusion(keyword: Iterable[dict[str, Any]], dense: Iterable[dict[str, Any]], options: dict[str, float]) -> list[dict[str, Any]]:
        rows: dict[str, dict[str, Any]] = {}
        for channel, hits, weight in (("keyword", keyword, options["keywordWeight"]), ("vector", dense, options["vectorWeight"])):
            if weight == 0:
                continue
            for hit in hits:
                row = rows.setdefault(hit["documentId"], {"score": 0.0, "channels": []})
                row["score"] += weight / (options["rankConstant"] + hit["rank"])
                row["channels"].append({"channel": channel, "rank": hit["rank"], "score": hit["score"]})
        values = [{"documentId": key, **value} for key, value in rows.items()]
        values.sort(key=lambda item: (-item["score"], item["documentId"]))
        for rank, hit in enumerate(values, start=1):
            hit["rank"] = rank
        return values

    def _rerank(self, hits: list[dict[str, Any]], documents: list[dict[str, str]], query: dict[str, Any], profile: dict[str, Any]) -> tuple[list[dict[str, Any]], Any, str | None, Any]:
        started = time.perf_counter()
        identity = profile["rerankerIdentity"]
        descriptor = next((item for item in self.model_backend.descriptors() if item.get("kind") == "reranker" and item.get("loaded")), None)
        if identity is None or descriptor is None or descriptor.get("model") != identity["model"] or descriptor.get("revision") != identity["revision"]:
            return hits, None, "reranker_failed_open", None
        selected = hits[:profile["rerankTopN"]]
        by_id = {document["id"]: document for document in documents}
        try:
            ranked = self.model_backend.rerank(
                query["semanticText"] or query["text"],
                [{"id": hit["documentId"], "text": "\n".join([by_id[hit["documentId"]]["title"], by_id[hit["documentId"]]["summary"], by_id[hit["documentId"]]["body"]])[:12_000]} for hit in selected],
                profile["rerankerInstruction"], len(selected),
            )
        except ServiceError:
            return hits, None, "reranker_failed_open", None
        rank_by_id = {item["id"]: item for item in ranked}
        hits.sort(key=lambda item: (rank_by_id.get(item["documentId"], {}).get("rank", len(hits) + item["rank"]), item["rank"]))
        for rank, hit in enumerate(hits, start=1):
            hit["rank"] = rank
            score = rank_by_id.get(hit["documentId"])
            if score is not None:
                hit["channels"].append({"channel": "reranker", "rank": score["rank"], "score": score["score"]})
        metadata = {"model": identity["model"], "revision": identity["revision"], "topN": len(selected), "scoreKind": "yes_probability"}
        execution = {
            "channel": "reranker", "implementation": "qwen_yes_no", "version": "qwen-reranker-v1",
            "resultCount": len(ranked), "elapsedMs": max(0.0, (time.perf_counter() - started) * 1000),
            "model": identity["model"], "revision": identity["revision"],
        }
        return hits, metadata, None, execution

    @staticmethod
    def _result(requested: str, executed: str, profile: dict[str, Any], hits: list[dict[str, Any]], channels: list[Any], allowed: list[Any], keyword_allowed: list[Any], warnings: list[str]) -> dict[str, Any]:
        return {
            "hits": hits,
            "execution": {
                "requestedMode": requested, "executedMode": executed,
                "strategyVersion": profile_version(profile), "channels": [item for item in channels if item is not None],
            },
            "scanned": len(allowed), "keywordEligible": len(keyword_allowed), "rankedHits": len(hits), "warnings": warnings,
        }
