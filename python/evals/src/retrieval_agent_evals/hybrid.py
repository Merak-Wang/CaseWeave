"""Qwen embedding and keyword-OR candidate retrieval for the offline experiment."""
from __future__ import annotations
from .embedding_manifest import manifest_path as embedding_manifest_path

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from .experiment import read_jsonl, write_condition


def _fields(row: dict[str, Any]) -> tuple[str, ...]:
    return tuple(str(row[key]) for key in ("title", "summary", "body") if row.get(key))


def hybrid_candidates(rows: list[dict[str, Any]], matrix: np.ndarray, query: dict[str, Any], query_vector: np.ndarray,
                      *, vector_top_k: int = 2048, vector_threshold: float = .75) -> list[dict[str, Any]]:
    keywords = [str(word) for word in query.get("keywords", []) if str(word).strip()]
    query_text = str(query["query"])
    normalized_query = re.sub(r"\s+", "", query_text).casefold()
    query_grams = {normalized_query[i:i + 2] for i in range(len(normalized_query) - 1)}
    norm = np.linalg.norm(matrix, axis=1) * np.linalg.norm(query_vector)
    cosine = np.divide(matrix @ query_vector, norm, out=np.zeros(len(rows), dtype=np.float32), where=norm > 0)
    cosine = np.clip(cosine, 0, 1)
    lexical = np.zeros(len(rows), dtype=np.float32)
    literal_hit = np.zeros(len(rows), dtype=bool)
    for i, row in enumerate(rows):
        text = "\n".join(_fields(row)).casefold()
        literal_hit[i] = any(word.casefold() in text for word in keywords)
        normalized_text = re.sub(r"\s+", "", text)
        lexical[i] = sum(gram in normalized_text for gram in query_grams) / len(query_grams) if query_grams else 0
    # 保留全部阈值命中，旧 vector_top_k 仅供历史调用兼容，不再补票或截断。
    vector_indices = np.flatnonzero(np.isfinite(cosine) & (cosine >= vector_threshold))
    vector_set = set(vector_indices.tolist())
    indices = sorted(set(np.flatnonzero(literal_hit).tolist()) | vector_set,
                     key=lambda i: (-float((lexical[i] + cosine[i]) / 2), -float(cosine[i]), i))
    return [{**rows[i], "keyword_hit": bool(literal_hit[i]), "keyword_score": float(lexical[i]),
             "vector_hit": i in vector_set, "vector_score": float(cosine[i]),
             "hybrid_score": float((lexical[i] + cosine[i]) / 2)} for i in indices]


def run_queries(dataset: Path, embedding_file: Path, queries_file: Path, output: Path, *,
                query_embedding_file: Path, vector_top_k: int = 2048, vector_threshold: float = .75, limit: int = 256,
                split_seed: int = 0, split_mode: str = "group_seeded") -> list[dict[str, Any]]:
    rows = read_jsonl(dataset)
    queries = json.loads(queries_file.read_text(encoding="utf-8-sig"))
    saved = np.load(embedding_file, allow_pickle=False)
    ids, matrix = saved["ticket_ids"].tolist(), saved["vectors"]
    if ids != [row["ticket_id"] for row in rows]:
        raise ValueError("Embedding ticket order differs from the canonical dataset")
    query_saved = np.load(query_embedding_file, allow_pickle=False)
    query_ids, query_vectors = query_saved["condition_ids"].tolist(), query_saved["vectors"]
    if query_ids != [query["condition_id"] for query in queries]:
        raise ValueError("Query embedding condition order differs from query manifest")
    identity = json.loads(embedding_manifest_path(query_embedding_file, legacy=True).read_text(encoding="utf-8"))
    doc_manifest_path = embedding_manifest_path(embedding_file, legacy=True)
    doc_identity = json.loads(doc_manifest_path.read_text(encoding="utf-8")) if doc_manifest_path.exists() else None
    manifests = []
    for query, vector in zip(queries, query_vectors, strict=True):
        candidates = hybrid_candidates(rows, matrix, query, vector, vector_top_k=vector_top_k, vector_threshold=vector_threshold)
        condition_dir = output / query["condition_id"]
        (condition_dir / "recall_union.jsonl").parent.mkdir(parents=True, exist_ok=True)
        manifests.append(write_condition(condition_dir, {"condition_id": query["condition_id"], "query_spec": query,
            "query": query["query"], "keywords": query.get("keywords", []),
            "labeling_guidance": query.get("labeling_guidance", ""),
            "retrieval": "all_literal_keyword_OR_plus_vector_cosine_gte_threshold; hybrid_score_mean_of_distinct_bigram_coverage_and_cosine",
            "document_embedding": doc_identity.get("embedding") if doc_identity else None,
            "query_embedding": identity.get("embedding", identity), "candidate_source_count": len(candidates),
            "keyword_hit_count": sum(bool(row["keyword_hit"]) for row in candidates),
            "vector_hit_count": sum(bool(row["vector_hit"]) for row in candidates),
            "vector_top_k": None, "vector_threshold": vector_threshold, "full_corpus_size": len(rows)}, candidates, size=limit, seed=split_seed, split_mode=split_mode))
    return manifests


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    retrieve = sub.add_parser("retrieve")
    retrieve.add_argument("--dataset", type=Path, required=True)
    retrieve.add_argument("--embeddings", type=Path, required=True)
    retrieve.add_argument("--query-embeddings", type=Path, required=True)
    retrieve.add_argument("--queries", type=Path, required=True)
    retrieve.add_argument("--output", type=Path, required=True)
    retrieve.add_argument("--vector-top-k", type=int, default=2048, help="Historical compatibility argument; threshold recall has no Top-K cap")
    retrieve.add_argument("--vector-threshold", type=float, default=.75)
    retrieve.add_argument("--limit", type=int, default=256)
    retrieve.add_argument("--split-seed", type=int, default=0)
    retrieve.add_argument("--split-mode", choices=("group_seeded", "legacy_rank_interleaved"), default="group_seeded")
    args = parser.parse_args()
    result = run_queries(args.dataset, args.embeddings, args.queries, args.output,
                         query_embedding_file=args.query_embeddings, vector_top_k=args.vector_top_k, vector_threshold=args.vector_threshold, limit=args.limit,
                         split_seed=args.split_seed, split_mode=args.split_mode)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
