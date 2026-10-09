"""全集学习式 filter 与共享标签读取；只有显式小范围或 baseline 使用逐条判断。"""
from __future__ import annotations
import asyncio
from uuid import uuid4
from dataclasses import asdict, replace
from time import perf_counter
from typing import Any, AsyncIterable
import numpy as np
from scipy.sparse import vstack
from threadpoolctl import threadpool_limits
from .runtime import Runtime, CITATION_SCHEMA, SamplingLimitReached
from .features import FeatureBlock, decode_block, PrioritySample
from .models import fit_models, choose_model, model_bank
from .types import Decision, ProtocolError, Record, verify_citations, digest

async def sem_filter(runtime: Runtime, source: AsyncIterable[Record], instruction: str, *,
                     algorithm="auto", options=None, scope_mode="full", online_feedback_training=True, **kwargs):
    """在线学习、冻结教师和无标签固定池均经同一授权入口。"""
    if type(online_feedback_training) is not bool:
        raise ProtocolError("online_feedback_training must be boolean")
    # Explicit frozen methods remain selected when feedback training is disabled.
    if not online_feedback_training and algorithm in {"auto", "active", "learned"}:
        algorithm = "direct_teacher"
    if algorithm in {"dual_description_margin", "name_gmm", "kmeans"}:
        if scope_mode != "full" or kwargs.get("stop_after_accepted") is not None:
            raise ProtocolError("Unlabeled methods require the complete recall scope")
        from .unlabeled_filter import unlabeled_filter
        await unlabeled_filter(runtime, instruction, method=algorithm, options=options, **kwargs)
        return
    elif algorithm in {"direct", "direct_teacher"} and scope_mode == "full" and kwargs.get("stop_after_accepted") is None:
        stream = frozen_teacher_filter(runtime, instruction, options=options, **kwargs)
    elif algorithm in {"auto", "active", "learned"} and scope_mode == "full" and kwargs.get("stop_after_accepted") is None:
        stream = learned_filter(runtime, instruction, options=options, **kwargs)
    elif algorithm in {"direct", "direct_teacher", "baseline", "cluster"} or scope_mode == "candidates" or kwargs.get("stop_after_accepted") is not None:
        from .baseline import clustered_filter
        kwargs.pop("initial_refs", None)
        kwargs.pop("recall_scope_key", None)
        for name in ("embedding_id", "query_anchor", "negative_anchor"):
            kwargs.pop(name, None)
        stream = clustered_filter(runtime, source, instruction, algorithm="cluster" if algorithm == "cluster" else "auto",
                                  options=options if algorithm in {"baseline", "cluster"} else None, **kwargs)
    else:
        raise ValueError("Unknown filter algorithm or scope")
    async for result in stream:
        yield result


async def frozen_teacher_filter(runtime, instruction, *, options=None, batch_size=8,
                                require_source=True, required_fields=(), recall_scope_key=None, **_):
    """枚举授权原文并冻结教师逐票判断；不拟合或反馈更新模型。"""
    if runtime.resources is None:
        raise ValueError("Full-scope direct filter requires an authorized numeric feature provider")
    block_size = (options or {}).get("block_size", 1024)
    if type(block_size) is not int or block_size < 1 or type(batch_size) is not int or batch_size < 1:
        raise ValueError("Physical block/batch sizes must be positive integers")
    block_size = min(block_size, 1024)
    call = runtime.resources
    stats = {"algorithm": "direct_teacher", "regime": "frozen_teacher", "online_feedback_training": False,
             "input_revision": runtime.scope.input_revision, "fit_count": 0,
             "training_records": 0, "selection_records": 0, "scope_records": 0,
             "corpus_records": 0, "teacher_unique_records": 0, "positive_records": 0,
             "negative_records": 0, "undetermined_records": 0, "scan_passes": 1,
             "completion_basis": "input_enumeration", "complete_scope_coverage": False,
             "global_semantic_recall": "not_established",
             "task_semantics": "recall_candidate_scope" if recall_scope_key else "full_authorized_scope",
             **({"recall_scope_key": recall_scope_key} if recall_scope_key else {})}
    async def update(reason):
        await runtime.scope.check()
        stats["unresolved"] = stats["undetermined_records"]
        await call("learning.update", {**stats, "stop_reason": reason,
            'sampling_request_limit': 128, 'judge_mode': getattr(runtime, 'judge_mode', 'compact_binary'),
            'judge_readout': getattr(runtime, 'judge_metrics', {}),
            "sampling_requests": runtime.store.sampling_calls(runtime.scope),
            "_usage": runtime.store.metrics(runtime.scope.task_id)})
    await update("frozen_running")
    cursor, feature_id, population_count = None, None, None
    seen_ids, seen_refs, seen_cursors = set(), set(), set()
    while True:
        await runtime.scope.check()
        page = await call("features.scan", {"cursor": cursor, "page_size": block_size, "ranked": False})
        page_feature_id = page.get("feature_id")
        if not page_feature_id or (feature_id is not None and feature_id != page_feature_id):
            raise ValueError("Numeric feature identity changed during frozen filtering")
        feature_id = page_feature_id
        count = page.get("population_count")
        if count is not None:
            if type(count) is not int or count < 0 or (population_count is not None and count != population_count):
                raise ValueError("Authorized population changed during frozen filtering")
            population_count = count
        ids = page.get("ids")
        if not isinstance(ids, list) or len(ids) > block_size or any(type(i) is not int for i in ids):
            raise ProtocolError("Invalid authorized numeric ID page")
        if len(set(ids)) != len(ids) or seen_ids.intersection(ids):
            raise ProtocolError("Authorized numeric IDs must be distinct")
        seen_ids.update(ids)
        stats["corpus_records"] = population_count if population_count is not None else len(seen_ids)
        await runtime.scope.check()
        response = await call("rows.read", {"ids": ids}) if ids else {"rows": []}
        rows = [Record.from_dict(row) for row in response["rows"]]
        if len(rows) != len(ids):
            raise ValueError("Authorized row cardinality changed during frozen filtering")
        refs = [row.ref for row in rows]
        if len(set(refs)) != len(refs) or seen_refs.intersection(refs):
            raise ProtocolError("Authorized record refs must be distinct")
        seen_refs.update(refs)
        for start in range(0, len(rows), batch_size):
            await runtime.scope.check()
            part = rows[start:start + batch_size]
            decisions = await judge_batch(runtime, part, instruction,
                require_source=require_source, required_fields=required_fields)
            for decision in decisions:
                stats[{"accept": "positive_records", "exclude": "negative_records",
                       "undetermined": "undetermined_records"}[decision.label]] += 1
                stats["scope_records"] += 1
                stats["teacher_unique_records"] += 1
                yield {"type": "decision", "value": asdict(decision)}
            if any(d.error == 'sampling_request_limit' for d in decisions):
                stats['message'] = '未完成：128次独立判断额度内未完成，仅返回已确认工单。'
                await update('model_unknown')
                return
            await update("frozen_running")
        cursor = page.get("next_cursor")
        if cursor is None:
            if population_count is not None and len(seen_ids) != population_count:
                raise ValueError("Authorized population cardinality changed during frozen filtering")
            break
        if cursor in seen_cursors:
            raise ProtocolError("Authorized scan cursor must advance")
        seen_cursors.add(cursor)
    # completed只表示遍历结束；未知项单列，不生成学习模型或选择集quality。
    stats["complete_scope_coverage"] = True
    await update("frozen_completed")


async def learned_filter(runtime, instruction, *, options=None, batch_size=8,
                         initial_refs=(), host_labels=None, require_source=True, required_fields=(),
                         recall_scope_key=None, **_):
    if options and ("methods" in options or "fusion" in options):
        from .online_group_filter import online_group_filter
        async for event in online_group_filter(runtime, instruction, options=options,
            batch_size=batch_size, initial_refs=initial_refs, host_labels=host_labels,
            require_source=require_source, required_fields=required_fields, recall_scope_key=recall_scope_key):
            yield event
        return
    cfg = {"block_size": 16384, "pool_size": 4096, "sample_size": 128,
           "selection_size": 256, "workers": 1,
           "precision_target": .95, "recall_target": .95,
           "seed": 0, "concurrency": 4}
    supplied = dict(options or {})
    # 旧 active 参数仅作迁移读取；区域污染容忍度不再冒充召回目标。
    for old in ("proposal", "clusters", "accept_error", "reject_error", "validation_size", "delta"):
        supplied.pop(old, None)
    cfg.update(supplied)
    if runtime.resources is None:
        raise ValueError("Full-scope filter requires an authorized numeric feature provider")
    if any(cfg[k] < 1 for k in ("block_size", "pool_size", "sample_size", "selection_size", "workers", "concurrency")):
        raise ValueError("Physical block/sample/worker sizes must be positive")
    if not all(0 < cfg[k] < 1 for k in ("precision_target", "recall_target")):
        raise ValueError("Quality targets and delta must be between zero and one")
    call = runtime.resources
    key = runtime.predicate_key(instruction)
    # 召回并集变化时，历史标签与模型状态必须随范围一起失效。
    scoped_key = digest(['recall-scope-v1', recall_scope_key, key]) if recall_scope_key else key
    checkpoint_key = digest(['learned-ranked-resume-v4' if recall_scope_key else 'learned-ranked-resume-v3',
        scoped_key, require_source, required_fields,
        {k: v for k, v in cfg.items() if k not in {'block_size', 'workers', 'concurrency'}}])
    seeds = await call("features.seeds", {"refs": list(dict.fromkeys([*initial_refs, *(host_labels or {})]))})
    checkpoint = runtime.store.learning_checkpoint(runtime.scope.key, checkpoint_key)
    if checkpoint and checkpoint['stats']['feature_id'] != seeds.get('feature_id'):
        checkpoint = None
    stats = {"algorithm": "learned", "predicate_key": key, "input_revision": runtime.scope.input_revision,
             **({"recall_scope_key": recall_scope_key} if recall_scope_key else {}),
             "corpus_records": 0, "feature_records": 0, "missing_features": 0,
             "scan_passes": 0, "fit_count": 0, "teacher_unique_records": 0,
             "training_records": 0, "selection_records": 0, "quality_basis": "selection",
             "scan_seconds": 0., "fit_seconds": 0., "predict_seconds": 0.,
             "global_semantic_recall": "not_established", "task_semantics": "recall_candidate_scope" if recall_scope_key else "full_authorized_scope",
             "sampling_phase": "discovery", "sampling_method": "ngram_vector_desc",
             "training_sampling_method": "ngram_vector_desc", "selection_sampling_method": "ranked_70_30_holdout"}
    labels, models, pool_order, selection_ids = {}, [], np.array([], dtype=np.int64), np.array([], dtype=np.int64)
    previous_models = checkpoint['models'] if checkpoint else []
    split_assignments = dict(checkpoint.get('split_assignments', {})) if checkpoint else {}
    priorities = {}
    model_labels = {}
    unresolved_evidence = {}

    def save_checkpoint():
        # 缓存有界排序池、选择集和小模型；续跑复用分数与划分，全集向量仍在 Provider。
        runtime.store.save_learning_checkpoint(runtime.scope.key, checkpoint_key,
            {'stats': stats.copy(), 'pool_order': pool_order, 'selection_ids': selection_ids,
             'models': models, 'model_labels': model_labels, 'priorities': priorities,
             'split_assignments': split_assignments})

    async def update(reason, **extra):
        requests = runtime.store.sampling_calls(runtime.scope)
        stats.update(positive_records=sum(v == 1 for v in labels.values()),
                     negative_records=sum(v == 0 for v in labels.values()),
                     undetermined_records=sum(v < 0 for v in labels.values()), batch_size=batch_size,
                     concurrency=cfg['concurrency'], sample_size=cfg['sample_size'],
                     precision_target=cfg['precision_target'], recall_target=cfg['recall_target'],
                     sampling_requests=requests)
        if requests >= 128 and reason in {'needs_selection_coverage', 'needs_coverage', 'needs_information'}:
            reason = 'model_unknown'
            extra.update(message='未完成：128次独立判断额度内依据不足，仅返回已确认工单。',
                         next_action='return_confirmed_only')
        stats.update(stop_reason=reason, sampling_request_limit=128, **extra)
        if reason in {'needs_selection_coverage', 'needs_coverage', 'needs_information', 'quality_passed', 'quality_fallback', 'model_unknown'}:
            save_checkpoint()
        await call("learning.update", {**stats, 'judge_mode': getattr(runtime, 'judge_mode', 'compact_binary'),
            'judge_readout': getattr(runtime, 'judge_metrics', {}), "_usage": runtime.store.metrics(runtime.scope.task_id)})

    async def cannot_judge(reason, **extra):
        await update('model_unknown', message='未完成：' + reason + '，仅返回已确认工单。',
                     unresolved=stats['corpus_records']-sum(v >= 0 for v in labels.values()),
                     next_action='return_confirmed_only', **extra)

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
        await update('sampling', sampling_phase=phase)
        width = batch_size * cfg["concurrency"]
        async def one(part, rows):
            decisions = await judge_batch(runtime, rows, instruction,
                require_source=require_source, required_fields=required_fields, sampling=True)
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
            pending = [asyncio.create_task(one([i for i, _ in fresh[start:start+batch_size]],
                [row for _, row in fresh[start:start+batch_size]])) for start in range(0, len(fresh), batch_size)]
            try:
                jobs = await asyncio.gather(*pending)
            except BaseException:
                # 一批任一模型请求失败时取消并收束同批请求，保证终态计量不留下 running。
                for task in pending:
                    if not task.done(): task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                raise
            for part, decisions in jobs:
                for ident, decision in zip(part, decisions):
                    labels[ident] = {"accept": 1, "exclude": 0, "undetermined": -1}[decision.label]
                    yield {"type": "decision", "value": asdict(decision)}
            stats["teacher_unique_records"] = len(labels)
            runtime.store.save(runtime.scope.key, "learned_labels", scoped_key,
                {"feature_id": stats["feature_id"], "labels": labels, 'unresolved_evidence': unresolved_evidence})
            await update('sampling', sampling_phase=phase)

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
    history = runtime.store.output(runtime.scope.key, "learned_labels", scoped_key)
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

    # 新 ID 按当前融合分数顺序补角色；已判样本沿用checkpoint角色，避免续跑改变训练/留出归属。
    selection_count = sum(role == 'selection' for role in split_assignments.values())
    for ident in pool_order:
        ident = int(ident)
        if ident in split_assignments:
            continue
        position = len(split_assignments) + 1
        if selection_count < cfg['selection_size'] and selection_count + 1 <= (3 * position) // 10:
            split_assignments[ident] = 'selection'
            selection_count += 1
        else:
            split_assignments[ident] = 'training'
    selection_ids = np.asarray([i for i in pool_order if split_assignments[int(i)] == 'selection'], dtype=np.int64)
    if checkpoint:
        await update('resuming_discovery', reused_label_records=len(labels), reused_training_records=0)
    selection_set = set(map(int, selection_ids))
    train_pool = np.asarray([i for i in pool_order if i not in selection_set], dtype=np.int64)
    stats['selection_ids'] = selection_ids.tolist()
    def next_discovery():
        return [int(i) for i in pool_order if i not in labels][:cfg['sample_size']]
    def training_classes():
        return {v for i, v in labels.items() if v >= 0 and i not in selection_set}
    def selection_classes():
        return {labels[int(i)] for i in selection_ids if int(i) in labels and labels[int(i)] >= 0}
    if checkpoint and len(training_classes()) >= 2 and len(selection_classes()) < 2 and \
            not any(int(i) not in labels for i in selection_ids):
        missing = [name for value, name in ((1, 'positive'), (0, 'negative')) if value not in selection_classes()]
        prior_train_ids = [int(i) for i, role in split_assignments.items()
                           if role == 'training' and labels.get(int(i), -1) >= 0]
        stats.update(fit_count=len(previous_models), training_ids=prior_train_ids,
                     training_records=len(prior_train_ids), selection_ids=[int(i) for i in selection_ids
                         if int(i) in labels], selection_records=len([i for i in selection_ids if int(i) in labels]))
        await update('needs_coverage', selection_records=len([i for i in selection_ids if int(i) in labels]),
            selection_ids=[int(i) for i in selection_ids if int(i) in labels], missing_selection_labels=missing,
            next_action='new_expressions_or_clarify_predicate')
        return
    if not len(train_pool):
        await update("needs_coverage", unresolved=stats["corpus_records"], next_action="expand_discovery_or_use_explicit_small_scope_reference")
        return
    await update('ranked_sampling', sampling_method='ngram_vector_desc', pool_records=len(train_pool))
    # 续跑仍从全局排序中取下一个窗口；训练集或选择集缺少类别时都必须前进，
    # 否则已有两类训练标签会让 needs_selection_coverage 永远原地打转。
    needs_discovery = len(training_classes()) < 2 or len(selection_classes()) < 2
    discovery = next_discovery() if needs_discovery else []
    if discovery:
        async for event in ask(discovery, 'training_discovery' if not checkpoint else 'expanded_ranked_coverage'):
            yield event
    train_ids = np.array([i for i, v in labels.items() if v >= 0 and i not in selection_set], dtype=np.int64)
    if len(training_classes()) < 2:
        await update("needs_coverage" if any(v >= 0 for v in labels.values()) else "needs_information",
                     training_ids=train_ids.tolist(), training_records=len(train_ids),
                     missing_training_labels=[name for value, name in ((1, 'positive'), (0, 'negative')) if value not in training_classes()],
                     discovery_remaining_records=sum(i not in labels for i in pool_order),
                     unresolved=stats["corpus_records"]-sum(v >= 0 for v in labels.values()),
                     next_action="continue_ranked_discovery" if any(i not in labels for i in pool_order) else
                         "new_expressions_or_clarify_predicate" if any(v >= 0 for v in labels.values()) else "read_missing_facts")
        return
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
    observed_selection = np.array([i for i in selection_ids if i in labels], dtype=np.int64)
    stats["selection_records"] = len(observed_selection)
    stats["selection_ids"] = observed_selection.tolist()
    if len({labels[int(i)] for i in observed_selection if labels[int(i)] >= 0}) < 2:
        # 已推进一个全局排序窗口仍缺少选择集类别时，等待下一次续跑继续前进。
        remaining = len([i for i in selection_ids if i not in labels])
        await update("needs_selection_coverage" if remaining else "needs_coverage",
                     selection_remaining_records=remaining,
                     unresolved=stats["corpus_records"]-sum(v >= 0 for v in labels.values()),
                     missing_selection_labels=[name for value, name in ((1, 'positive'), (0, 'negative'))
                         if value not in {labels[int(i)] for i in observed_selection if labels[int(i)] >= 0}],
                     next_action="continue_ranked_discovery" if remaining else "new_expressions_or_clarify_predicate")
        return
    selection = await take(observed_selection)
    # 留出样本选择模型与阈值；达标后直接预测，经验指标不代表全库质量。
    await update('selecting')
    winner, threshold, board = choose_model(models, selection.views,
        np.array([labels[int(i)] for i in selection.ids]), corpus_size=stats["corpus_records"],
        precision_target=cfg["precision_target"], recall_target=cfg["recall_target"])
    if previous_models:
        prior_winner, prior_threshold, prior_board = choose_model(previous_models, selection.views,
            np.array([labels[int(i)] for i in selection.ids]), corpus_size=stats["corpus_records"],
            precision_target=cfg["precision_target"], recall_target=cfg["recall_target"])
        prior_quality = (any(row['feasible_on_selection'] for row in prior_board),
                         max((row['f1'] for row in prior_board), default=0.))
        new_quality = (any(row['feasible_on_selection'] for row in board),
                       max((row['f1'] for row in board), default=0.))
        if prior_quality > new_quality:
            models, winner, threshold, board = previous_models, prior_winner, prior_threshold, prior_board
    if not any(row["feasible_on_selection"] for row in board):
        # 误差修正仍读取下一个全局排序窗口；新训练标签进入下一轮拟合。
        more = next_discovery()
        if more:
            expanded_previous_models = models
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
            stats.update(fit_count=stats["fit_count"]+len(models), training_records=len(train_ids), training_ids=train_ids.tolist())
            observed_selection = np.array([i for i in selection_ids if i in labels], dtype=np.int64)
            stats.update(selection_records=len(observed_selection), selection_ids=observed_selection.tolist())
            if len({labels[int(i)] for i in observed_selection if labels[int(i)] >= 0}) < 2:
                remaining = len([i for i in pool_order if i not in labels])
                await update('needs_selection_coverage' if remaining else 'needs_coverage',
                    selection_remaining_records=remaining,
                    next_action='continue_ranked_discovery' if remaining else 'new_expressions_or_clarify_predicate')
                return
            selection = await take(observed_selection)
            await update('selecting')
            new_winner, new_threshold, new_board = choose_model(models, selection.views,
                np.array([labels[int(i)] for i in selection.ids]), corpus_size=stats["corpus_records"],
                precision_target=cfg["precision_target"], recall_target=cfg["recall_target"])
            old_winner, old_threshold, old_board = choose_model(expanded_previous_models, selection.views,
                np.array([labels[int(i)] for i in selection.ids]), corpus_size=stats["corpus_records"],
                precision_target=cfg["precision_target"], recall_target=cfg["recall_target"])
            # 新旧模型在同一累计选择集上重评，保留历轮中表现更好的候选。
            old_score = max((row['f1'] for row in old_board), default=0.)
            new_score = max((row['f1'] for row in new_board), default=0.)
            if (any(row['feasible_on_selection'] for row in old_board), old_score) > \
                    (any(row['feasible_on_selection'] for row in new_board), new_score):
                models, winner, threshold, board = expanded_previous_models, old_winner, old_threshold, old_board
            else:
                winner, threshold, board = new_winner, new_threshold, new_board
    stats.update(models=board, selected_model=winner.name, threshold=threshold)
    selected = next(row for row in board if row['name'] == winner.name)
    quality = {"basis": "selection", **{k: selected[k] for k in ('precision', 'recall', 'f1', 'selection_unknown')},
               "selection_records": len(observed_selection), "precision_target": cfg['precision_target'],
               "recall_target": cfg['recall_target'], "minimum_precision": .6,
               "acceptance": 'target' if selected['feasible_on_selection'] else 'fallback'}
    if selected['precision'] < .6:
        quality['acceptance'] = 'unknown'
        await cannot_judge('最佳模型的选择集查准率低于 60%', quality=quality)
        return
    stats['quality'] = quality
    await update('predicting', predicted_records=0)
    model_id = digest([scoped_key, winner.name, threshold, sorted(labels.items()), str(uuid4())])
    await call("predictions.begin", {"model_id": model_id, "predicate_key": key,
        "feature_id": stats["feature_id"], "input_revision": runtime.scope.input_revision,
        "training_records": len(train_ids), "fit_count": len(models), "model": winner.name,
        "threshold": threshold, "task_semantics": "recall_candidate_scope" if recall_scope_key else "full_authorized_scope",
        **({"recall_scope_key": recall_scope_key} if recall_scope_key else {})})
    # 选模后只做数值扫描；已有判断覆盖预测，未知项保留，不再读取正文或调用大模型。
    known_ids = np.array(sorted(labels), dtype=np.int64)
    known_labels = np.array([labels[int(i)] for i in known_ids], dtype=np.int8)
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
        for label in counts:
            counts[label] += int(np.count_nonzero(predictions == label))
        stats["predict_seconds"] += perf_counter()-start
        # 只有块数组通过 Host，模型与选择集指标仅存一份。
        await call("predictions.write", {"model_id": model_id, "offset": scanned,
            "ids": block.ids.tolist(), "labels": predictions.tolist(),
            "scores": np.where(np.isfinite(scores), scores, 0).tolist()})
        scanned += len(block.ids)
        await update('predicting', predicted_records=scanned)
    await call("predictions.finish", {"model_id": model_id, "passed": True, "quality": quality,
        "scope_count": scanned, "returned": counts[1]})
    await update("quality_passed" if selected['feasible_on_selection'] else "quality_fallback", quality=quality,
        complete_scope_coverage=True, complete_feature_coverage=stats["missing_features"] == 0,
        predicted_records=scanned, returned=counts[1], unresolved=counts[-1],
        next_action='return_confirmed_results')


DECISION_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["rows"], "properties": {"rows": {"type": "array", "items": {
    "type": "object",
    "required": ["ref", "label", "confidence", "citations", "knowledge_ids", "reason"],
    "properties": {"ref": {"type": "string"}, "label": {"enum": ["accept", "exclude"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "citations": {"type": "array", "items": CITATION_SCHEMA},
        "knowledge_ids": {"type": "array", "items": {"type": "string"}}, "reason": {"type": "string"}}}}}}

COMPACT_DECISION_SCHEMA = {"type": "object", "additionalProperties": False,
    "required": ["rows"], "properties": {"rows": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["ref", "label", "confidence"],
    "properties": {"ref": {"type": "string"}, "label": {"enum": ["yes", "no"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1}}}}}}


def unknown(record: Record, key: str, why: str, manifest: str | None = None,
            error: str | None = None) -> Decision:
    return Decision(record.ref, record.identity, key, "undetermined", basis="unresolved",
                    reason=why, error=error or why, manifest_id=manifest)


async def judge_batch(runtime: Runtime, records: list[Record], instruction: str,
                      *, require_source: bool = True, required_fields: tuple[str, ...] = (), use_cache: bool | None = None,
                      sampling: bool = False) -> list[Decision]:
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
                                required_fields=required_fields, use_cache=use_cache, sampling=sampling)
    # 每条教师伪标签只判断一次，直接用于后续监督训练。
    by_ref = {**missing, **{d.ref: d for d in judged}}
    return [by_ref[row.ref] for row in records]


async def _judge_ready(runtime: Runtime, records: list[Record], instruction: str,
                       *, require_source: bool, required_fields: tuple[str, ...], use_cache: bool | None,
                       review: bool = False, sampling: bool = False, force_compact: bool = False) -> list[Decision]:
    if not records:
        return []
    if len({r.ref for r in records}) != len(records):
        raise ValueError("A judgment batch must have distinct record refs")
    key = runtime.predicate_key(instruction)
    compact = getattr(runtime, 'judge_mode', None) in {'compact_binary', 'anyjev_l0'} or (not require_source and not required_fields and not any(
        r.attributes.get('required_evidence_fields') for r in records) and all(
        p.field in {'title', 'summary', 'displayId'} for r in records for p in r.passages))
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
            if compact:
                ref = aliases.get(item["ref"], item["ref"])
                record = next((r for r in records if r.ref == ref), None)
                # 短输出只决定标签；引用绑定本次完整送达的正文，明确保留生成来源。
                yield {**item, "ref": ref, "label": "accept" if item["label"] == "yes" else "exclude",
                    "citations": [{"ref": ref, "passage_id": p.id, "quote": p.text}
                        for p in record.passages if p.text and p.field != 'displayId'
                        and (not (require_source or required_fields or record.attributes.get('required_evidence_fields')) or p.origin == 'source')] if record else [],
                    "knowledge_ids": [], "reason": "依据本次提供的工单正文完成二选一判断。"}
                continue
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
            if not refs or not set(item["knowledge_ids"]).issubset(wiki):
                return False
            if require_source and not any(c.origin == "source" and c.field != "displayId" for c in refs):
                return False
            if any(not any(c.origin == "source" and c.field == f for c in refs)
                   for f in (*required_fields, *row.attributes.get("required_evidence_fields", []))):
                return False
        return True
    try:
        if compact and not force_compact and getattr(runtime, 'judge_mode', 'compact_binary') == 'anyjev_l0':
            from .binary_readout import judge_readout
            async def fallback(rows):
                # 局部切换输出协议，避免并发修改Runtime的模式。
                return await _judge_ready(runtime, rows, instruction, require_source=require_source,
                    required_fields=required_fields, use_cache=use_cache, review=review, sampling=sampling,
                    force_compact=True)
            readout_records = [replace(r, passages=tuple(p for p in r.passages if p.origin == 'source'))
                if require_source or required_fields or r.attributes.get('required_evidence_fields') else r for r in records]
            return await judge_readout(runtime, readout_records, instruction, key, fallback, use_cache, sampling, review)
        return await _call_judge(runtime, records, instruction, model_rows, compact, review,
            require_source, required_fields, cacheable, resolved_rows, use_cache, sampling, key)
    except SamplingLimitReached:
        return [unknown(r, key, 'sampling_request_limit') for r in records]


async def _call_judge(runtime, records, instruction, model_rows, compact, review,
        require_source, required_fields, cacheable, resolved_rows, use_cache, sampling, key):
    # 紧凑判断只复制批内短引用；收到后由既有映射还原工单身份，不按返回位置猜测。
    if compact:
        model_rows = [{**row, 'record_ref': row['ref'], 'ref': row['alias']} for row in model_rows]
    result = await runtime.call("sem_filter", instruction,
        {"records": model_rows,
         **({"decision_format": "compact_binary"} if compact else {}),
         "review_stage": "criterion_gaps" if review else "initial",
         "output_instructions": ("独立重新判断全部条件，不参考初判标签或理由，也不能由结果反推原状态。" if review else "") +
             "逐条从 accept（相关）与 exclude（不相关）中选择最贴近查询的一项。查询是唯一业务标准；综合本条工单实际内容判断，不因关键词相似就判相关。"
             "缺少支持相关的事实时选择 exclude，并降低 confidence；必须提交一个二选一标签。confidence 是对所选标签的0到1自报确信程度，不是校准概率，也不作为硬门槛。reason 用一句话说明决定性事实或缺失点。"
             "引用必须使用本条已提供的记录/段落 alias（@r1/@p1）及原文连续短句；required_fields 必须有对应 source 引用。knowledge_ids 只填实际使用的知识。仅调用 submit_result 一次，不输出思考过程。"
             if not compact else ("独立检查所有条件。" if review else "") +
             "按查询判断工单是否直接满足业务条件，不能仅由关键词相似判相关。每条只返回ref、label（yes或no）、confidence（0到1对所选标签的自报确信程度）。禁止理由、引文和其他字段；确信程度不是校准概率。只调用submit_result一次。",
         "require_source": require_source, "required_fields": required_fields}, COMPACT_DECISION_SCHEMA if compact else DECISION_SCHEMA,
        cache_if=cacheable, use_cache=use_cache, sampling=sampling)
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
            if not citations or (require_source and not any(c.origin == "source" and c.field != "displayId" for c in citations)):
                raise ProtocolError("Decision lacks the required actual source evidence")
            # 调用方要求与记录自身要求合并；每个字段都必须有 source 原文引文。
            fields = (*required_fields, *record.attributes.get("required_evidence_fields", []))
            if any(not any(c.field == field and c.origin == "source" for c in citations) for field in fields):
                out.append(unknown(record, key, "需要读取并引用原文字段：" + ", ".join(fields), result.manifest_id))
                continue
            out.append(Decision(record.ref, record.identity, key, row["label"], citations,
                 tuple(row["knowledge_ids"]), "reused_model" if result.cache_hit else "model",
                 row["reason"], result.manifest_id, confidence=row["confidence"]))
        except ProtocolError as exc:
            # 引文或知识引用不合法时保守降级为未决，不保留模型给出的业务标签。
            out.append(unknown(record, key, "invalid_evidence_reference", result.manifest_id, str(exc)))
    return out
