from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np

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


def profile() -> dict[str, Any]:
    return {
        "embeddingIdentity": {"model": "fake-embedding", "revision": "fake-v1", "dimensions": 2},
        "embeddingInstruction": "retrieve",
        "rerankerInstruction": "judge",
        "embeddingBatchSize": 16,
        "modelDeadlineMs": 5_000,
        "minimumDenseScore": 0.1,
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


def test_tokenizer_and_profile_identity_are_versioned() -> None:
    assert tokenize_ranking_text("APP登录提示") == ["app", "登", "录", "提", "示", "登录", "录提", "提示"]
    assert BM25F_VERSION.endswith("unicode-han-bigram-v1")
    assert RAG_PROTOCOL_VERSION == "retrieval-agent.rag.v1"
    assert profile_version({
        **profile(), "embeddingIdentity": profile()["embeddingIdentity"], "rerankerIdentity": None,
    }) == "quick-hybrid-v1:15528de79176c9a8"


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


def test_keyword_mode_does_not_require_an_embedding_identity() -> None:
    value = profile()
    value.pop("embeddingIdentity")
    backend = RetrievalRankingBackend(FakeModels())
    result = backend.rank(documents(), {
        "text": "副卡跨域", "semanticHints": [], "excludedTerms": [], "requiredConcepts": [], "mode": "keyword",
    }, {"maxScan": 10}, value)
    assert result["execution"]["executedMode"] == "keyword"
    assert result["hits"][0]["documentId"] == "lexical"
