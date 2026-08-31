from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from typing import Any, Iterator
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from retrieval_agent_model_service import PROTOCOL_VERSION
from retrieval_agent_model_service.server import ModelRequestHandler


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


@contextmanager
def service() -> Iterator[str]:
    handler = type("TestModelRequestHandler", (ModelRequestHandler,), {"backend": FakeBackend()})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request(base_url: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    value = None if body is None else json.dumps(body).encode("utf-8")
    call = Request(
        f"{base_url}{path}", data=value,
        headers={"content-type": "application/json"} if value is not None else {},
        method="POST" if value is not None else "GET",
    )
    try:
        with urlopen(call, timeout=2) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        return error.code, json.loads(error.read())


def test_health_and_embedding_protocol() -> None:
    with service() as base_url:
        status, ready = request(base_url, "/health/ready")
        assert status == 200
        assert ready["protocolVersion"] == PROTOCOL_VERSION
        assert ready["models"][0]["pooling"] == "last_token"

        status, result = request(base_url, "/v1/embeddings", {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": "embed-1",
            "model": "embedding",
            "input": ["query"],
            "inputType": "query",
            "dimensions": 2,
            "normalize": True,
            "instruction": "retrieve",
        })
        assert status == 200
        assert result["requestId"] == "embed-1"
        assert result["data"] == [{"index": 0, "embedding": [1.0, 0.0]}]


def test_rejects_protocol_drift_and_duplicate_rerank_ids() -> None:
    with service() as base_url:
        status, error = request(base_url, "/v1/embeddings", {
            "protocolVersion": "old",
            "requestId": "bad",
        })
        assert status == 409
        assert error["error"]["code"] == "PROTOCOL_MISMATCH"

        status, error = request(base_url, "/v1/rerank", {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": "rerank-1",
            "model": "reranker",
            "query": "q",
            "instruction": "judge",
            "topK": 1,
            "candidates": [{"id": "same", "text": "A"}, {"id": "same", "text": "B"}],
        })
        assert status == 400
        assert error["error"]["code"] == "INVALID_REQUEST"
