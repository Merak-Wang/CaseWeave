from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
import time
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from retrieval_agent_model_service.errors import ServiceError
from retrieval_agent_model_service.ranking import (
    BM25F_VERSION,
    RAG_PROTOCOL_VERSION,
    RetrievalRankingBackend,
    profile_version,
    tokenize_ranking_text,
)


class FakeModels:
    max_batch_size = 16
    manifest = SimpleNamespace(embedding=SimpleNamespace(dimensions=2))

    def descriptors(self) -> list[dict[str, Any]]:
        return [{
            "kind": "embedding", "loaded": True, "model": "fake-embedding",
            "revision": "fake-v1", "dimensions": 2,
        }]

    def embed(self, texts: list[str], input_type: str, instruction: str | None, dimensions: int) -> list[list[float]]:
        assert input_type in {"query", "document"}
        assert dimensions == 2
        result = []
        for text in texts:
            lowered = text.lower()
            vector = np.asarray([1.0, 0.1] if "semantic" in lowered or "套餐" in text else [0.1, 1.0])
            vector /= np.linalg.norm(vector)
            result.append(vector.tolist())
        return result


class BlockingRecordingModels(FakeModels):
    def __init__(self) -> None:
        self.document_embed_started = Event()
        self.release_document_embed = Event()
        self._calls_lock = Lock()
        self.document_embed_calls = 0
        self.rerank_calls = 0
        self.document_error: ServiceError | None = None

    def descriptors(self) -> list[dict[str, Any]]:
        return [
            *super().descriptors(),
            {
                "kind": "reranker", "loaded": True, "model": "fake-reranker",
                "revision": "reranker-v1",
            },
        ]

    def embed(self, texts: list[str], input_type: str, instruction: str | None, dimensions: int) -> list[list[float]]:
        if input_type == "document":
            with self._calls_lock:
                self.document_embed_calls += 1
            self.document_embed_started.set()
            if not self.release_document_embed.wait(timeout=2):
                raise TimeoutError("test did not release document embedding")
            if self.document_error is not None:
                raise self.document_error
        return super().embed(texts, input_type, instruction, dimensions)

    def rerank(self, query: str, candidates: list[dict[str, str]], instruction: str, top_k: int) -> list[dict[str, Any]]:
        with self._calls_lock:
            self.rerank_calls += 1
        return [
            {"id": item["id"], "inputIndex": index, "score": 0.9 - index / 10, "rank": index + 1}
            for index, item in enumerate(candidates[:top_k])
        ]


class CheckpointRecordingModels(FakeModels):
    max_batch_size = 2

    def __init__(self, fail_on_call: int | None = None) -> None:
        self.fail_on_call = fail_on_call
        self.document_embed_calls = 0
        self.embedded_documents = 0

    def embed(self, texts: list[str], input_type: str, instruction: str | None, dimensions: int) -> list[list[float]]:
        if input_type == "document":
            self.document_embed_calls += 1
            if self.document_embed_calls == self.fail_on_call:
                raise RuntimeError("simulated interrupted cold preparation")
            self.embedded_documents += len(texts)
        return super().embed(texts, input_type, instruction, dimensions)


def profile() -> dict[str, Any]:
    return {
        "embeddingIdentity": {"model": "fake-embedding", "revision": "fake-v1", "dimensions": 2},
        "embeddingInstruction": "retrieve",
        "rerankerInstruction": "judge",
        "embeddingBatchSize": 16,
        "modelDeadlineMs": 5_000,
        "minimumDenseScore": 0.1,
        "denseTopK": 15,
        "fusion": {"rankConstant": 60, "keywordWeight": 0.55, "vectorWeight": 0.45},
        "bm25f": {},
        "rerankerEnabled": False,
        "rerankTopN": 20,
        "allowKeywordFallback": False,
    }


def documents() -> list[dict[str, str]]:
    return [
        {"id": "lexical", "contentHash": "h1", "title": "副卡跨域失败", "summary": "关键词命中", "body": "", "metadata": ""},
        {"id": "semantic", "contentHash": "h2", "title": "家庭套餐状态异常", "summary": "semantic match", "body": "", "metadata": ""},
        {"id": "other", "contentHash": "h3", "title": "打印机缺纸", "summary": "other", "body": "", "metadata": ""},
    ]


def checkpoint_documents() -> list[dict[str, str]]:
    return [
        {
            "id": f"checkpoint-{index}", "contentHash": f"checkpoint-hash-{index}",
            "title": f"套餐状态 {index}", "summary": "semantic match", "body": "", "metadata": "",
        }
        for index in range(5)
    ]


def test_tokenizer_and_profile_identity_are_versioned() -> None:
    assert tokenize_ranking_text("APP登录提示") == ["app", "登", "录", "提", "示", "登录", "录提", "提示"]
    assert BM25F_VERSION.endswith("unicode-han-bigram-v1")
    assert RAG_PROTOCOL_VERSION == "retrieval-agent.rag.v1"
    assert profile_version({
        **profile(), "embeddingIdentity": profile()["embeddingIdentity"], "rerankerIdentity": None,
    }) == "quick-hybrid-v1:67ff143236a8839a"


def test_hybrid_keeps_keyword_and_semantic_candidates_and_caches_vectors(tmp_path) -> None:
    models = FakeModels()
    backend = RetrievalRankingBackend(models, tmp_path)
    prepared = backend.prepare(documents(), profile(), 10)
    assert prepared["documentCount"] == 3
    assert list(tmp_path.glob("*.f32"))

    result = backend.rank(documents(), {
        "text": "semantic 套餐问题", "fastPath": True,
        "keywordQuery": {"terms": ["副卡", "跨域"], "operator": "and"},
        "semanticHints": [], "excludedTerms": [], "requiredConcepts": [], "mode": "hybrid",
    }, {"maxScan": 10}, profile())

    assert {hit["documentId"] for hit in result["hits"]} >= {"lexical", "semantic"}
    assert [channel["channel"] for channel in result["execution"]["channels"]] == ["keyword", "vector"]
    assert result["keywordEligible"] == 1
    assert result["execution"]["fusion"]["method"] == "weighted_rrf"


def test_concurrent_prepare_shares_embedding_work_and_reranks_only_during_query() -> None:
    models = BlockingRecordingModels()
    backend = RetrievalRankingBackend(models)
    reranking_profile = {
        **profile(),
        "rerankerIdentity": {"model": "fake-reranker", "revision": "reranker-v1"},
        "rerankerEnabled": True,
    }

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(backend.prepare, documents(), profile(), 10)
        assert models.document_embed_started.wait(timeout=1)
        second = executor.submit(backend.prepare, documents(), reranking_profile, 10)
        time.sleep(0.05)
        models.release_document_embed.set()
        assert first.result(timeout=2)["documentCount"] == 3
        assert second.result(timeout=2)["profileVersion"] == profile_version(reranking_profile)

    assert models.document_embed_calls == 1
    assert models.rerank_calls == 0
    assert backend.prepare(documents(), reranking_profile, 10)["documentCount"] == 3
    assert models.document_embed_calls == 1

    result = backend.rank(documents(), {
        "text": "semantic 套餐问题", "fastPath": False,
        "semanticHints": [], "excludedTerms": [], "requiredConcepts": [], "mode": "hybrid",
    }, {"maxScan": 10}, reranking_profile)
    assert models.rerank_calls == 1
    assert result["execution"]["reranker"]["model"] == "fake-reranker"


def test_concurrent_prepare_followers_receive_the_leader_service_error() -> None:
    models = BlockingRecordingModels()
    models.document_error = ServiceError(503, "NOT_READY", "embedding unavailable", retryable=True)
    backend = RetrievalRankingBackend(models)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(backend.prepare, documents(), profile(), 10)
        assert models.document_embed_started.wait(timeout=1)
        second = executor.submit(backend.prepare, documents(), profile(), 10)
        time.sleep(0.05)
        models.release_document_embed.set()
        for future in (first, second):
            with pytest.raises(ServiceError) as captured:
                future.result(timeout=2)
            assert captured.value.code == "NOT_READY"
            assert captured.value.retryable is True

    assert models.document_embed_calls == 1


def test_concurrent_prepare_rejects_a_different_corpus() -> None:
    models = BlockingRecordingModels()
    backend = RetrievalRankingBackend(models)
    different_documents = [*documents()]
    different_documents[0] = {
        **different_documents[0],
        "contentHash": "changed-hash",
        "summary": "changed content",
    }

    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(backend.prepare, documents(), profile(), 10)
        assert models.document_embed_started.wait(timeout=1)
        with pytest.raises(ServiceError) as captured:
            backend.prepare(different_documents, profile(), 10)
        assert captured.value.code == "BACKPRESSURE"
        assert captured.value.retryable is True
        models.release_document_embed.set()
        assert first.result(timeout=2)["documentCount"] == 3

    assert models.document_embed_calls == 1


def test_prepare_exposes_observable_progress_while_embedding() -> None:
    models = BlockingRecordingModels()
    backend = RetrievalRankingBackend(models)

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(backend.prepare, documents(), profile(), 10, "observable-prepare")
        assert models.document_embed_started.wait(timeout=1)
        progress = backend.preparation_status("observable-prepare")
        assert progress == {
            "schemaVersion": 1,
            "phase": "embedding",
            "revision": 2,
            "completedDocuments": 0,
            "totalDocuments": 3,
            "resumedDocuments": 0,
            "batchSize": 16,
            "cacheHit": False,
            "elapsedMs": pytest.approx(progress["elapsedMs"], abs=100),
            "documentsPerSecond": 0.0,
            "estimatedRemainingMs": None,
        }
        models.release_document_embed.set()
        assert future.result(timeout=2)["documentCount"] == 3

    completed = backend.preparation_status("observable-prepare")
    assert completed["phase"] == "ready"
    assert completed["completedDocuments"] == 3
    assert completed["revision"] > progress["revision"]


def test_prepare_resumes_from_a_persisted_batch_checkpoint(tmp_path) -> None:
    first_models = CheckpointRecordingModels(fail_on_call=2)
    first_backend = RetrievalRankingBackend(first_models, tmp_path, checkpoint_every_batches=1)
    corpus = checkpoint_documents()

    with pytest.raises(RuntimeError, match="interrupted cold preparation"):
        first_backend.prepare(corpus, profile(), 10, "interrupted-prepare")
    failed = first_backend.preparation_status("interrupted-prepare")
    assert failed["phase"] == "failed"
    assert failed["completedDocuments"] == 2
    assert list(tmp_path.glob("*.partial.json"))
    assert list(tmp_path.glob("*.partial.f32"))

    resumed_models = CheckpointRecordingModels()
    resumed_backend = RetrievalRankingBackend(resumed_models, tmp_path, checkpoint_every_batches=1)
    result = resumed_backend.prepare(corpus, profile(), 10, "resumed-prepare")

    assert result["documentCount"] == 5
    assert resumed_models.embedded_documents == 3
    progress = resumed_backend.preparation_status("resumed-prepare")
    assert progress["phase"] == "ready"
    assert progress["resumedDocuments"] == 2
    assert progress["completedDocuments"] == 5
    assert not list(tmp_path.glob("*.partial.json"))
    assert not list(tmp_path.glob("*.partial.f32"))
    assert list(tmp_path.glob("*.json"))
    assert list(tmp_path.glob("*.f32"))


def test_keyword_mode_does_not_require_an_embedding_identity() -> None:
    value = profile()
    value.pop("embeddingIdentity")
    backend = RetrievalRankingBackend(FakeModels())
    result = backend.rank(documents(), {
        "text": "副卡跨域", "semanticHints": [], "excludedTerms": [], "requiredConcepts": [], "mode": "keyword",
    }, {"maxScan": 10}, value)
    assert result["execution"]["executedMode"] == "keyword"
    assert result["hits"][0]["documentId"] == "lexical"


def test_dense_is_top_15_while_keyword_matches_are_unbounded() -> None:
    corpus = [
        {
            "id": f"doc-{index:02d}", "contentHash": f"hash-{index}",
            "title": "semantic keyword match", "summary": f"case {index}", "body": "", "metadata": "",
        }
        for index in range(25)
    ]
    backend = RetrievalRankingBackend(FakeModels())
    dense = backend.rank(corpus, {
        "text": "semantic", "semanticHints": [], "excludedTerms": [],
        "requiredConcepts": [], "mode": "dense",
    }, {"maxScan": 100}, profile())
    keyword = backend.rank(corpus, {
        "text": "keyword", "keywordQuery": {"terms": ["keyword"], "operator": "and"},
        "semanticHints": [], "excludedTerms": [], "requiredConcepts": [], "mode": "keyword",
    }, {"maxScan": 100}, profile())
    hybrid = backend.rank(corpus, {
        "text": "semantic", "keywordQuery": {"terms": ["case 24"], "operator": "and"},
        "semanticHints": [], "excludedTerms": [], "requiredConcepts": [], "mode": "hybrid",
    }, {"maxScan": 100}, profile())

    assert len(dense["hits"]) == 15
    assert dense["execution"]["channels"][0]["resultCount"] == 15
    assert len(keyword["hits"]) == 25
    assert keyword["keywordEligible"] == 25
    assert len(hybrid["hits"]) == 16
    assert hybrid["keywordEligible"] == 1
    assert hybrid["execution"]["channels"][1]["resultCount"] == 15


def test_hybrid_keyword_miss_uses_dense_only_for_cross_language_semantics() -> None:
    backend = RetrievalRankingBackend(FakeModels())
    result = backend.rank(documents(), {
        "text": "semantic billing issue", "fastPath": True,
        "keywordQuery": {"terms": ["billing"], "operator": "and"},
        "semanticHints": [], "excludedTerms": [], "requiredConcepts": [], "mode": "hybrid",
    }, {"maxScan": 10}, profile())

    assert result["keywordEligible"] == 0
    assert result["execution"]["requestedMode"] == "hybrid"
    assert result["execution"]["executedMode"] == "dense"
    assert "fusion" not in result["execution"]
    assert result["warnings"] == ["keyword_no_hits_dense_only"]
    assert all({channel["channel"] for channel in hit["channels"]} == {"vector"} for hit in result["hits"])


def test_fast_path_without_keywords_skips_keyword_channel_and_keeps_dense() -> None:
    backend = RetrievalRankingBackend(FakeModels())
    result = backend.rank(documents(), {
        "text": "semantic equivalent query", "fastPath": True,
        "semanticHints": [], "excludedTerms": [], "requiredConcepts": [], "mode": "hybrid",
    }, {"maxScan": 10}, profile())

    assert result["keywordEligible"] == 0
    assert result["execution"]["executedMode"] == "dense"
    assert [channel["channel"] for channel in result["execution"]["channels"]] == ["vector"]
    assert result["warnings"] == ["keyword_unavailable_dense_only"]
