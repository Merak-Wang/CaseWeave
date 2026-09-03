from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import uvicorn

from . import PROTOCOL_VERSION, SERVICE_VERSION
from .errors import ServiceError
from .policy import plan_knowledge_assessment, update_candidate_ranking
from .ranking import RAG_PROTOCOL_VERSION, RetrievalRankingBackend


def _request_id(value: dict[str, Any], request: Request, protocol_version: str = PROTOCOL_VERSION) -> str:
    request_id = value.get("requestId")
    if not isinstance(request_id, str) or not request_id.strip():
        raise ServiceError(400, "INVALID_REQUEST", "requestId is required.")
    request.state.request_id = request_id
    request.state.response_protocol = protocol_version
    if value.get("protocolVersion") != protocol_version:
        raise ServiceError(409, "PROTOCOL_MISMATCH", "Retrieval service protocol version mismatch.")
    return request_id


def _ready(backend: Any, ranking_backend: RetrievalRankingBackend) -> dict[str, Any]:
    models = backend.descriptors()
    query_analysis = backend.query_analysis_descriptor()
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "serviceVersion": SERVICE_VERSION,
        "ready": bool(models) and all(model["loaded"] for model in models) and query_analysis["loaded"],
        "device": backend.device,
        "models": models,
        "queryAnalysis": query_analysis,
        "rag": ranking_backend.descriptor(),
        "limits": {
            "maxBatchSize": backend.max_batch_size,
            "maxTotalTokens": backend.max_total_tokens,
            "maxRerankCandidates": backend.max_rerank_candidates,
        },
    }


def create_app(backend: Any, ranking_backend: RetrievalRankingBackend | None = None) -> FastAPI:
    ranking_backend = ranking_backend or RetrievalRankingBackend(backend)
    app = FastAPI(title="Retrieval Agent service", version=SERVICE_VERSION)

    @app.exception_handler(ServiceError)
    async def service_error_handler(request: Request, error: ServiceError) -> JSONResponse:
        return JSONResponse(status_code=error.status, content={
            "protocolVersion": getattr(request.state, "response_protocol", PROTOCOL_VERSION),
            **({"requestId": request.state.request_id} if hasattr(request.state, "request_id") else {}),
            "error": {"code": error.code, "message": error.message, "retryable": error.retryable},
        })

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=400, content={
            "protocolVersion": PROTOCOL_VERSION,
            "error": {"code": "INVALID_REQUEST", "message": "Request body must be a JSON object.", "retryable": False},
        })

    @app.exception_handler(Exception)
    async def inference_error_handler(request: Request, _error: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={
            "protocolVersion": getattr(request.state, "response_protocol", PROTOCOL_VERSION),
            **({"requestId": request.state.request_id} if hasattr(request.state, "request_id") else {}),
            "error": {"code": "INFERENCE_FAILED", "message": "Model inference failed.", "retryable": True},
        })

    @app.get("/health/live")
    def live() -> dict[str, Any]:
        return {"protocolVersion": PROTOCOL_VERSION, "serviceVersion": SERVICE_VERSION, "live": True}

    @app.get("/health/ready")
    def ready() -> JSONResponse:
        value = _ready(backend, ranking_backend)
        return JSONResponse(status_code=200 if value["ready"] else 503, content=value)

    @app.post("/v1/embeddings")
    def embeddings(value: dict[str, Any], request: Request) -> dict[str, Any]:
        started = time.perf_counter()
        request_id = _request_id(value, request)
        texts = value.get("input")
        if value.get("model") != backend.manifest.embedding.model or not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
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
        vectors = backend.embed(texts, input_type, instruction, dimensions)
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "model": backend.manifest.embedding.model,
            "revision": backend.manifest.embedding.revision,
            "dimensions": backend.manifest.embedding.dimensions,
            "normalization": "l2",
            "data": [{"index": index, "embedding": vector} for index, vector in enumerate(vectors)],
            "elapsedMs": (time.perf_counter() - started) * 1000,
        }

    @app.post("/v1/rerank")
    def rerank(value: dict[str, Any], request: Request) -> dict[str, Any]:
        started = time.perf_counter()
        request_id = _request_id(value, request)
        candidates = value.get("candidates")
        query = value.get("query")
        instruction = value.get("instruction")
        top_k = value.get("topK")
        if (
            value.get("model") != backend.manifest.reranker.model
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
        results = backend.rerank(query, candidates, instruction, top_k)
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "model": backend.manifest.reranker.model,
            "revision": backend.manifest.reranker.revision,
            "scoreKind": "yes_probability",
            "results": results,
            "elapsedMs": (time.perf_counter() - started) * 1000,
        }

    @app.post("/v1/query-analysis")
    def query_analysis(value: dict[str, Any], request: Request) -> dict[str, Any]:
        started = time.perf_counter()
        request_id = _request_id(value, request)
        query = value.get("query")
        if not isinstance(query, str):
            raise ServiceError(400, "INVALID_REQUEST", "Query analysis input is invalid.")
        analysis = backend.analyze_query(query)
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "analyzer": backend.query_analysis_descriptor(),
            **analysis,
            "elapsedMs": (time.perf_counter() - started) * 1000,
        }

    @app.post("/v1/ranking/prepare")
    def prepare_ranking(value: dict[str, Any], request: Request) -> dict[str, Any]:
        request_id = _request_id(value, request, RAG_PROTOCOL_VERSION)
        options = value.get("options")
        if not isinstance(options, dict):
            raise ServiceError(400, "INVALID_REQUEST", "Ranking preparation options are required.")
        max_scan = options.get("maxScan")
        if isinstance(max_scan, bool) or not isinstance(max_scan, int) or max_scan < 1:
            raise ServiceError(400, "INVALID_REQUEST", "Ranking preparation maxScan is invalid.")
        result = ranking_backend.prepare(value.get("documents"), value.get("profile"), max_scan, request_id)
        return {"protocolVersion": RAG_PROTOCOL_VERSION, "requestId": request_id, **result}

    @app.get("/v1/ranking/prepare/{request_id}")
    def prepare_progress(request_id: str, request: Request) -> dict[str, Any]:
        request.state.request_id = request_id
        request.state.response_protocol = RAG_PROTOCOL_VERSION
        if not request_id.strip() or len(request_id) > 200:
            raise ServiceError(400, "INVALID_REQUEST", "Ranking preparation requestId is invalid.")
        return {
            "protocolVersion": RAG_PROTOCOL_VERSION,
            "requestId": request_id,
            "progress": ranking_backend.preparation_status(request_id),
        }

    @app.post("/v1/ranking/rank")
    def rank(value: dict[str, Any], request: Request) -> dict[str, Any]:
        started = time.perf_counter()
        request_id = _request_id(value, request, RAG_PROTOCOL_VERSION)
        result = ranking_backend.rank(
            value.get("documents"), value.get("query"), value.get("options"), value.get("profile")
        )
        return {
            "protocolVersion": RAG_PROTOCOL_VERSION,
            "requestId": request_id,
            "result": result,
            "elapsedMs": max(0.0, (time.perf_counter() - started) * 1000),
        }

    @app.post("/v1/policy/candidate-ranking")
    def candidate_ranking(value: dict[str, Any], request: Request) -> dict[str, Any]:
        started = time.perf_counter()
        request_id = _request_id(value, request, RAG_PROTOCOL_VERSION)
        result = update_candidate_ranking(value.get("input"))
        return {
            "protocolVersion": RAG_PROTOCOL_VERSION,
            "requestId": request_id,
            "result": result,
            "elapsedMs": max(0.0, (time.perf_counter() - started) * 1000),
        }

    @app.post("/v1/policy/knowledge-assessment")
    def knowledge_assessment(value: dict[str, Any], request: Request) -> dict[str, Any]:
        started = time.perf_counter()
        request_id = _request_id(value, request, RAG_PROTOCOL_VERSION)
        result = plan_knowledge_assessment(value.get("state"), value.get("assessment"), value.get("config"))
        return {
            "protocolVersion": RAG_PROTOCOL_VERSION,
            "requestId": request_id,
            **result,
            "elapsedMs": max(0.0, (time.perf_counter() - started) * 1000),
        }

    return app


def serve(
    backend: Any,
    host: str,
    port: int,
    vector_cache_dir: Path | None = None,
    checkpoint_every_batches: int = 8,
) -> None:
    uvicorn.run(
        create_app(backend, RetrievalRankingBackend(backend, vector_cache_dir, checkpoint_every_batches)),
        host=host, port=port, log_level="info", access_log=False,
    )
