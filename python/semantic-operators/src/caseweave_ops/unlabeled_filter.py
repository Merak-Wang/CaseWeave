"""Full recall-scope consumer of the fixed-pool unlabeled adapter.

No teacher calls, label fitting, model competition or quality claims. Numeric
transport uses features.scan; no source hydration is needed for classification.
Final yes labels publish through the ordinary numeric result collection.
"""
from __future__ import annotations

import asyncio
from time import perf_counter

import numpy as np

from .features import decode_block
from .types import ProtocolError, StaleTask, digest
from .unlabeled import UNLABELED_METHODS, _unit, fit_numeric_unlabeled


async def unlabeled_filter(runtime, instruction, *, method, options=None,
                           require_source=True, required_fields=(), recall_scope_key=None,
                           embedding_id=None, query_anchor=None, negative_anchor=None, **_):
    """Scan vectors, fit once and publish binary labels without source hydration."""
    if runtime.resources is None:
        raise ProtocolError("unlabeled_numeric_provider_required")
    if not isinstance(recall_scope_key, str) or not recall_scope_key:
        raise ProtocolError("unlabeled_recall_scope_required")
    cfg = {"block_size": 1024, "batch_size": 64, "concurrency": 2, "seed": 0, **(options or {})}
    if any(type(cfg[name]) is not int or cfg[name] < 1 for name in ("block_size", "batch_size", "concurrency")):
        raise ProtocolError("invalid_unlabeled_transport_sizes")
    cfg["block_size"], cfg["batch_size"], cfg["concurrency"] = min(cfg["block_size"], 1024), min(cfg["batch_size"], 256), min(cfg["concurrency"], 8)
    key, scope_key = runtime.predicate_key(instruction), runtime.scope.key
    call = runtime.resources
    stats = {"algorithm": method, "regime": "query_fixed_pool_unlabeled", "predicate_key": key,
        "input_revision": runtime.scope.input_revision, "recall_scope_key": recall_scope_key,
        "online_feedback_training": False, "teacher_unique_records": 0, "teacher_calls": 0,
        "training_records": 0, "selection_records": 0, "fit_count": 0, "scan_passes": 0,
        "corpus_records": 0, "scope_records": 0, "confirmed_records": 0,
        "positive_records": 0, "negative_records": 0, "undetermined_records": 0,
        "quality_basis": "unmeasured", "quality": "unmeasured", "global_semantic_recall": "not_established",
        "task_semantics": "recall_candidate_scope", "complete_scope_coverage": False,
        "semantic_complete": False, "source_read_passes": 0}

    async def check():
        await runtime.scope.check()
        if runtime.scope.key != scope_key or runtime.predicate_key(instruction) != key:
            raise StaleTask("Unlabeled query scope changed")

    async def update(reason):
        await check()
        await call("learning.update", {**stats, "stop_reason": reason,
            "unresolved": stats["undetermined_records"], "next_action": "return_confirmed_results",
            "_usage": runtime.store.metrics(runtime.scope.task_id)})

    await update("unlabeled_scanning")
    started = perf_counter()
    cursor, feature_id, population_count, dimensions = None, None, None, None
    seen_ids, seen_cursors, id_parts, vector_parts = set(), set(), [], []
    while True:
        await check()
        page = await call("features.scan", {"cursor": cursor, "page_size": cfg["block_size"], "ranked": False,
                                             "recall_scope_key": recall_scope_key})
        await check()
        if not isinstance(page, dict):
            raise ProtocolError("invalid_unlabeled_feature_page")
        ids = page.get("ids")
        if not isinstance(ids, list) or len(ids) > cfg["block_size"] or any(type(i) is not int for i in ids):
            raise ProtocolError("invalid_unlabeled_numeric_ids")
        if len(set(ids)) != len(ids) or seen_ids.intersection(ids):
            raise ProtocolError("duplicate_unlabeled_numeric_ids")
        page_id = page.get("feature_id")
        if not isinstance(page_id, str) or not page_id or (feature_id is not None and page_id != feature_id):
            raise StaleTask("Unlabeled feature generation changed")
        feature_id = page_id
        count = page.get("population_count")
        if count is not None:
            if type(count) is not int or count < 0 or (population_count is not None and count != population_count):
                raise StaleTask("Unlabeled recall population changed")
            population_count = count
        try:
            block = decode_block(page)
            if block.available.shape != (len(ids),) or block.dense.ndim != 2 or block.dense.shape[1] < 1:
                raise ValueError("invalid shape")
        except Exception:
            raise ProtocolError("invalid_unlabeled_feature_encoding") from None
        if dimensions is not None and dimensions != block.dense.shape[1]:
            raise StaleTask("Unlabeled feature dimension changed")
        dimensions = block.dense.shape[1]
        dense = block.dense.copy()
        dense[~block.available] = np.nan
        seen_ids.update(ids)
        id_parts.append(ids)
        vector_parts.append(dense)
        cursor = page.get("next_cursor")
        if cursor is None:
            break
        if not isinstance(cursor, str) or not cursor or cursor in seen_cursors or not ids:
            raise ProtocolError("unlabeled_scan_cursor_must_advance")
        seen_cursors.add(cursor)
    if population_count is not None and len(seen_ids) != population_count:
        raise StaleTask("Unlabeled recall population cardinality changed")
    ids = [i for part in id_parts for i in part]
    matrix = np.concatenate(vector_parts, axis=0)
    stats.update(feature_id=feature_id, corpus_records=len(ids), scan_passes=1,
                 scan_seconds=perf_counter() - started, numeric_pool_sha256=digest(sorted(ids)))
    if query_anchor is None:
        await check()
        anchors = await call("features.anchor", {"instruction": instruction, "method": method,
            "feature_id": feature_id, "embedding_id": embedding_id, "recall_scope_key": recall_scope_key})
        await check()
        if not isinstance(anchors, dict) or anchors.get("feature_id") != feature_id:
            raise StaleTask("Unlabeled anchor feature generation changed")
        resolved_embedding = anchors.get("embedding_id")
        if embedding_id is not None and embedding_id != resolved_embedding:
            raise StaleTask("Unlabeled anchor embedding space changed")
        embedding_id = resolved_embedding
        query_anchor, negative_anchor = anchors.get("query_anchor"), anchors.get("negative_anchor")
    if not isinstance(embedding_id, str) or not embedding_id:
        raise ProtocolError("unlabeled_anchor_embedding_identity_required")
    # 只用同空间数值块拟合，无须读取或逐条水合工单原文。
    if method not in UNLABELED_METHODS:
        raise ProtocolError("unrecognized_unlabeled_method")
    norms = np.linalg.norm(matrix, axis=1)
    available = np.isfinite(matrix).all(axis=1) & np.isfinite(norms) & (norms > 1e-12)
    stats["missing_features"] = int((~available).sum())
    if not available.all():
        raise ProtocolError("unlabeled_missing_numeric_features")
    anchor = _unit(query_anchor, dimensions)
    negative = _unit(negative_anchor, dimensions)
    order = np.argsort(ids)
    numeric_ids = np.asarray(ids,dtype=np.int64)[order]
    x = matrix[order] / norms[order,None]
    await update("unlabeled_fitting")
    started = perf_counter()
    if len(ids):
        scores, positive, fit_count, failure = await asyncio.to_thread(
            fit_numeric_unlabeled, method, x, anchor, negative, seed=cfg["seed"])
        await check()
        if failure:
            raise ProtocolError(failure)
        labels = np.asarray(positive,dtype=np.int8)
        scores = np.asarray(scores,dtype=float)
        if not np.isfinite(scores).all():
            raise ProtocolError("unlabeled_score_not_finite")
    else:
        scores, labels, fit_count = np.empty(0), np.empty(0,dtype=np.int8), 0
    model_id = digest(["unlabeled-numeric", scope_key, key, feature_id, method, cfg["seed"]])
    manifest = {"method":method, "embedding_id":embedding_id, "feature_id":feature_id,
        "recall_scope_key":recall_scope_key, "fit_count":fit_count,
        "regime":UNLABELED_METHODS[method]["regime"], "quality":"unmeasured",
        "authority":"final_yes_collection", "teacher_calls":0,
        "usable_vectors":len(ids), "pool_records":len(ids)}
    stats.update(manifest=manifest, fit_count=fit_count, fit_seconds=perf_counter()-started,
        feature_records=len(ids), positive_records=int(labels.sum()),
        negative_records=int(len(ids)-labels.sum()))
    threshold = UNLABELED_METHODS[method]["config"].get("threshold",0.5)
    await check()
    await call("predictions.begin", {"model_id":model_id,"predicate_key":key,
        "feature_id":feature_id,"input_revision":runtime.scope.input_revision,
        "training_records":0,"fit_count":fit_count,"model":method,"threshold":threshold,
        "task_semantics":"recall_candidate_scope","recall_scope_key":recall_scope_key})
    for start in range(0,len(ids),cfg["block_size"]):
        await check()
        end=start+cfg["block_size"]
        await call("predictions.write", {"model_id":model_id,"offset":start,
            "ids":numeric_ids[start:end].tolist(), "labels":labels[start:end].tolist(),
            "scores":scores[start:end].tolist()})
        stats["scope_records"]=min(end,len(ids))
        await update("unlabeled_predicting")
    await check()
    await call("predictions.finish", {"model_id":model_id,"passed":True,
        "quality":{"basis":"unmeasured","business_accuracy":"not_measured"},
        "scope_count":len(ids),"returned":int(labels.sum())})
    stats.update(complete_scope_coverage=True, semantic_complete=True,
        confirmed_records=int(labels.sum()), returned=int(labels.sum()), scope_records=len(ids))
    await update("complete")
