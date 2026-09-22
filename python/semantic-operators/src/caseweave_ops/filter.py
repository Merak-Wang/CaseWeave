"""全集学习式 filter 与共享标签读取；只有显式小范围或 baseline 使用逐条判断。"""
from __future__ import annotations
import asyncio
from uuid import uuid4
from dataclasses import asdict
from time import perf_counter
from typing import Any, AsyncIterable
import numpy as np
from scipy.sparse import vstack
from threadpoolctl import threadpool_limits
from .runtime import Runtime, CITATION_SCHEMA
from .features import FeatureBlock, decode_block, random_keys, PrioritySample
from .models import fit_models, choose_model, model_bank
from .quality import Region, quality_bounds
from .types import Decision, ProtocolError, Record, verify_citations, digest

async def sem_filter(runtime: Runtime, source: AsyncIterable[Record], instruction: str, *,
                     algorithm="auto", options=None, scope_mode="full", **kwargs):
    """全集只有学习主干；direct/候选快查和旧 baseline 必须明确选择。"""
    if algorithm in {"auto", "active", "learned"} and scope_mode == "full" and kwargs.get("stop_after_accepted") is None:
        stream = learned_filter(runtime, instruction, options=options, **kwargs)
    elif algorithm in {"direct", "baseline", "cluster"} or scope_mode == "candidates" or kwargs.get("stop_after_accepted") is not None:
        from .baseline import clustered_filter
        kwargs.pop("initial_refs", None)
        stream = clustered_filter(runtime, source, instruction, algorithm="cluster" if algorithm == "cluster" else "auto",
                                  options=options if algorithm in {"baseline", "cluster"} else None, **kwargs)
    else:
        raise ValueError("Unknown filter algorithm or scope")
    async for result in stream:
        yield result


async def learned_filter(runtime, instruction, *, options=None, batch_size=8,
                         initial_refs=(), host_labels=None, require_source=True, required_fields=(), **_):
    cfg = {"block_size": 16384, "pool_size": 4096, "sample_size": 128,
           "selection_size": 256, "validation_size": 512, "workers": 1,
           "precision_target": .95, "recall_target": .95, "delta": .05,
           "seed": 0, "concurrency": 4}
    supplied = dict(options or {})
    # 旧 active 参数仅作迁移读取；区域污染容忍度不再冒充召回目标。
    for old in ("proposal", "clusters", "accept_error", "reject_error"):
        supplied.pop(old, None)
    cfg.update(supplied)
    if runtime.resources is None:
        raise ValueError("Full-scope filter requires an authorized numeric feature provider")
    if any(cfg[k] < 1 for k in ("block_size", "pool_size", "sample_size", "selection_size", "validation_size", "workers", "concurrency")):
        raise ValueError("Physical block/sample/worker sizes must be positive")
    if not all(0 < cfg[k] < 1 for k in ("precision_target", "recall_target", "delta")):
        raise ValueError("Quality targets and delta must be between zero and one")
    call = runtime.resources
    key = runtime.predicate_key(instruction)
    checkpoint_key = digest(['learned-ranked-resume-v2', key, require_source, required_fields,
        {k: v for k, v in cfg.items() if k not in {'block_size', 'workers', 'concurrency'}}])
    seeds = await call("features.seeds", {"refs": list(dict.fromkeys([*initial_refs, *(host_labels or {})]))})
    checkpoint = runtime.store.learning_checkpoint(runtime.scope.key, checkpoint_key)
    if checkpoint and checkpoint['stats']['feature_id'] != seeds.get('feature_id'):
        checkpoint = None
    previous = runtime.store.output(runtime.scope.key, "learned_measurement", key)
    measurement = (previous or {}).get("round", 0) + 1
    runtime.store.save(runtime.scope.key, "learned_measurement", key, {"round": measurement})
    stats = {"algorithm": "learned", "predicate_key": key, "input_revision": runtime.scope.input_revision,
             "corpus_records": 0, "feature_records": 0, "missing_features": 0,
             "scan_passes": 0, "fit_count": 0, "teacher_unique_records": 0,
             "training_records": 0, "selection_records": 0, "audit_records": 0,
             "scan_seconds": 0., "fit_seconds": 0., "predict_seconds": 0.,
             "global_semantic_recall": "not_established", "task_semantics": "full_authorized_scope",
             "sampling_phase": "discovery", "sampling_method": "ngram_vector_desc",
             "training_sampling_method": "ngram_vector_desc", "selection_sampling_method": "ranked_interleaved_holdout",
             "audit_sampling_method": "srs_without_replacement_per_frozen_region"}
    labels, models, pool_order, selection_ids = {}, [], np.array([], dtype=np.int64), np.array([], dtype=np.int64)
    priorities = {}
    model_labels = {}
    unresolved_evidence = {}

    def save_checkpoint():
        # 缓存有界排序池、选择集和小模型；续跑复用分数与划分，全集向量仍在 Provider。
        runtime.store.save_learning_checkpoint(runtime.scope.key, checkpoint_key,
            {'stats': stats.copy(), 'pool_order': pool_order, 'selection_ids': selection_ids,
             'models': models, 'model_labels': model_labels, 'priorities': priorities})

    async def update(reason, **extra):
        stats.update(positive_records=sum(v == 1 for v in labels.values()),
                     negative_records=sum(v == 0 for v in labels.values()),
                     undetermined_records=sum(v < 0 for v in labels.values()), batch_size=batch_size,
                     concurrency=cfg['concurrency'], sample_size=cfg['sample_size'],
                     precision_target=cfg['precision_target'], recall_target=cfg['recall_target'])
        stats.update(stop_reason=reason, **extra)
        if reason in {'needs_selection_coverage', 'needs_coverage', 'needs_information', 'quality_passed', 'quality_not_met'}:
            save_checkpoint()
        await call("learning.update", {**stats, "_usage": runtime.store.metrics(runtime.scope.task_id)})

    async def scan(*, ranked=False):
        cursor, count, valid = None, 0, 0
        start = perf_counter()
        while True:
            await runtime.scope.check()
            page = await call("features.scan", {"cursor": cursor, "page_size": cfg["block_size"], "ranked": ranked})
            block = decode_block(page)
            if "feature_id" in stats and stats["feature_id"] != page["feature_id"]:
                raise ValueError("Feature generation changed during filtering")
            stats["feature_id"] = page["feature_id"]
            count += len(block.ids); valid += int(block.available.sum())
            yield block
            cursor = page.get("next_cursor")
            if cursor is None:
                break
        if stats["scan_passes"] and (count != stats["corpus_records"] or valid != stats["feature_records"]):
            raise ValueError("Authorized numeric population changed between discovery and prediction")
        stats.update(corpus_records=count, feature_records=valid, missing_features=count-valid)
        stats["scan_passes"] += 1
        stats["scan_seconds"] += perf_counter()-start

    async def take(ids):
        # 有界候选池也分块传输，避免 4096×1024 向量越过 HTTP 帧宽。
        parts = [decode_block(await call("features.take", {"ids": [int(i) for i in ids[start:start+1024]]}))
                 for start in range(0, len(ids), 1024)]
        if len(parts) == 1: return parts[0]
        return FeatureBlock(np.concatenate([p.ids for p in parts]), np.concatenate([p.dense for p in parts]),
            np.concatenate([p.available for p in parts]), vstack([p.sparse for p in parts], format="csr") if parts[0].sparse is not None else None)

    async def ask(ids, phase):
        ids = [i for i in dict.fromkeys(map(int, ids)) if i not in labels]
        status = 'auditing' if phase == 'independent_frozen_population_audit' else 'sampling'
        await update(status, sampling_phase=phase)
        width = batch_size * cfg["concurrency"]
        async def one(part, rows):
            decisions = await judge_batch(runtime, rows, instruction,
                require_source=require_source, required_fields=required_fields)
            for ident, row, decision in zip(part, rows, decisions):
                if decision.label == 'undetermined' and not decision.error:
                    unresolved_evidence[ident] = evidence_key(row)
                else:
                    unresolved_evidence.pop(ident, None)
            return part, decisions
        def evidence_key(row):
            return digest([row.identity, [asdict(p) for p in row.passages], require_source, required_fields,
                row.attributes.get('required_evidence_fields', [])])
        for start in range(0, len(ids), width):
            # 一次读取本组样本正文，再按模型批宽并发判断，避免逐条读取阻塞所有模型请求。
            window = ids[start:start+width]
            response = await call("rows.read", {"ids": window})
            rows = [Record.from_dict(row) for row in response["rows"]]
            if len(rows) != len(window):
                raise ValueError("Authorized sample cardinality changed")
            fresh = []
            for ident, row in zip(window, rows):
                if unresolved_evidence.get(ident) == evidence_key(row):
                    labels[ident] = -1
                    stats['reused_unresolved_records'] = stats.get('reused_unresolved_records', 0) + 1
                else:
                    fresh.append((ident, row))
            jobs = await asyncio.gather(*(one([i for i, _ in fresh[start:start+batch_size]],
                [row for _, row in fresh[start:start+batch_size]]) for start in range(0, len(fresh), batch_size)))
            for part, decisions in jobs:
                for ident, decision in zip(part, decisions):
                    labels[ident] = {"accept": 1, "exclude": 0, "undetermined": -1}[decision.label]
                    yield {"type": "decision", "value": asdict(decision)}
            stats["teacher_unique_records"] = len(labels)
            runtime.store.save(runtime.scope.key, "learned_labels", key,
                {"feature_id": stats["feature_id"], "labels": labels, 'unresolved_evidence': unresolved_evidence})
            await update(status, sampling_phase=phase,
                         audit_records=stats['audit_records'] + sum(len(part) for part, _ in jobs) if status == 'auditing' else stats['audit_records'])

    # 全域只传数值分数；正文按原句 n-gram/向量融合分数，从最高分开始有界读取。
    if checkpoint:
        stats.update({k: checkpoint['stats'][k] for k in ('feature_id', 'corpus_records', 'feature_records',
            'missing_features', 'scan_passes', 'scan_seconds')})
        pool_order = checkpoint['pool_order']
        priorities.update(checkpoint['priorities'])
    else:
        pool = PrioritySample(cfg["pool_size"] + cfg["selection_size"])
        await update('scanning')
        async for block in scan(ranked=True):
            ids = block.ids[block.available]
            scores = block.scores[block.available] if block.scores is not None else np.zeros(len(ids))
            pool.add(ids, scores)
            await update('scanning', scanned_records=stats.get('scanned_records', 0) + len(block.ids))
        pool_order = pool.ids
        priorities.update(zip(map(int, pool.ids), map(float, pool.keys)))
    history = runtime.store.output(runtime.scope.key, "learned_labels", key)
    if history and history["feature_id"] == stats["feature_id"]:
        labels.update({int(i): int(v) for i, v in history["labels"].items()})
        unresolved_evidence.update({int(i): v for i, v in history.get('unresolved_evidence', {}).items()})
    seed_ids = np.asarray(seeds["ids"], dtype=np.int64)
    priorities.update({int(i): float(v) for i, v in seeds.get('scores', {}).items()})
    # 没有显式分数的旧 Provider 仍按种子给定顺序；已有全域分数不被占位分数覆盖。
    for rank, ident in enumerate(seed_ids):
        priorities.setdefault(int(ident), 1. - rank/max(1, len(seed_ids)))
    pool_order = np.asarray(sorted(dict.fromkeys([*map(int, seed_ids), *map(int, pool_order)]),
        key=lambda i: (-priorities[i], i)), dtype=np.int64)
    labels.update({int(i): int(v) for i, v in seeds.get("known_labels", {}).items()})
    # 新一轮可重读旧未决样本；已有确定标签继续复用，未决不能永久挡住补证。
    labels = {i: v for i, v in labels.items() if v >= 0}
    stats['teacher_unique_records'] = len(labels)
    order = pool_order[~np.isin(pool_order, list(labels))]
    resuming_selection = checkpoint and checkpoint['models'] and checkpoint['stats']['stop_reason'] in {
        'training', 'sampling', 'resuming_selection', 'needs_selection_coverage'} and all(
            labels.get(i) == v for i, v in checkpoint['model_labels'].items())
    if resuming_selection:
        models, model_labels = checkpoint['models'], checkpoint['model_labels']
        selection_ids = checkpoint['selection_ids']
        # 已训练模型继续等待选择样本；按分数补入尚未判断且不属于训练集的样本。
        if checkpoint['stats']['stop_reason'] == 'needs_selection_coverage':
            extra = order[~np.isin(order, selection_ids)][:cfg['selection_size']]
            selection_ids = np.r_[selection_ids, extra]
        stats.update({k: checkpoint['stats'][k] for k in ('fit_count', 'fit_seconds', 'training_records', 'training_ids')})
        stats.update(reused_training_records=len(model_labels), reused_label_records=len(labels))
        await update('resuming_selection', selection_records=len(selection_ids))
    else:
        if checkpoint:
            selection_ids = checkpoint['selection_ids']
        else:
            # 排名相邻样本按 T/S/S/T 留出，避免稀少的前排正例全被训练消耗。
            selection_size = min(cfg['selection_size'], max(1, len(order)//3))
            positions = np.arange(len(order)) % 4
            selection_ids = order[(positions == 1) | (positions == 2)][:selection_size]
        if checkpoint:
            await update('resuming_discovery', reused_label_records=len(labels), reused_training_records=0)
    selection_set = set(map(int, selection_ids))
    train_pool = np.asarray([i for i in pool_order if i not in selection_set], dtype=np.int64)
    stats['selection_ids'] = selection_ids.tolist()
    def next_training():
        return [int(i) for i in train_pool if i not in labels][:cfg['sample_size']]
    def next_discovery():
        return [int(i) for i in pool_order if i not in labels][:cfg['sample_size']]
    def training_classes():
        return {v for i, v in labels.items() if v >= 0 and i not in selection_set}
    def balance_unfitted_classes():
        nonlocal selection_ids, train_pool
        if checkpoint and checkpoint['models']:
            return
        # 首次拟合前按已知类别修正划分；每条只属一侧，至少两例才分给两侧。
        for value in (1, 0):
            held = [int(i) for i in pool_order if labels.get(int(i)) == value and i in selection_set]
            trained = [int(i) for i in pool_order if labels.get(int(i)) == value and i not in selection_set]
            if not trained and len(held) >= 2:
                selection_set.remove(held[0])
            elif not held and len(trained) >= 2:
                selection_set.add(trained[0])
        selection_ids = np.asarray([i for i in pool_order if i in selection_set], dtype=np.int64)
        train_pool = np.asarray([i for i in pool_order if i not in selection_set], dtype=np.int64)
        stats['selection_ids'] = selection_ids.tolist()
    if not resuming_selection and not len(train_pool):
        await update("needs_coverage", unresolved=stats["corpus_records"], next_action="expand_discovery_or_use_explicit_small_scope_reference")
        return
    if not resuming_selection:
        await update('ranked_sampling', sampling_method='ngram_vector_desc', pool_records=len(train_pool))
        async for event in ask(next_discovery(), "training_discovery"):
            yield event
        balance_unfitted_classes()
    # 单类只继续下一个排序窗口；仍缺类别时报告缺口，续跑从尚未标注处继续。
    if len(training_classes()) < 2:
        async for event in ask(next_discovery(), "expanded_ranked_coverage"):
            yield event
        balance_unfitted_classes()
    train_ids = np.array(list(model_labels) if resuming_selection else
        [i for i, v in labels.items() if v >= 0 and i not in selection_set], dtype=np.int64)
    if len(training_classes()) < 2:
        await update("needs_coverage" if any(v >= 0 for v in labels.values()) else "needs_information",
                     training_ids=train_ids.tolist(), training_records=len(train_ids),
                     missing_training_labels=[name for value, name in ((1, 'positive'), (0, 'negative')) if value not in training_classes()],
                     discovery_remaining_records=sum(i not in labels for i in pool_order),
                     unresolved=stats["corpus_records"]-sum(v >= 0 for v in labels.values()),
                     next_action="continue_ranked_discovery" if any(i not in labels for i in pool_order) else
                         "new_expressions_or_clarify_predicate" if any(v >= 0 for v in labels.values()) else "read_missing_facts")
        return
    if not resuming_selection:
        train = await take(train_ids)
        if len({labels[int(i)] for i in train.ids[train.available] if labels[int(i)] >= 0}) < 2:
            await update("needs_coverage", unresolved=stats["corpus_records"]-sum(v >= 0 for v in labels.values()),
                         next_action="prepare_features_for_observed_classes")
            return
        start = perf_counter()
        await update('training', candidate_models=[m.name for m in model_bank(sparse='sparse' in train.views)],
                     training_records=len(train_ids))
        models = fit_models({name: X[train.available] for name, X in train.views.items()},
            np.array([labels[int(i)] for i in train.ids[train.available]]), workers=cfg["workers"], seed=cfg["seed"])
        model_labels = {int(i): labels[int(i)] for i in train.ids[train.available]}
        stats.update(fit_count=len(models), training_records=len(train_ids), fit_seconds=perf_counter()-start,
                     training_ids=train_ids.tolist())
    save_checkpoint()
    async for event in ask(selection_ids, "model_threshold_selection"):
        yield event
    stats["selection_records"] = len(selection_ids)
    stats["selection_ids"] = selection_ids.tolist()
    if len({labels[int(i)] for i in selection_ids if labels[int(i)] >= 0}) < 2:
        # 排序池耗尽后交回具体发现缺口，避免无新样本时反复请求续跑。
        remaining = len(np.setdiff1d(pool_order, np.union1d(selection_ids, list(labels))))
        await update("needs_selection_coverage" if remaining else "needs_coverage",
                     selection_remaining_records=remaining,
                     unresolved=stats["corpus_records"]-sum(v >= 0 for v in labels.values()),
                     next_action="independent_selection_sample_with_positive_and_negative_support" if remaining else "new_expressions_or_clarify_predicate")
        return
    selection = await take(selection_ids)
    # 选择样本与训练分离；续补只作经验选模，最终质量仍由冻结后的独立总体抽验给出。
    await update('selecting')
    winner, threshold, board = choose_model(models, selection.views,
        np.array([labels[int(i)] for i in selection.ids]), corpus_size=stats["corpus_records"],
        precision_target=cfg["precision_target"], recall_target=cfg["recall_target"])
    if not any(row["feasible_on_selection"] for row in board):
        # 可复现选择误差触发一次有目标的覆盖修正；没有收益就换表示，不循环标完库。
        more = next_training()
        if more:
            async for event in ask(more, "expanded_ranked_coverage"):
                yield event
            train_ids = np.array([i for i, v in labels.items() if v >= 0 and i not in selection_set], dtype=np.int64)
            train = await take(train_ids)
            start = perf_counter()
            await update('training', training_records=len(train_ids))
            models = fit_models({name: X[train.available] for name, X in train.views.items()},
                np.array([labels[int(i)] for i in train.ids[train.available]]), workers=cfg["workers"], seed=cfg["seed"])
            model_labels = {int(i): labels[int(i)] for i in train.ids[train.available]}
            stats["fit_seconds"] += perf_counter()-start
            await update('selecting')
            winner, threshold, board = choose_model(models, selection.views,
                np.array([labels[int(i)] for i in selection.ids]), corpus_size=stats["corpus_records"],
                precision_target=cfg["precision_target"], recall_target=cfg["recall_target"])
            stats.update(fit_count=stats["fit_count"]+len(models), training_records=len(train_ids), training_ids=train_ids.tolist())
    stats.update(models=board, selected_model=winner.name, threshold=threshold)
    await update('predicting', predicted_records=0)
    model_id = digest([key, winner.name, threshold, sorted(labels.items()), str(uuid4())])
    await call("predictions.begin", {"model_id": model_id, "predicate_key": key,
        "feature_id": stats["feature_id"], "input_revision": runtime.scope.input_revision,
        "training_records": len(train_ids), "fit_count": len(models), "model": winner.name,
        "threshold": threshold, "task_semantics": "full_authorized_scope"})
    # 冻结后只扫一次：落预测块、累计数量、抽取互斥区域的独立样本。
    known_ids = np.array(sorted(labels), dtype=np.int64)
    known_labels = np.array([labels[int(i)] for i in known_ids], dtype=np.int8)
    pools = {label: PrioritySample(cfg["validation_size"]) for label in (-1, 0, 1)}
    counts = {-1: 0, 0: 0, 1: 0}
    scanned = 0
    async for block in scan():
        start = perf_counter()
        scores = np.zeros(len(block.ids), dtype=np.float64)
        predictions = np.full(len(block.ids), -1, dtype=np.int8)
        valid = block.available
        with threadpool_limits(limits=1):
            scores[valid] = winner.score(block.views[winner.view][valid]) if valid.any() else []
        valid = valid & np.isfinite(scores)
        predictions[valid] = (scores[valid] >= threshold).astype(np.int8)
        positions = np.searchsorted(known_ids, block.ids)
        matched = positions < len(known_ids)
        indices = np.flatnonzero(matched)
        matched[indices] = known_ids[positions[indices]] == block.ids[indices]
        predictions[matched] = known_labels[positions[matched]]
        for label, sample in pools.items():
            mask = predictions == label
            counts[label] += int(mask.sum())
            ids = block.ids[mask & ~matched]
            sample.add(ids, random_keys(ids, cfg["seed"]+100*measurement))
        stats["predict_seconds"] += perf_counter()-start
        # 只有块数组通过 Host，模型和抽验说明仅存一份。
        await call("predictions.write", {"model_id": model_id, "offset": scanned,
            "ids": block.ids.tolist(), "labels": predictions.tolist(),
            "scores": np.where(np.isfinite(scores), scores, 0).tolist()})
        scanned += len(block.ids)
        await update('predicting', predicted_records=scanned)
    audit_ids = np.concatenate([p.ids for p in pools.values()])
    async for event in ask(audit_ids, "independent_frozen_population_audit"):
        yield event
    # 先评价冻结集合，再保守推导有限标签修正后的区间；不回训后沿用旧抽验。
    regions = [Region(label == 1, sample.seen, len(sample.ids),
        sum(labels[int(i)] == 1 for i in sample.ids), sum(labels[int(i)] < 0 for i in sample.ids))
        for label, sample in pools.items()]
    quality = quality_bounds(regions, known_tp=int((known_labels == 1).sum()),
        known_unknown=int((known_labels < 0).sum()), delta=cfg["delta"]/(measurement*(measurement+1)))
    # 抽验已知标签优先于预测。有限修正的影响从原冻结区间推导，不重用抽验训练模型。
    removed = sum(labels[int(i)] != 1 for i in pools[1].ids)
    removed_unknown = sum(labels[int(i)] < 0 for i in pools[1].ids)
    added = sum(labels[int(i)] == 1 for label in (-1, 0) for i in pools[label].ids)
    returned = counts[1] - removed + added
    tp_lo = max(0, quality["tp_interval"][0] - removed_unknown) + added
    fn_hi = max(0, quality["fn_interval"][1] - added) + removed_unknown
    quality.update(precision_lower=tp_lo/returned if returned else None,
        recall_lower=tp_lo/(tp_lo+fn_hi) if tp_lo+fn_hi else None,
        tp_interval=(tp_lo, min(returned, quality["tp_interval"][1]+added)),
        fn_interval=(max(0, quality["fn_interval"][0]-added), fn_hi), returned=returned,
        audit_corrections={"removed": removed, "added": added, "unknown_removed": removed_unknown})
    await call("predictions.write", {"model_id": model_id, "offset": -1,
        "ids": audit_ids.tolist(), "labels": [labels[int(i)] for i in audit_ids], "scores": [0.] * len(audit_ids)})
    quality.update(precision_target=cfg["precision_target"], recall_target=cfg["recall_target"],
                   measurement_round=measurement, assumptions="fixed population/predictions; SRS per region; truthful reference labels")
    passed = (quality["precision_lower"] is not None and quality["recall_lower"] is not None
              and quality["precision_lower"] >= cfg["precision_target"]
              and quality["recall_lower"] >= cfg["recall_target"])
    await call("predictions.finish", {"model_id": model_id, "passed": passed, "quality": quality,
        "scope_count": scanned, "returned": returned, "known_ids": known_ids.tolist(),
        "audit_ids": audit_ids.tolist()})
    feasible = next(r["feasible_on_selection"] for r in board if r["name"] == winner.name)
    unknown = counts[-1] or any(labels[int(i)] < 0 for i in audit_ids)
    errors = any(labels[int(i)] != label for label in (0, 1) for i in pools[label].ids)
    next_action = "none" if passed else "read_missing_facts" if unknown else "change_representation_or_discriminator" if errors or not feasible else "increase_independent_measurement"
    await update("quality_passed" if passed else "quality_not_met", quality=quality,
        complete_scope_coverage=True, complete_feature_coverage=stats["missing_features"] == 0,
        predicted_records=scanned, audit_records=len(audit_ids), audit_ids=audit_ids.tolist(),
        returned=returned, unresolved=counts[-1] if passed else stats["corpus_records"]-len(known_ids),
        next_action=next_action)


DECISION_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["rows"], "properties": {"rows": {"type": "array", "items": {
    "type": "object",
    "required": ["ref", "label", "citations", "knowledge_ids", "reason"],
    "properties": {"ref": {"type": "string"}, "label": {"enum": ["accept", "exclude", "undetermined"]},
        "citations": {"type": "array", "items": CITATION_SCHEMA},
        "knowledge_ids": {"type": "array", "items": {"type": "string"}}, "reason": {"type": "string"}}}}}}


def unknown(record: Record, key: str, why: str, manifest: str | None = None) -> Decision:
    return Decision(record.ref, record.identity, key, "undetermined", basis="unresolved",
                    reason=why, error=why, manifest_id=manifest)


async def judge_batch(runtime: Runtime, records: list[Record], instruction: str,
                      *, require_source: bool = True, required_fields: tuple[str, ...] = (), use_cache: bool | None = None) -> list[Decision]:
    """Only ask the model about rows whose required evidence is available."""
    key = runtime.predicate_key(instruction)
    ready, missing = [], {}
    for row in records:
        source_fields = {p.field for p in row.passages if p.origin == 'source' and p.text}
        absent = set((*required_fields, *row.attributes.get('required_evidence_fields', []))) - source_fields
        if absent or (require_source and not source_fields - {'displayId'}):
            missing[row.ref] = unknown(row, key, '需要读取原文字段：' + ', '.join(sorted(absent)) if absent else '需要读取原文依据')
        else:
            ready.append(row)
    judged = await _judge_ready(runtime, ready, instruction, require_source=require_source,
                                required_fields=required_fields, use_cache=use_cache)
    # 初判命中后独立查缺项；不提供初判标签或理由，避免复核沿用相似性结论。
    accepted = {d.ref for d in judged if d.label == 'accept'}
    reviewed = await _judge_ready(runtime, [r for r in ready if r.ref in accepted], instruction,
        require_source=require_source, required_fields=required_fields, use_cache=use_cache, review=True)
    replacements = {d.ref: d for d in reviewed}
    judged = [replacements.get(d.ref, d) for d in judged]
    by_ref = {**missing, **{d.ref: d for d in judged}}
    return [by_ref[row.ref] for row in records]


async def _judge_ready(runtime: Runtime, records: list[Record], instruction: str,
                       *, require_source: bool, required_fields: tuple[str, ...], use_cache: bool | None,
                       review: bool = False) -> list[Decision]:
    if not records:
        return []
    if len({r.ref for r in records}) != len(records):
        raise ValueError("A judgment batch must have distinct record refs")
    key = runtime.predicate_key(instruction)
    # 短别名只用于本批输出；原始身份仍随正文送达并记入宿主回执。
    model_rows = [r.model_payload() for r in records]
    aliases, passage_aliases = {}, {}
    for i, row in enumerate(model_rows):
        # 要求原文判断时只发送来源片段，避免模型用生成摘要代替已读对话。
        if require_source or required_fields or row['attributes'].get('required_evidence_fields'):
            row['passages'] = [p for p in row['passages'] if p['origin'] == 'source']
        row["alias"] = f"@r{i + 1}"
        aliases[row["alias"]] = row["ref"]
        for j, passage in enumerate(row["passages"]):
            passage["alias"] = f"@p{j + 1}"
            passage_aliases[row["ref"], passage["alias"]] = passage["id"]

    def resolved_rows(payload):
        # 严格按本批映射还原，不移动引文、不猜测段落、不修改模型标签。
        for item in payload["rows"]:
            citations = []
            for citation in item["citations"]:
                ref = aliases.get(citation["ref"], citation["ref"])
                citations.append({**citation, "ref": ref, "passage_id":
                    passage_aliases.get((ref, citation["passage_id"]), citation["passage_id"])})
            yield {**item, "ref": aliases.get(item["ref"], item["ref"]), "citations": citations}

    def cacheable(payload):
        # Cache only complete, reusable decisions; per-row invalid output is
        # still returned as Unknown below, and can be repaired on the next run.
        items = list(resolved_rows(payload))
        if len(items) != len(records) or {x["ref"] for x in items} != {r.ref for r in records}:
            return False
        wiki = {e["id"] for e in runtime.knowledge.entries}
        by_id = {r.ref: r for r in records}
        for item in items:
            row = by_id[item["ref"]]
            try:
                refs = verify_citations(item["citations"], [row])
            except ProtocolError:
                return False
            if item["label"] == "undetermined" or not refs or not set(item["knowledge_ids"]).issubset(wiki):
                return False
            if require_source and not any(c.origin == "source" and c.field != "displayId" for c in refs):
                return False
            if any(not any(c.origin == "source" and c.field == f for c in refs)
                   for f in (*required_fields, *row.attributes.get("required_evidence_fields", []))):
                return False
        return True
    result = await runtime.call("sem_filter", instruction,
        {"records": model_rows,
         "review_stage": "criterion_gaps" if review else "initial",
         "output_instructions": ("独立复核全部查询条件，不能由结果反推原状态。" if review else "") +
             "逐条返回 accept（全部满足）、exclude（明确不符）或 undetermined（证据不足），reason 简述依据或缺项。"
             "引用用记录/段落 alias（@r1/@p1），quote 为原文连续短句；required_fields 须有 source 引用。"
             "已有疑点未被证据解决时保留未决。knowledge_ids 只填实际用到的知识。仅调用 submit_result 一次，不输出思考过程。",
         "require_source": require_source, "required_fields": required_fields}, DECISION_SCHEMA, cache_if=cacheable, use_cache=use_cache)
    # 保留每个 ref 的全部返回项，用数量检查识别缺失和重复，而不是静默覆盖。
    by_ref: dict[str, list[dict[str, Any]]] = {}
    for row in resolved_rows(result.payload):
        by_ref.setdefault(row["ref"], []).append(row)
    supplied = {r.ref for r in records}
    if set(by_ref)-supplied:
        runtime.store.observe(runtime.scope.task_id, "unexpected_output_refs", {"op": "sem_filter", "manifest": result.manifest_id})
    # Wiki 只能引用本轮真实提供的条目，不能由模型创造知识来源。
    wiki_ids = {e["id"] for e in runtime.knowledge.entries}
    out = []
    for record in records:
        row_list = by_ref.get(record.ref, [])
        if len(row_list) != 1:
            out.append(unknown(record, key, "missing_or_duplicate_output", result.manifest_id))
            continue
        row = row_list[0]
        try:
            # 每条决定只核验自身记录，杜绝借用同批其他工单的证据。
            citations = verify_citations(row["citations"], [record])
            if not set(row["knowledge_ids"]).issubset(wiki_ids):
                raise ProtocolError("Knowledge reference was not supplied")
            if row["label"] != "undetermined":
                if not citations or (require_source and not any(c.origin == "source" and c.field != "displayId" for c in citations)):
                    raise ProtocolError("Decision lacks the required actual source evidence")
                # 调用方要求与记录自身要求合并；每个字段都必须有 source 原文引文。
                fields = (*required_fields, *record.attributes.get("required_evidence_fields", []))
                if any(not any(c.field == field and c.origin == "source" for c in citations) for field in fields):
                    out.append(unknown(record, key, "需要读取并引用原文字段：" + ", ".join(fields), result.manifest_id))
                    continue
            out.append(Decision(record.ref, record.identity, key, row["label"], citations,
                 tuple(row["knowledge_ids"]), "reused_model" if result.cache_hit else "model",
                 row["reason"], result.manifest_id))
        except ProtocolError:
            # 引文或知识引用不合法时保守降级为未决，不保留模型给出的业务标签。
            out.append(unknown(record, key, "invalid_evidence_reference", result.manifest_id))
    return out
