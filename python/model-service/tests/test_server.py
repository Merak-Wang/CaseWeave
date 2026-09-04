from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import httpx

from retrieval_agent_model_service import PROTOCOL_VERSION
from retrieval_agent_model_service.ranking import RAG_PROTOCOL_VERSION, RetrievalRankingBackend
from retrieval_agent_model_service.server import create_app


class FakeBackend:
    device = "test"
    max_batch_size = 16
    max_total_tokens = 8192
    max_rerank_candidates = 20
    manifest = SimpleNamespace(
        embedding=SimpleNamespace(model="embedding", revision="embed-v1", dimensions=2),
        reranker=SimpleNamespace(model="reranker", revision="rerank-v1"),
    )

    def descriptors(self) -> list[dict[str, Any]]:
        return [
            {
                "model": "embedding", "revision": "embed-v1", "kind": "embedding",
                "loaded": True, "dtype": "float32", "device": "test", "maxTokens": 512,
                "dimensions": 2, "pooling": "last_token", "normalization": "l2",
            },
            {
                "model": "reranker", "revision": "rerank-v1", "kind": "reranker",
                "loaded": True, "dtype": "float32", "device": "test", "maxTokens": 512,
                "scoreKind": "yes_probability",
            },
        ]

    def query_analysis_descriptor(self) -> dict[str, Any]:
        return {
            "engine": "spacy", "engineVersion": "3.8.7", "pipeline": "zh_core_web_sm-3.8.0",
            "pipelineVersion": "3.8.0", "lexiconVersion": "telecom-query-phrases-v1",
            "loaded": True, "components": ["tagger", "parser"],
        }

    def analyze_query(self, query: str) -> dict[str, Any]:
        return {
            "language": "zh", "keywords": ["副卡", "跨域"],
            "candidates": [], "tokens": [], "entities": [],
            "triples": [{"subject": "副卡", "predicate": "and", "object": "跨域", "source": "coordination"}],
            "boolean": {"operator": "and", "terms": ["副卡", "跨域"], "grouping": "single_set"},
        }

    def embed(self, texts: list[str], input_type: str, instruction: str | None, dimensions: int) -> list[list[float]]:
        assert input_type in {"query", "document"}
        assert dimensions == 2
        return [[1.0, 0.0] for _ in texts]

    def rerank(self, query: str, candidates: list[dict[str, str]], instruction: str, top_k: int) -> list[dict[str, Any]]:
        assert query and instruction
        return [
            {"id": item["id"], "inputIndex": index, "score": 0.9 - index / 10, "rank": index + 1}
            for index, item in enumerate(candidates[:top_k])
        ]


def call(method: str, path: str, body: dict[str, Any] | None = None) -> httpx.Response:
    async def execute() -> httpx.Response:
        transport = httpx.ASGITransport(app=create_app(FakeBackend()))
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, json=body)
    return asyncio.run(execute())


def test_health_embedding_and_query_analysis_protocol() -> None:
    ready = call("GET", "/health/ready")
    assert ready.status_code == 200
    assert ready.json()["protocolVersion"] == PROTOCOL_VERSION
    assert ready.json()["queryAnalysis"]["engine"] == "spacy"

    result = call("POST", "/v1/embeddings", {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "embed-1",
        "model": "embedding",
        "input": ["query"],
        "inputType": "query",
        "dimensions": 2,
        "normalize": True,
        "instruction": "retrieve",
    })
    assert result.status_code == 200
    assert result.json()["data"] == [{"index": 0, "embedding": [1.0, 0.0]}]

    analysis = call("POST", "/v1/query-analysis", {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "nlp-1",
        "query": "帮我找副卡和跨域有关工单",
    })
    assert analysis.status_code == 200
    assert analysis.json()["keywords"] == ["副卡", "跨域"]
    assert analysis.json()["boolean"]["operator"] == "and"


def test_rejects_protocol_drift_and_duplicate_rerank_ids() -> None:
    error = call("POST", "/v1/embeddings", {
        "protocolVersion": "old",
        "requestId": "bad",
    })
    assert error.status_code == 409
    assert error.json()["error"]["code"] == "PROTOCOL_MISMATCH"

    error = call("POST", "/v1/rerank", {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "rerank-1",
        "model": "reranker",
        "query": "q",
        "instruction": "judge",
        "topK": 1,
        "candidates": [{"id": "same", "text": "A"}, {"id": "same", "text": "B"}],
    })
    assert error.status_code == 400
    assert error.json()["error"]["code"] == "INVALID_REQUEST"


def test_rag_ranking_endpoint_uses_a_separate_versioned_protocol() -> None:
    profile = {
        "embeddingInstruction": "retrieve", "rerankerInstruction": "judge",
        "embeddingBatchSize": 16, "modelDeadlineMs": 5_000, "minimumDenseScore": 0.1, "denseTopK": 15,
        "fusion": {"rankConstant": 60, "keywordWeight": 0.55, "vectorWeight": 0.45},
        "bm25f": {}, "rerankerEnabled": False, "rerankTopN": 20, "allowKeywordFallback": False,
    }
    ranked = call("POST", "/v1/ranking/rank", {
        "protocolVersion": RAG_PROTOCOL_VERSION, "requestId": "rank-1",
        "documents": [{
            "id": "ticket-1", "contentHash": "hash-1", "title": "副卡跨域失败",
            "summary": "办理失败", "body": "", "metadata": "",
        }],
        "query": {"text": "副卡跨域", "semanticHints": [], "excludedTerms": [], "mode": "keyword"},
        "options": {"maxScan": 10, "deadlineMs": 5_000}, "profile": profile,
    })
    assert ranked.status_code == 200
    assert ranked.json()["protocolVersion"] == RAG_PROTOCOL_VERSION
    assert ranked.json()["result"]["hits"][0]["documentId"] == "ticket-1"

    mismatch = call("POST", "/v1/ranking/rank", {
        "protocolVersion": PROTOCOL_VERSION, "requestId": "bad-ranking", "input": {},
    })
    assert mismatch.status_code == 409
    assert mismatch.json()["protocolVersion"] == RAG_PROTOCOL_VERSION


def test_rag_prepare_progress_endpoint_reports_completed_work() -> None:
    async def execute() -> tuple[httpx.Response, httpx.Response]:
        model_backend = FakeBackend()
        ranking_backend = RetrievalRankingBackend(model_backend)
        transport = httpx.ASGITransport(app=create_app(model_backend, ranking_backend))
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            prepared = await client.post("/v1/ranking/prepare", json={
                "protocolVersion": RAG_PROTOCOL_VERSION,
                "requestId": "prepare-observable",
                "documents": [{
                    "id": "ticket-1", "contentHash": "hash-1", "title": "副卡跨域失败",
                    "summary": "办理失败", "body": "", "metadata": "",
                }],
                "options": {"maxScan": 10},
                "profile": {
                    "embeddingInstruction": "retrieve", "rerankerInstruction": "judge",
                    "embeddingBatchSize": 16, "modelDeadlineMs": 5_000,
                    "minimumDenseScore": 0.1, "denseTopK": 15,
                    "fusion": {"rankConstant": 60, "keywordWeight": 0.55, "vectorWeight": 0.45},
                    "bm25f": {}, "rerankerEnabled": False, "rerankTopN": 20,
                    "allowKeywordFallback": False,
                    "embeddingIdentity": {"model": "embedding", "revision": "embed-v1", "dimensions": 2},
                },
            })
            progress = await client.get("/v1/ranking/prepare/prepare-observable")
            return prepared, progress

    prepared, progress = asyncio.run(execute())
    assert prepared.status_code == 200
    assert progress.status_code == 200
    assert progress.json()["protocolVersion"] == RAG_PROTOCOL_VERSION
    assert progress.json()["requestId"] == "prepare-observable"
    assert progress.json()["progress"]["phase"] == "ready"
    assert progress.json()["progress"]["completedDocuments"] == 1
