from __future__ import annotations

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from . import PROTOCOL_VERSION, SERVICE_VERSION
from .errors import ServiceError


class ModelRequestHandler(BaseHTTPRequestHandler):
    backend: Any = None
    max_body_bytes = 2 * 1024 * 1024

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, error: ServiceError, request_id: str | None = None) -> None:
        self._send(error.status, {
            "protocolVersion": PROTOCOL_VERSION,
            **({"requestId": request_id} if request_id else {}),
            "error": {"code": error.code, "message": error.message, "retryable": error.retryable},
        })

    def _ready(self) -> dict[str, Any]:
        models = self.backend.descriptors()
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "serviceVersion": SERVICE_VERSION,
            "ready": bool(models) and all(model["loaded"] for model in models),
            "device": self.backend.device,
            "models": models,
            "limits": {
                "maxBatchSize": self.backend.max_batch_size,
                "maxTotalTokens": self.backend.max_total_tokens,
                "maxRerankCandidates": self.backend.max_rerank_candidates,
            },
        }

    def do_GET(self) -> None:
        if self.path == "/health/live":
            self._send(200, {"protocolVersion": PROTOCOL_VERSION, "serviceVersion": SERVICE_VERSION, "live": True})
        elif self.path == "/health/ready":
            value = self._ready()
            self._send(200 if value["ready"] else 503, value)
        else:
            self._error(ServiceError(404, "NOT_FOUND", "Unknown endpoint."))

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError as error:
            raise ServiceError(400, "INVALID_REQUEST", "Invalid Content-Length.") from error
        if length < 2 or length > self.max_body_bytes:
            raise ServiceError(413, "BODY_LIMIT", "Request body exceeds the configured limit.")
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ServiceError(400, "INVALID_JSON", "Request body must be JSON.") from error
        if not isinstance(value, dict):
            raise ServiceError(400, "INVALID_REQUEST", "Request body must be an object.")
        if value.get("protocolVersion") != PROTOCOL_VERSION:
            raise ServiceError(409, "PROTOCOL_MISMATCH", "Model service protocol version mismatch.")
        return value

    def do_POST(self) -> None:
        request_id: str | None = None
        started = time.perf_counter()
        try:
            value = self._body()
            request_id = value.get("requestId") if isinstance(value.get("requestId"), str) else None
            if request_id is None:
                raise ServiceError(400, "INVALID_REQUEST", "requestId is required.")
            if self.path == "/v1/embeddings":
                texts = value.get("input")
                if value.get("model") != self.backend.manifest.embedding.model or not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
                    raise ServiceError(400, "INVALID_REQUEST", "Embedding model or input is invalid.")
                input_type = value.get("inputType")
                instruction = value.get("instruction")
                dimensions = value.get("dimensions")
                if (
                    input_type not in ("query", "document")
                    or value.get("normalize") is not True
                    or (instruction is not None and not isinstance(instruction, str))
                    or not isinstance(dimensions, int)
                    or isinstance(dimensions, bool)
                ):
                    raise ServiceError(400, "INVALID_REQUEST", "Embedding inputType and L2 normalization are required.")
                vectors = self.backend.embed(texts, input_type, instruction, dimensions)
                self._send(200, {
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "model": self.backend.manifest.embedding.model,
                    "revision": self.backend.manifest.embedding.revision,
                    "dimensions": self.backend.manifest.embedding.dimensions,
                    "normalization": "l2",
                    "data": [{"index": index, "embedding": vector} for index, vector in enumerate(vectors)],
                    "elapsedMs": (time.perf_counter() - started) * 1000,
                })
            elif self.path == "/v1/rerank":
                candidates = value.get("candidates")
                query = value.get("query")
                instruction = value.get("instruction")
                top_k = value.get("topK")
                if (
                    value.get("model") != self.backend.manifest.reranker.model
                    or not isinstance(candidates, list)
                    or not isinstance(query, str)
                    or not isinstance(instruction, str)
                    or not isinstance(top_k, int)
                    or isinstance(top_k, bool)
                ):
                    raise ServiceError(400, "INVALID_REQUEST", "Reranker model or candidates are invalid.")
                if (
                    any(
                        not isinstance(item, dict)
                        or not isinstance(item.get("id"), str)
                        or not item["id"].strip()
                        or not isinstance(item.get("text"), str)
                        or not item["text"].strip()
                        for item in candidates
                    )
                    or len({item["id"] for item in candidates}) != len(candidates)
                ):
                    raise ServiceError(400, "INVALID_REQUEST", "Reranker candidates are invalid.")
                results = self.backend.rerank(query, candidates, instruction, top_k)
                self._send(200, {
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "model": self.backend.manifest.reranker.model,
                    "revision": self.backend.manifest.reranker.revision,
                    "scoreKind": "yes_probability",
                    "results": results,
                    "elapsedMs": (time.perf_counter() - started) * 1000,
                })
            else:
                raise ServiceError(404, "NOT_FOUND", "Unknown endpoint.")
        except ServiceError as error:
            self._error(error, request_id)
        except Exception as error:
            self._error(ServiceError(500, "INFERENCE_FAILED", "Model inference failed.", retryable=True), request_id)


def serve(backend: Any, host: str, port: int) -> None:
    handler: Callable[..., ModelRequestHandler] = type("BoundModelRequestHandler", (ModelRequestHandler,), {"backend": backend})
    server = ThreadingHTTPServer((host, port), handler)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
