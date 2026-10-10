"""固定排名前128教师伪标签，训练内OOF择优后全量拟合并预测召回并集。"""
from __future__ import annotations
import asyncio
from dataclasses import asdict
from time import perf_counter
import numpy as np
from scipy.sparse import vstack
from .features import FeatureBlock, PrioritySample, decode_block
from .ensemble import (DEFAULT_METHODS, GROUP_PROJECTION, group_closure,
                       validate_group_metadata, select_group_crossfit, binary_report)
from .types import Record, ProtocolError, digest


class ConstantTeacherSelection:
    name = "teacher_constant"
    threshold = .5

    def __init__(self, label):
        self.label = label

    def score_views(self, views):
        return np.full(next(iter(views.values())).shape[0], self.label, dtype=float)


async def online_group_filter(runtime, instruction, *, options=None, batch_size=8,
        require_source=True, required_fields=(), recall_scope_key=None):
    from .filter import judge_batch
    batch_size = 8
    cfg = {"block_size": 1024, "pool_size": 4096, "sample_size": 128, "selection_size": 128,
        "workers": 1, "precision_target": .95, "recall_target": .95, "seed": 0, "concurrency": 4,
        "methods": list(DEFAULT_METHODS), "fusion": "single", "exploration_fraction": 0.,
        "fit_budget_seconds": 30.}
    supplied = dict(options or {})
    for obsolete in ("proposal", "clusters", "accept_error", "reject_error", "validation_size", "delta"):
        supplied.pop(obsolete, None)
    if set(supplied) - set(cfg):
        raise ValueError("Unknown online learning option")
    # 默认与显式入口使用同一六模型库；仅投票配置决定是否融合。
    cfg.update(supplied)
    cfg.update(sample_size=128, exploration_fraction=0.)
    cfg["pool_size"] = max(128, cfg["pool_size"])
    if runtime.resources is None:
        raise ValueError("Online learning requires authorized numeric features")
    for name in ("block_size", "pool_size", "sample_size", "selection_size", "workers", "concurrency"):
        if type(cfg[name]) is not int or not 1 <= cfg[name] <= 65536:
            raise ValueError("Invalid online physical size")
    if type(cfg["seed"]) is not int or cfg["fusion"] not in {"single", "selective"}:
        raise ValueError("Invalid online seed/fusion")
    for name in ("precision_target", "recall_target"):
        if isinstance(cfg[name], bool) or not isinstance(cfg[name], (int, float)) or not 0 < cfg[name] < 1:
            raise ValueError("Invalid online ratio")
    if isinstance(cfg["fit_budget_seconds"], bool) or not isinstance(cfg["fit_budget_seconds"], (int, float)) or not 0 < cfg["fit_budget_seconds"] <= 120:
        raise ValueError("Invalid online fit budget")
    # Validate names before any feature, teacher or training operation.
    if not isinstance(cfg["methods"], list) or not cfg["methods"] or len(set(cfg["methods"])) != len(cfg["methods"]) or any(
            name not in {*DEFAULT_METHODS, "sparse_svm"} for name in cfg["methods"]):
        raise ValueError("Invalid online methods")
    cfg["block_size"] = min(1024, cfg["block_size"])
    call, key = runtime.resources, runtime.predicate_key(instruction)
    scoped_key = digest(["recall-scope-v1", recall_scope_key, key]) if recall_scope_key else key
    checkpoint_key = digest(["online-group-resume-v1", scoped_key, require_source, required_fields,
        {k: v for k, v in cfg.items() if k not in {"block_size", "workers", "concurrency", "fit_budget_seconds"}}])
    checkpoint = runtime.store.learning_checkpoint(runtime.scope.key, checkpoint_key)
    labels, identities, unresolved_evidence = {}, {}, {}
    selected, selection_manifest = None, {}
    metadata, roles, groups_by_id, seen_ids = {}, {}, {}, set()
    pool_order = []
    stats = {"algorithm": "learned", "regime": "online_teacher_feedback",
        "online_feedback_training": True, "predicate_key": key, "input_revision": runtime.scope.input_revision,
        "group_projection": GROUP_PROJECTION, "quality_basis": "training_group_crossfit",
        "reference_basis": "teacher", "business_accuracy": "not_measured", "fusion": cfg["fusion"],
        "candidate_models": cfg["methods"], "final_holdout_used_for_selection": False,
        "corpus_records": 0, "scope_records": 0, "feature_records": 0, "missing_features": 0,
        "scan_passes": 0, "fit_count": 0, "training_records": 0, "selection_records": 0,
        "final_holdout_records": 0, "scan_seconds": 0., "fit_seconds": 0., "predict_seconds": 0.,
        "sampling_method": "ranked_top128", "exploration_fraction": cfg["exploration_fraction"],
        "global_semantic_recall": "not_established",
        "task_semantics": "recall_candidate_scope" if recall_scope_key else "full_authorized_scope",
        **({"recall_scope_key": recall_scope_key} if recall_scope_key else {})}
    def save():
        if not stats.get("groups_digest"):
            return  # Preserve the previous validated snapshot during early scan/cancel.
        runtime.store.save_learning_checkpoint(runtime.scope.key, checkpoint_key,
            {"protocol": "online-group-resume-v1", "stats": stats.copy(), "labels": labels.copy(),
             "identities": identities.copy(), "unresolved_evidence": unresolved_evidence.copy(),
             "groups_digest": stats.get("groups_digest"), "roles": roles.copy(),
             "selected": selected, "selection_manifest": selection_manifest.copy()})
    async def update(reason, **extra):
        stats.update(stop_reason=reason, teacher_unique_records=len(labels),
            positive_records=sum(v == 1 for v in labels.values()), negative_records=sum(v == 0 for v in labels.values()),
            undetermined_records=sum(v < 0 for v in labels.values()), sample_size=cfg["sample_size"],
            batch_size=batch_size, concurrency=cfg["concurrency"],
            sampling_requests=runtime.store.sampling_calls(runtime.scope), **extra)
        save()  # Labels and validated model snapshots survive stop/cancel/restart.
        await runtime.scope.check()
        await call("learning.update", {**stats, 'sampling_record_limit': 128})
    async def scan(discovery=False):
        cursor, seen, cursors, population = None, set(), set(), None
        started = perf_counter()
        while True:
            await runtime.scope.check()
            page = await call("features.scan", {"cursor": cursor, "page_size": cfg["block_size"], "ranked": discovery})
            if not page.get("feature_id") or (stats.get("feature_id") and stats["feature_id"] != page["feature_id"]):
                raise ValueError("Feature identity changed during online learning")
            stats["feature_id"] = page["feature_id"]
            count = page.get("population_count")
            if count is not None:
                if type(count) is not int or count < 0 or (population is not None and population != count):
                    raise ValueError("Authorized population changed")
                population = count
            block = decode_block(page)
            ids = list(map(int, block.ids))
            if len(ids) > cfg["block_size"] or len(set(ids)) != len(ids) or seen.intersection(ids):
                raise ProtocolError("Online feature scan IDs must be distinct")
            seen.update(ids)
            block.available &= np.isfinite(block.dense).all(axis=1)
            if ids:
                yield block
            cursor = page.get("next_cursor")
            if cursor is None:
                break
            if cursor in cursors:
                raise ProtocolError("Online scan cursor must advance")
            cursors.add(cursor)
        if population is not None and len(seen) != population:
            raise ValueError("Authorized scope count changed")
        if discovery:
            seen_ids.update(seen)
        elif seen != seen_ids:
            raise ValueError("Authorized scope changed before prediction")
        stats["scan_passes"] += 1
        stats["scan_seconds"] += perf_counter()-started
    async def take(ids):
        parts = []
        for start in range(0, len(ids), 1024):
            await runtime.scope.check()
            want = list(map(int, ids[start:start+1024]))
            page = await call("features.take", {"ids": want})
            if page.get("feature_id") != stats["feature_id"]:
                raise ValueError("Feature identity changed during sample read")
            block = decode_block(page)
            if block.ids.tolist() != want:
                raise ProtocolError("Numeric sample IDs changed order or cardinality")
            if block.row_groups is None or any(metadata[i] != item for i, item in zip(want, block.row_groups)):
                raise ValueError("Trusted sample groups changed")
            block.available &= np.isfinite(block.dense).all(axis=1)
            parts.append(block)
        if len(parts) == 1:
            return parts[0]
        return FeatureBlock(np.concatenate([p.ids for p in parts]), np.concatenate([p.dense for p in parts]),
            np.concatenate([p.available for p in parts]),
            vstack([p.sparse for p in parts], format="csr") if parts[0].sparse is not None else None,
            row_groups=tuple(item for p in parts for item in p.row_groups))
    async def read(ids):
        await runtime.scope.check()
        response = await call("rows.read", {"ids": list(map(int, ids))})
        rows = [Record.from_dict(row) for row in response["rows"]]
        if len(rows) != len(ids) or len({row.ref for row in rows}) != len(rows):
            raise ProtocolError("Authorized online rows changed cardinality or identity")
        for ident, row in zip(ids, rows):
            if validate_group_metadata(row.attributes.get("group_hashes", {})) != metadata[int(ident)]:
                raise ValueError("Original-row group identity differs from numeric features")
        return rows
    def evidence_key(row):
        return digest([row.observation_key, require_source, required_fields])
    async def ask(ids):
        width = batch_size*cfg["concurrency"]
        for start in range(0, len(ids), width):
            window = list(map(int, ids[start:start+width]))
            rows = await read(window)
            fresh = []
            for ident, row in zip(window, rows):
                identities[ident] = row.identity
                if unresolved_evidence.get(ident) == evidence_key(row):
                    labels[ident] = -1
                else:
                    fresh.append((ident, row))
            async def one(part):
                decisions = await judge_batch(runtime, [row for _, row in part], instruction,
                    require_source=require_source, required_fields=required_fields, sampling=True)
                return part, decisions
            jobs = [asyncio.create_task(one(fresh[pos:pos+batch_size])) for pos in range(0, len(fresh), batch_size)]
            try:
                completed = await asyncio.gather(*jobs)
            except BaseException:
                for job in jobs:
                    if not job.done(): job.cancel()
                await asyncio.gather(*jobs, return_exceptions=True)
                raise
            for part, decisions in completed:
                for (ident, row), decision in zip(part, decisions):
                    labels[ident] = {"accept": 1, "exclude": 0, "undetermined": -1}[decision.label]
                    if decision.label == "undetermined" and not decision.error:
                        unresolved_evidence[ident] = evidence_key(row)
                    else:
                        unresolved_evidence.pop(ident, None)
                    yield {"type": "decision", "value": asdict(decision)}
            await update("sampling", sampling_phase="ranked_top128")
    try:
        ranked = PrioritySample(cfg["pool_size"])
        await update("scanning")
        async for block in scan(discovery=True):
            group_items = block.row_groups or tuple({} for _ in block.ids)
            metadata.update((int(i), item) for i, item in zip(block.ids, group_items))
            if block.scores is None:
                raise ProtocolError("Ranked sampling requires cosine/ngram scores")
            scores = block.scores
            ranked.add(block.ids, np.where(np.isfinite(scores), scores, -np.inf))
            stats["feature_records"] += int(block.available.sum())
        ids = sorted(seen_ids)
        stats.update(corpus_records=len(ids), scope_records=len(ids), missing_features=len(ids)-stats["feature_records"])
        group_items = [metadata[i] for i in ids]
        all_groups = group_closure(group_items)
        groups_by_id.update(zip(ids, all_groups))
        roles.update({i: "training" for i in ids})
        stats.update(groups_digest=digest([[i, metadata[i], roles[i]] for i in ids]),
            group_verified_records=sum(group is not None for group in all_groups),
            group_unverified_records=sum(group is None for group in all_groups))
        # 完整召回并集按真实相似度/ngram分数抽样，首屏展示种子不再覆盖排序。
        pool_order = list(map(int, ranked.ids))
        if checkpoint and checkpoint.get("protocol") == "online-group-resume-v1" and checkpoint["stats"].get("feature_id") == stats["feature_id"]:
            candidate_labels = {int(i): int(v) for i, v in checkpoint.get("labels", {}).items() if int(i) in seen_ids}
            for start in range(0, len(candidate_labels), 1024):
                part = list(candidate_labels)[start:start+1024]
                rows = await read(part)
                for ident, row in zip(part, rows):
                    if checkpoint.get("identities", {}).get(ident) == row.identity:
                        labels[ident], identities[ident] = candidate_labels[ident], row.identity
                        if ident in checkpoint.get("unresolved_evidence", {}):
                            unresolved_evidence[ident] = checkpoint["unresolved_evidence"][ident]
            if checkpoint.get("groups_digest") == stats["groups_digest"] and checkpoint.get("roles") == roles:
                selected = checkpoint.get("selected")
                selection_manifest.update(checkpoint.get("selection_manifest", {}))
            else:
                stats["snapshot_invalidated"] = "group_membership_or_role_changed"
            await update("resuming_discovery", reused_label_records=len(labels))
        if not ids:
            raise ProtocolError("Empty authorized recall scope")
        # 排序前128工单只标一次；监督目标仅来自教师二分类伪标签。
        target_ids = pool_order[:128]
        window = [i for i in target_ids if labels.get(i, -1) < 0]
        stats["exploration_records"] = 0
        await update("ranked_sampling", sampling_phase="ranked_top128")
        async for event in ask(window):
            yield event
        train_ids = [i for i in target_ids if labels.get(i, -1) >= 0]
        stats.update(training_ids=train_ids, training_records=len(train_ids), selection_ids=[],
            selection_records=0, final_holdout_ids=[], final_holdout_records=0)
        if len(train_ids) != len(target_ids):
            raise ProtocolError("Teacher execution failed for fixed top128; retry failed tickets instead of adding samples")
        if not train_ids:
            raise ProtocolError("No teacher labels in authorized recall scope")
        train = await take(train_ids)
        if not train.available.all():
            raise ProtocolError("Missing training features for fixed teacher labels")
        available_ids = train.ids[train.available]
        y = np.asarray([labels[int(i)] for i in available_ids], dtype=np.int8)
        groups = np.asarray([groups_by_id[int(i)] for i in available_ids], dtype=object)
        views = {name: x[train.available] for name, x in train.views.items()}
        stats.update(training_sampled_records=len(train_ids), training_records=len(y),
            training_ids=available_ids.tolist())
        cohort = digest([groups.tolist(), y.tolist()])
        feature_cohort = digest([stats["feature_id"],
            [(int(i), identities[int(i)]) for i in available_ids], groups.tolist(), y.tolist()])
        await update("training")
        def check():
            if runtime.scope.cancelled.is_set():
                raise asyncio.CancelledError("Task cancelled during online fitting")
        started = perf_counter()
        try:
            if len(set(y)) == 1:
                candidate = ConstantTeacherSelection(int(y[0]))
                point = binary_report(y, np.full(len(y), int(y[0]), dtype=np.int8))
                manifest = {"fit_count": 1, "members": [candidate.name], "member_thresholds": [.5],
                    "selected_ensemble": False, "single_baseline": candidate.name,
                    "selection_reason": "single_class_teacher_constant", "crossfit_folds": 0,
                    "models": [], "candidate_failures": [], "threshold_metrics_oof": point}
            else:
                candidate, manifest = await asyncio.to_thread(select_group_crossfit, views, y, groups,
                    methods=cfg["methods"], fusion=cfg["fusion"], seed=cfg["seed"],
                    precision_target=cfg["precision_target"], recall_target=cfg["recall_target"],
                    budget_seconds=cfg["fit_budget_seconds"], check=check)
            await runtime.scope.check()
            selected, selection_manifest = candidate, manifest
            selection_manifest["feature_cohort"] = feature_cohort
        except ValueError as exc:
            stats.update(fit_seconds=perf_counter()-started,
                candidate_failures=getattr(exc, "failures", [{"name": "group_crossfit", "error": type(exc).__name__}]),
                fit_count=getattr(exc, "fit_count", 0))
            if selected is None or selection_manifest.get("training_cohort") != cohort or selection_manifest.get("feature_cohort") != feature_cohort:
                selected, selection_manifest = None, {}
                raise ProtocolError("No candidate completed teacher-label model fitting") from exc
            stats["selection_reason"] = "validated_same_cohort_snapshot_fallback"
        stats.update(fit_seconds=perf_counter()-started, fit_count=selection_manifest["fit_count"],
            selected_model=selected.name, selected_members=list(selection_manifest["members"]), threshold=selected.threshold,
            selected_ensemble=selection_manifest["selected_ensemble"], single_baseline=selection_manifest["single_baseline"],
            selection_reason=stats.get("selection_reason", selection_manifest["selection_reason"]),
            crossfit_folds=selection_manifest["crossfit_folds"], models=selection_manifest["models"],
            candidate_failures=selection_manifest["candidate_failures"], threshold_metrics_oof=selection_manifest["threshold_metrics_oof"])
        save()
        point = selection_manifest["threshold_metrics_oof"]
        feasible = point["precision"] >= cfg["precision_target"] and point["recall"] >= cfg["recall_target"]
        quality = {"basis": "teacher_single_class" if len(set(y)) == 1 else "training_group_crossfit", "reference_basis": "teacher", "business_accuracy": "not_measured",
            **{name: point[name] for name in ("precision", "recall", "f1", "coverage")},
            "selection_records": point["reference_records"], "threshold_metrics_oof": point}
        if len(set(y)) == 1:
            quality["training_fit_metrics"] = quality.pop("threshold_metrics_oof")
            quality["limitations"] = "Single teacher class cannot teach a decision boundary; constant label baseline"
            stats.update(quality_basis="teacher_single_class", training_fit_metrics=stats.pop("threshold_metrics_oof"))
        stats.update(quality=quality)
        await update("predicting", predicted_records=0)
        model_id = digest([checkpoint_key, cohort, selection_manifest["members"], selection_manifest["member_thresholds"]])
        await call("predictions.begin", {"model_id": model_id, "predicate_key": key, "feature_id": stats["feature_id"],
            "input_revision": runtime.scope.input_revision, "training_records": len(y), "fit_count": stats["fit_count"],
            "model": selected.name, "threshold": selected.threshold, "task_semantics": stats["task_semantics"],
            "group_projection": GROUP_PROJECTION, "selected_members": list(selection_manifest["members"]),
            "crossfit_folds": selection_manifest["crossfit_folds"], "final_holdout_used_for_selection": False,
            **({"recall_scope_key": recall_scope_key} if recall_scope_key else {})})
        counts, scanned = {-1: 0, 0: 0, 1: 0}, 0
        async for block in scan():
            if not block.available.all():
                raise ProtocolError("Missing prediction features in recalled tickets")
            started = perf_counter()
            scores = np.full(len(block.ids), np.nan)
            if block.available.any():
                scores[block.available] = selected.score_views({name: x[block.available] for name, x in block.views.items()})
            if not np.isfinite(scores).all():
                raise ProtocolError("Model prediction returned nonfinite scores")
            predictions = np.full(len(block.ids), -1, dtype=np.int8)
            valid = np.isfinite(scores)
            predictions[valid] = (scores[valid] >= selected.threshold).astype(np.int8)
            for pos, ident in enumerate(block.ids):
                if int(ident) in labels:
                    predictions[pos] = labels[int(ident)]
            for label in counts:
                counts[label] += int(np.count_nonzero(predictions == label))
            stats["predict_seconds"] += perf_counter()-started
            await call("predictions.write", {"model_id": model_id, "offset": scanned, "ids": block.ids.tolist(),
                "labels": predictions.tolist(), "scores": np.where(np.isfinite(scores), scores, 0).tolist()})
            scanned += len(block.ids)
            await update("predicting", predicted_records=scanned)
        await call("predictions.finish", {"model_id": model_id, "passed": True, "quality": quality,
            "scope_count": scanned, "returned": counts[1]})
        await update("quality_passed" if feasible else "quality_fallback", complete_scope_coverage=True,
            complete_feature_coverage=stats["missing_features"] == 0, predicted_records=scanned,
            returned=counts[1], unresolved=counts[-1], next_action="return_confirmed_results")
    except BaseException as exc:
        stats.update(stop_reason="cancelled" if isinstance(exc, asyncio.CancelledError) else "error",
            complete_scope_coverage=False, error=type(exc).__name__)
        save()
        raise
