"""Create Qwen document and query embeddings for the isolated offline eval."""
from __future__ import annotations

import argparse
import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from .experiment import read_jsonl
from .embedding_manifest import write_manifest


DEFAULT_TOKENIZER = Path("models/Qwen3-Embedding-0.6B")
DEFAULT_SERVICE = "http://127.0.0.1:28012"
DOCUMENT_FIELDS = ["title", "summary"]
def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _chunks(tokenizer: Any, text: str, *, chunk_size: int, overlap: int) -> list[str]:
    encoded = tokenizer(text, add_special_tokens=False, truncation=False, return_offsets_mapping=True)
    offsets = encoded["offset_mapping"]
    if not offsets:
        return [text]
    step = chunk_size - overlap
    result = []
    for start in range(0, len(offsets), step):
        end = min(start + chunk_size, len(offsets))
        char_start = 0 if start == 0 else offsets[start][0]
        char_end = len(text) if end == len(offsets) else offsets[end - 1][1]
        result.append(text[char_start:char_end])
        if end == len(offsets):
            break
    return result


def _document_text(row: dict[str, Any]) -> str:
    return f"【标题】{row['title']}\n【摘要】{row['summary']}"


def _vectors(client: httpx.Client, texts: list[str], *, model: str, dimensions: int,
             query_instruction: str, input_type: str, batch_size: int,
             on_batch: Any = None) -> tuple[list[list[float]], int, float]:
    vectors: list[list[float]] = []
    calls = 0
    elapsed_ms = 0.0
    for offset in range(0, len(texts), batch_size):
        batch = texts[offset:offset + batch_size]
        started = time.perf_counter()
        try:
            response = client.post("/v1/embeddings", json={
                "protocolVersion": "retrieval-agent.models.v1", "requestId": str(uuid.uuid4()),
                "model": model, "input": batch, "inputType": input_type,
                "dimensions": dimensions, "normalize": True, "requireCompleteInput": True,
                **({"instruction": query_instruction} if input_type == "query" else {}),
            }).raise_for_status().json()
        finally:
            elapsed = (time.perf_counter() - started) * 1000
            calls += 1
            elapsed_ms += elapsed
            if on_batch:
                on_batch(calls, elapsed)
        vectors.extend(item["embedding"] for item in response["data"])
    return vectors, calls, elapsed_ms


def _service(client: httpx.Client, manifest_path: Path) -> tuple[str, int, str, dict[str, Any], int]:
    model_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    embedding_config = model_manifest["embedding"]
    source = model_manifest["dependencies"][embedding_config["dependency"]]["source"]
    ready = client.get("/health/ready").raise_for_status().json()
    if not ready.get("ready"):
        raise RuntimeError("configured embedding service is not ready")
    embedding = next(item for item in ready["models"] if item["kind"] == "embedding")
    if embedding["model"] != source["repoId"] or embedding["dimensions"] != embedding_config["dimensions"]:
        raise RuntimeError("embedding service model identity differs from the experiment configuration")
    if embedding["revision"] != source["revision"]:
        raise RuntimeError("embedding service revision differs from the pinned model manifest")
    if embedding.get("pooling") != "last_token" or embedding.get("normalization") != "l2":
        raise RuntimeError("embedding service pooling/normalization differs from the configured model")
    return (embedding["model"], embedding["dimensions"], embedding_config["queryInstruction"], embedding,
            min(16, int(ready["limits"]["maxBatchSize"])))


def embed_tickets(dataset: Path, output: Path, *, tokenizer_path: Path = DEFAULT_TOKENIZER,
                  service_url: str = DEFAULT_SERVICE, chunk_size: int = 480, overlap: int = 48,
                  checkpoint_size: int = 200, manifest_path: Path = Path("architecture/model-manifest.json")) -> dict[str, Any]:
    if not 0 <= overlap < chunk_size:
        raise ValueError("overlap must be smaller than chunk-size")
    rows = read_jsonl(dataset)
    ids = [str(row["ticket_id"]) for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("ticket_id values must be unique")
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(tokenizer_path, local_files_only=True, use_fast=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(".partial.npy")
    checkpoint = output.with_suffix(".progress.json")
    dataset_hash = _digest(dataset)
    cursor = 0
    chunks_total = calls = 0
    provider_elapsed_ms = previous_wall_seconds = 0.0
    if checkpoint.exists():
        saved = json.loads(checkpoint.read_text(encoding="utf-8"))
        if (saved["dataset_sha256"] != dataset_hash or saved["records"] != len(rows)
                or saved.get("input_fields") != DOCUMENT_FIELDS):
            raise ValueError("embedding checkpoint belongs to a different canonical dataset")
        cursor = int(saved["next_index"])
        chunks_total = int(saved.get("chunk_count", 0))
        calls = int(saved.get("http_physical_requests", 0))
        provider_elapsed_ms = float(saved.get("provider_elapsed_ms", 0.0))
        previous_wall_seconds = float(saved.get("wall_elapsed_seconds", 0.0))
    matrix = np.lib.format.open_memmap(partial, mode="r+" if partial.exists() else "w+",
                                      dtype=np.float32, shape=(len(rows), 1024))
    with httpx.Client(base_url=service_url.rstrip("/"), timeout=300) as client:
        model, dimensions, query_instruction, identity, batch_size = _service(client, manifest_path)
        if chunk_size > int(json.loads(manifest_path.read_text(encoding="utf-8"))["embedding"]["maxTokens"]):
            raise ValueError("chunk-size exceeds the pinned model token limit")
        started = time.perf_counter()
        for group_start in range(cursor, len(rows), checkpoint_size):
            group_end = min(group_start + checkpoint_size, len(rows))
            chunk_texts: list[str] = []
            chunk_owners: list[int] = []
            for index in range(group_start, group_end):
                row = rows[index]
                title, summary = row["title"], row["summary"]
                if any(not isinstance(value, str) or not value.strip() for value in (title, summary)):
                    raise ValueError(f"{row['ticket_id']}: title and summary are required")
                material = _document_text(row)
                chunks = _chunks(tokenizer, material, chunk_size=chunk_size, overlap=overlap)
                chunk_texts.extend(chunks)
                chunk_owners.extend([index] * len(chunks))
            sums = np.zeros((group_end - group_start, dimensions), dtype=np.float64)
            counts = np.zeros(group_end - group_start, dtype=np.int32)

            def record_request(_number: int, elapsed_ms: float) -> None:
                nonlocal calls, provider_elapsed_ms
                calls += 1
                provider_elapsed_ms += elapsed_ms
                checkpoint.write_text(json.dumps({"dataset_sha256": dataset_hash, "records": len(rows),
                    "input_fields": DOCUMENT_FIELDS,
                    "next_index": group_start, "chunk_count": chunks_total, "http_physical_requests": calls,
                    "provider_elapsed_ms": provider_elapsed_ms,
                    "wall_elapsed_seconds": previous_wall_seconds + time.perf_counter() - started}, indent=2) + "\n",
                    encoding="utf-8")

            chunk_vectors, _group_calls, _group_elapsed = _vectors(
                client, chunk_texts, model=model, dimensions=dimensions, query_instruction=query_instruction,
                input_type="document", batch_size=batch_size, on_batch=record_request)
            for owner, vector in zip(chunk_owners, chunk_vectors, strict=True):
                relative = owner - group_start
                sums[relative] += np.asarray(vector, dtype=np.float64)
                counts[relative] += 1
            for offset, index in enumerate(range(group_start, group_end)):
                vector = (sums[offset] / counts[offset]).astype(np.float32)
                vector /= max(float(np.linalg.norm(vector)), 1e-12)
                matrix[index] = vector
            matrix.flush()
            chunks_total += len(chunk_texts)
            cursor = group_end
            checkpoint.write_text(json.dumps({"dataset_sha256": dataset_hash, "records": len(rows),
                "input_fields": DOCUMENT_FIELDS,
                "next_index": cursor, "chunk_count": chunks_total, "http_physical_requests": calls,
                "provider_elapsed_ms": provider_elapsed_ms,
                "wall_elapsed_seconds": previous_wall_seconds + time.perf_counter() - started}, indent=2) + "\n",
                encoding="utf-8")
            if cursor % checkpoint_size == 0 or cursor == len(rows):
                print(f"ticket embeddings: {cursor}/{len(rows)} records")
        elapsed = previous_wall_seconds + time.perf_counter() - started
    np.savez_compressed(output, ticket_ids=np.asarray(ids), vectors=np.asarray(matrix).copy())
    manifest = {"records": len(ids), "dataset_sha256": dataset_hash, "embedding_sha256": _digest(output),
                "embedding": identity, "tokenizer_path": str(tokenizer_path.resolve()),
                "input_fields": DOCUMENT_FIELDS, "document_field_policy": "title+summary concatenated; body excluded",
                "chunk_tokens": chunk_size, "chunk_overlap_tokens": overlap,
                "aggregation": "mean all normalized chunk vectors per ticket; final L2 normalization",
                "chunk_count": chunks_total, "http_physical_requests": calls,
                "provider_elapsed_ms": round(provider_elapsed_ms, 2), "wall_elapsed_seconds": round(elapsed, 3),
                "checkpoint_interval_records": checkpoint_size, "truncation": "none before 480-token chunking"}
    write_manifest(output, manifest)
    return manifest


def embed_queries(queries_file: Path, output: Path, *, service_url: str = DEFAULT_SERVICE,
                  manifest_path: Path = Path("architecture/model-manifest.json")) -> dict[str, Any]:
    queries = json.loads(queries_file.read_text(encoding="utf-8-sig"))
    ids = [row["condition_id"] for row in queries]
    texts = [row["query"] for row in queries]
    with httpx.Client(base_url=service_url.rstrip("/"), timeout=300) as client:
        model, dimensions, query_instruction, identity, batch_size = _service(client, manifest_path)
        vectors, calls, elapsed_ms = _vectors(client, texts, model=model, dimensions=dimensions,
                                              query_instruction=query_instruction, input_type="query", batch_size=batch_size)
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, condition_ids=np.asarray(ids), vectors=np.asarray(vectors, dtype=np.float32))
    manifest = {"conditions": len(ids), "queries_sha256": _digest(queries_file), "embedding_sha256": _digest(output),
                "embedding": identity, "input_type": "query", "query_instruction": query_instruction,
                "http_physical_requests": calls, "provider_elapsed_ms": round(elapsed_ms, 2)}
    write_manifest(output, manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    tickets = sub.add_parser("tickets")
    tickets.add_argument("--dataset", type=Path, required=True)
    tickets.add_argument("--output", type=Path, required=True)
    tickets.add_argument("--tokenizer", type=Path, default=DEFAULT_TOKENIZER)
    tickets.add_argument("--manifest", type=Path, default=Path("architecture/model-manifest.json"))
    tickets.add_argument("--service-url", default=DEFAULT_SERVICE)
    tickets.add_argument("--chunk-size", type=int, default=480)
    tickets.add_argument("--overlap", type=int, default=48)
    tickets.add_argument("--checkpoint-size", type=int, default=200)
    queries = sub.add_parser("queries")
    queries.add_argument("--queries", type=Path, required=True)
    queries.add_argument("--output", type=Path, required=True)
    queries.add_argument("--manifest", type=Path, default=Path("architecture/model-manifest.json"))
    queries.add_argument("--service-url", default=DEFAULT_SERVICE)
    args = parser.parse_args()
    result = embed_tickets(args.dataset, args.output, tokenizer_path=args.tokenizer, service_url=args.service_url,
                           chunk_size=args.chunk_size, overlap=args.overlap, checkpoint_size=args.checkpoint_size,
                           manifest_path=args.manifest) if args.command == "tickets" else \
             embed_queries(args.queries, args.output, service_url=args.service_url, manifest_path=args.manifest)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
