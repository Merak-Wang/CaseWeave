"""显式迁移 baseline；默认全集学习不调用本模块。"""
from __future__ import annotations
import asyncio
import json
import math
import sqlite3
import tempfile
from collections import deque
from contextlib import ExitStack
from dataclasses import asdict, dataclass
from pathlib import Path
import numpy as np
from scipy.stats import hypergeom
from sklearn.cluster import MiniBatchKMeans
from sklearn.linear_model import LogisticRegression
from threadpoolctl import threadpool_limits
from .runtime import batches
from .types import Decision, Citation, Record, verify_citations

@dataclass(frozen=True)
class FilterOptions:
    clusters: int = 4
    pilot_size: int = 12
    block_size: int = 2048
    proposal: str = "similarity"
    seed: int = 0
    # Reference-disagreement tolerances, NOT business quality guarantees.
    # Zero by default. Nonzero values require a deployment quality decision.
    accept_error: float = 0.0
    reject_error: float = 0.0
    delta: float = 0.01
    validation_size: int | None = None
    sample_ratio: float = 0.1
    vote_lower: float = 0.1
    vote_upper: float = 0.9

    @property
    def direct(self):
        return self.accept_error == self.reject_error == 0 and self.validation_size is None

    def __post_init__(self):
        if self.proposal not in {"uniform", "similarity", "linear"}:
            raise ValueError("Unknown proposal")
        if min(self.clusters, self.pilot_size, self.block_size) < 1:
            raise ValueError("Sizes must be positive")
        if not (0 <= self.accept_error < 1 and 0 <= self.reject_error < 1 and 0 < self.delta < 1):
            raise ValueError("Invalid disagreement parameters")
        if not (0 < self.sample_ratio <= 1 and 0 <= self.vote_lower < self.vote_upper <= 1):
            raise ValueError("Invalid CSV parameters")
        if self.validation_size is not None and self.validation_size < 1:
            raise ValueError("Validation sample must be positive")


def remaining_error_upper(total, sampled, errors, alpha):
    """Exact one-sided finite-population inversion, minus observed errors."""
    lo, hi = errors, errors + total - sampled
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if hypergeom.logcdf(errors, total, mid, sampled) >= math.log(alpha):
            lo = mid
        else:
            hi = mid - 1
    return lo - errors


def check_size(total, tolerance, alpha):
    """在看标签前求最小零错误样本量。

    整数错误容许数下降时，整体可行性不再单调，不能直接二分。
    先固定容许数，在这一段内二分最早可行点，再重新计算容许数。
    被跳过的样本量即使沿用更宽松的上一段容许数也不可行。
    """
    n, log_alpha = 1, math.log(alpha)
    while n < total:
        contrary = math.floor(tolerance * (total - n)) + 1
        lo, hi = n, total - contrary + 1
        while lo < hi:
            mid = (lo + hi) // 2
            if hypergeom.logcdf(0, total, contrary, mid) < log_alpha:
                hi = mid
            else:
                lo = mid + 1
        if lo == n:
            return n
        n = lo
    return total


def partition(X, ids, count, rng, block_size):
    """按有限特征块拟合；只有小规模 CSV 对照使用全量 KMeans。"""
    if len(ids) < 2 or count == 1:
        return [ids]
    count = min(count, len(ids))
    model = MiniBatchKMeans(n_clusters=count, n_init=3, reassignment_ratio=0,
                            random_state=int(rng.integers(2**31 - 1)), batch_size=max(count, block_size))
    # Random order avoids a first contiguous block setting every centroid.
    order = rng.permutation(ids)
    width = max(count, block_size)
    for start in range(0, len(order), width):
        block = order[start:start + width]
        if len(block) >= count:
            model.partial_fit(X[block])
    assignments = np.empty(len(ids), dtype=np.int32)
    for start in range(0, len(ids), block_size):
        assignments[start:start + block_size] = model.predict(X[ids[start:start + block_size]])
    return [ids[assignments == k] for k in np.unique(assignments)]


def vote(X, train, target, labels, method, block_size):
    """Fit/predict on strong labels, or UniVote / shifted-cosine SimVote.

    Both target AND training axes are blocked: no target x all-feedback matrix.
    Linear training keeps a bounded uniform subset of the existing labels.
    """
    y = labels[train]
    if method == "uniform" or np.unique(y).size == 1:
        return np.full(len(target), y.mean()), False
    if method == "linear":
        model = LogisticRegression(C=1, max_iter=300)
        model.fit(X[train], y)
        output = np.empty(len(target))
        for start in range(0, len(target), block_size):
            output[start:start + block_size] = model.predict_proba(X[target[start:start + block_size]])[:, 1]
        return output, True
    # 单位向量的移位余弦可化为两个充分统计量，不构造候选×标签矩阵。
    A = np.zeros(X[train[:1]].shape[1], dtype=np.float64)
    B = np.zeros_like(A)
    for at in range(0, len(train), block_size):
        part = train[at:at + block_size]
        rows = np.asarray(X[part], dtype=np.float64)
        A += rows.T @ labels[part]
        B += rows.sum(axis=0)
    output = np.empty(len(target))
    for start in range(0, len(target), block_size):
        block = np.asarray(X[target[start:start + block_size]], dtype=np.float64)
        numerator, denominator = block @ A + y.sum(), block @ B + len(train)
        unstable = denominator < 1e-7 * len(train)
        if unstable.any():
            numerator[unstable], denominator[unstable] = 0, 0
            for at in range(0, len(train), block_size):
                part = train[at:at + block_size]
                weights = np.maximum(0, (block[unstable] @ np.asarray(X[part], dtype=np.float64).T + 1) / 2)
                numerator[unstable] += weights @ labels[part]
                denominator[unstable] += weights.sum(axis=1)
        output[start:start + len(block)] = np.divide(numerator, denominator,
            out=np.full(len(block), y.mean()), where=denominator > 1e-12)
    return output, False


async def cluster_filter(X, judge, *, options=None, known=None, method="auto"):
    """Yield (row ids, labels, basis, phase/check).

    judge is an async iterator so every actual model batch can be delivered
    immediately. -2=unasked, -1=Unknown. Every visit consumes unasked rows;
    no depth, calls, tokens or elapsed-time cutoff is needed for termination.
    CaseWeave uses MiniBatchKMeans, local splitting and independent checks.
    """
    cfg = options or FilterOptions()
    labels = np.full(len(X), -2, dtype=np.int8)
    proxy = np.zeros(len(X), dtype=bool)
    for i, y in (known or {}).items():
        labels[i] = y
    rng = np.random.default_rng(cfg.seed)
    tests = 0

    async def ask(ids, phase):
        pending = ids[labels[ids] == -2]
        async for part, values in judge(pending, phase):
            labels[part] = values
            yield part, values, "reference", {"phase": phase}

    pending = np.flatnonzero(labels == -2)
    if not len(pending):
        return
    if method == "auto" and cfg.direct:
        async for event in ask(pending, "strict"):
            yield event
        return

    def split(ids, count):
        with threadpool_limits(limits=1):
            return partition(X, ids, count, rng, cfg.block_size)

    queue = deque(split(np.arange(len(X)), cfg.clusters)) if len(X) else deque()
    while queue:
        for _ in range(len(queue)):
            group = queue.popleft()
            pending = group[labels[group] == -2]
            if not len(pending):
                continue
            size = cfg.pilot_size
            # Reuse same-predicate strong labels before buying new training data.
            train = group[(labels[group] >= 0) & ~proxy[group]]
            count = min(len(pending), max(0, size - len(train)))
            pilot = rng.choice(pending, count, replace=False)
            async for event in ask(pilot, "pilot"):
                yield event
            train = group[(labels[group] >= 0) & ~proxy[group]]
            pending = group[labels[group] == -2]
            if not len(pending):
                continue
            if not len(train):
                async for event in ask(pending, "fallback"):
                    yield event
                continue
            # Memory bound on the linear fit, sampled only from genuine labels.
            if cfg.proposal == "linear" and len(train) > cfg.block_size:
                train = rng.choice(train, cfg.block_size, replace=False)
            with threadpool_limits(limits=1):
                scores, fitted = vote(X, train, pending, labels, cfg.proposal, cfg.block_size)
            yield np.array([], dtype=int), np.array([], dtype=int), "observation", {
                "phase": "prediction", "model_fits": int(fitted), "training": train.tolist(),
                "predicted_count": len(pending), "method": cfg.proposal}
            # Freeze both predicted regions before seeing any calibration labels.
            for value in (0, 1):
                region = pending[(scores >= 0.5) == bool(value)]
                if not len(region):
                    continue
                tests += 1
                alpha = cfg.delta / (tests * (tests + 1))
                tolerance = cfg.accept_error if value else cfg.reject_error
                n = min(len(region), cfg.validation_size or check_size(len(region), tolerance, alpha))
                validation = rng.choice(region, n, replace=False)
                async for event in ask(validation, "calibration"):
                    yield event
                remainder = region[labels[region] == -2]
                errors = int(np.count_nonzero(labels[validation] != value))
                upper = remaining_error_upper(len(region), n, errors, alpha)
                check = {"phase": "check", "population": len(region), "sampled": n,
                         "errors": errors, "remaining": len(remainder), "error_upper": upper,
                         "alpha": alpha, "tolerance": tolerance, "proposed": value,
                         "inferred": bool(len(remainder) and upper <= tolerance * len(remainder))}
                yield np.array([], dtype=int), np.array([], dtype=int), "observation", check
                if check["inferred"]:
                    labels[remainder], proxy[remainder] = value, True
                    yield remainder, labels[remainder], "proxy", check
                elif len(remainder):
                    # Repartition genuine parent labels with the unresolved
                    # rows, so each child keeps its relevant training context.
                    strong = group[(labels[group] >= 0) & ~proxy[group]]
                    children = split(np.concatenate((remainder, strong)), 2)
                    if len(children) == 1:
                        async for event in ask(remainder, "fallback"):
                            yield event
                    else:
                        queue.extend(children)


def restored(value):
    return Decision(**{**value, "citations": tuple(Citation(**c) for c in value["citations"]),
                       "knowledge_ids": tuple(value["knowledge_ids"]),
                       "basis": "reused_model" if value["basis"] == "model" else value["basis"]})


async def clustered_filter(runtime, source, instruction, *, batch_size=8, options=None,
        algorithm="auto", require_source=True, required_fields=(),
        replay_saved=False, stop_after_accepted=None, host_labels=None):
    from .filter import judge_batch
    cfg = options if isinstance(options, FilterOptions) else FilterOptions(**(options or {}))
    runtime.store.observe(runtime.scope.task_id, "filter_configuration", {
        "algorithm": algorithm, "options": asdict(cfg), "batch_size": batch_size,
        "effective_path": "strict" if algorithm == "auto" and (cfg.direct or stop_after_accepted is not None) else algorithm})
    key = runtime.predicate_key(instruction)
    progress = "sem_filter:" + key + (":source" if require_source else ":overview") + ":fields:" + ",".join(sorted(required_fields))
    if stop_after_accepted is not None and (type(stop_after_accepted) is not int or stop_after_accepted < 1):
        raise ValueError("Example target must be positive")
    accepted = set()
    known = {}
    observed = {}
    host_labels = host_labels or {}
    revoked = {ref for ref, label in host_labels.items() if label == -1}

    def publish(row, decision, phase):
        runtime.store.save(runtime.scope.key, progress, row.observation_key, asdict(decision))
        runtime.store.observe(runtime.scope.task_id, "filter_decision", {
            "ref": row.ref, "observation": row.observation_key, "basis": decision.basis,
            "label": decision.label, "phase": phase, "manifest": decision.manifest_id})

    # Strict filtering and small example requests stream directly. Regional
    # fitting is useful only when the caller explicitly selects a checked
    # proxy experiment.
    clustered = algorithm != "auto" or (not cfg.direct and stop_after_accepted is None)
    with ExitStack() as stack:
        spool = FeatureSpool(stack.enter_context(tempfile.TemporaryDirectory(prefix="caseweave-filter-"))) if clustered else None
        seen = {}
        X = None
        try:
            # First batch is immediately useful; clustering waits for neither a
            # new index nor a corpus-wide text list. Text ingestion stays paged.
            first = True
            async for rows in batches(source, batch_size):
                await runtime.scope.check()
                fresh = []
                for row in rows:
                    if spool:
                        idx, changed = spool.add(row)
                    else:
                        previous = seen.get(row.ref)
                        idx, changed = row.ref, previous != row.observation_key
                        seen[row.ref] = row.observation_key
                    if not changed:
                        continue
                    known.pop(idx, None)
                    accepted.discard(row.ref)
                    saved = runtime.store.output(runtime.scope.key, progress, row.observation_key)
                    # 代理结论依赖本次采样配置；重新执行时只复用真实强判断。
                    if saved and saved["basis"] == "proxy":
                        saved = None
                    if row.ref in host_labels and host_labels[row.ref] in (0, 1):
                        # Current host-authorized strong labels take precedence
                        # over an older operator output. The host owns their
                        # receipts and already displays them; do not forge one.
                        known[idx] = host_labels[row.ref]
                        if saved and int(saved['label'] == 'accept') != known[idx]:
                            runtime.store.save(runtime.scope.key, progress, row.observation_key,
                                asdict(Decision(row.ref, row.identity, key, 'undetermined', basis='unresolved', reason='superseded by host strong judgment')))
                        if known[idx] == 1:
                            accepted.add(row.ref)
                        continue
                    if row.ref in revoked:
                        saved = None
                        # Persist the retraction so a later worker cannot revive
                        # the old label even if this run fails before rejudging.
                        runtime.store.save(runtime.scope.key, progress, row.observation_key,
                            asdict(Decision(row.ref, row.identity, key, 'undetermined', basis='unresolved', reason='feedback retracted')))
                    # Unknown is repairable. Proxies are recomputed using current
                    # strong feedback, never replayed as new training labels.
                    if saved and saved["label"] != "undetermined" and saved["basis"] in {"model", "reused_model"}:
                        decision = restored(saved)
                        known[idx] = int(decision.label == "accept")
                        if replay_saved:
                            yield decision
                        if decision.label == "accept":
                            accepted.add(row.ref)
                    elif first or not spool:
                        fresh.append((idx, row))
                if fresh:
                    values = await judge_batch(runtime, [r for _, r in fresh], instruction,
                        require_source=require_source, required_fields=required_fields,
                        use_cache=False if any(r.ref in revoked for _, r in fresh) else None)
                    for (idx, row), decision in zip(fresh, values):
                        known[idx] = {"accept": 1, "exclude": 0, "undetermined": -1}[decision.label]
                        publish(row, decision, "fast" if first else "strict")
                        yield decision
                        if decision.label == "accept":
                            accepted.add(row.ref)
                first = False
                if stop_after_accepted and len(accepted) >= stop_after_accepted:
                    return
                await asyncio.sleep(0)

            if not spool or len(known) == spool.size:
                runtime.store.observe(runtime.scope.task_id, "input_enumerated", {
                    "op": "sem_filter", "algorithm": "strict" if not spool else algorithm,
                    "unique_records": len(seen) if not spool else spool.size})
                return

            async def judge(ids, phase):
                for start in range(0, len(ids), batch_size):
                    part = ids[start:start + batch_size]
                    rows = [spool.get(i) for i in part]
                    values = await judge_batch(runtime, rows, instruction,
                        require_source=require_source, required_fields=required_fields,
                        use_cache=False if any(r.ref in revoked for r in rows) else None)
                    for i, row, decision in zip(part, rows, values):
                        observed[int(i)] = decision
                        publish(row, decision, phase)
                    yield part, np.array([{"accept": 1, "exclude": 0, "undetermined": -1}[v.label] for v in values])

            # Missing vectors or required raw fields cannot borrow other rows'
            # evidence. They follow the same actual-source strong adapter.
            usable = []
            fallback = []
            for idx, valid in spool.db.execute("SELECT id,usable FROM rows ORDER BY id"):
                row = spool.get(idx)
                fields = (*required_fields, *row.attributes.get("required_evidence_fields", []))
                eligible = valid and all(any(p.field == f and p.origin == "source" for p in row.passages) for f in fields)
                eligible &= not require_source or any(p.origin == "source" and p.field != "displayId" for p in row.passages)
                (usable if eligible else fallback).append(idx)
            todo = np.array([i for i in fallback if i not in known], dtype=int)
            async for part, _ in judge(todo, "missing_features_or_source"):
                for i in part:
                    yield observed.pop(int(i))
            if usable:
                X = spool.features()
                # Row index indirection avoids copying the entire memmap.
                class Features:
                    def __len__(self): return len(usable)
                    def __getitem__(self, ids): return X[np.asarray(usable_ids[ids])]
                usable_ids = np.asarray(usable)
                async def local_judge(ids, phase):
                    for start in range(0, len(ids), batch_size):
                        local = ids[start:start + batch_size]
                        async for _, values in judge(usable_ids[local], phase):
                            yield local, values
                prior = {j: known[i] for j, i in enumerate(usable) if i in known}
                async for ids, labels, basis, detail in cluster_filter(Features(), local_judge,
                        options=cfg, known=prior, method=algorithm):
                    if basis == "observation":
                        runtime.store.observe(runtime.scope.task_id, "filter_algorithm", detail)
                        continue
                    for local, value in zip(ids, labels):
                        idx = int(usable_ids[local])
                        if basis == "reference":
                            decision = observed.pop(idx)
                        else:
                            row = spool.get(idx)
                            # These are source locations, not invented model quotes.
                            citations = verify_citations([{"ref": row.ref, "passage_id": p.id, "quote": p.text}
                                for p in row.passages if p.text and (not require_source or p.origin == "source") and p.field != "displayId"], [row])
                            decision = Decision(row.ref, row.identity, key, "accept" if value else "exclude", citations,
                                basis="proxy", reason="聚类选样及独立检验后的代理推断；本条未调用强模型。",
                                inference={"algorithm": "cluster", "proposal": cfg.proposal, **detail})
                            publish(row, decision, "proxy")
                        yield decision
                        if decision.label == "accept":
                            accepted.add(decision.ref)
                    if stop_after_accepted and len(accepted) >= stop_after_accepted:
                        return
            runtime.store.observe(runtime.scope.task_id, "input_enumerated", {
                "op": "sem_filter", "algorithm": algorithm, "unique_records": spool.size,
                "meaning": "supplied candidates processed; Unknown remains unresolved; global recall not established"})
        finally:
            if X is not None:
                X._mmap.close()
            if spool:
                spool.close()


class FeatureSpool:
    """Bounded row ingestion, stable-ref upsert, on-disk text and float32 features."""
    def __init__(self, root, *, store_vectors=True):
        self.db = sqlite3.connect(str(Path(root) / "rows.sqlite"))
        self.db.execute("CREATE TABLE rows(id INTEGER PRIMARY KEY, ref TEXT UNIQUE, observation TEXT, data TEXT, usable INTEGER)")
        self.path = Path(root) / "vectors.f32"
        self.file = self.path.open("w+b")
        self.dimension, self.embedding_id = 0, ""
        self.size = 0
        self.store_vectors = store_vectors

    def add(self, row):
        previous = self.db.execute("SELECT id,observation FROM rows WHERE ref=?", (row.ref,)).fetchone()
        if previous and previous[1] == row.observation_key:
            return previous[0], False
        idx = previous[0] if previous else self.size
        if not previous:
            self.size += 1
        vector = None
        if self.store_vectors and row.vectors:
            a = np.asarray(row.vectors, dtype=np.float32)
            if a.ndim != 2 or not np.isfinite(a).all():
                raise ValueError("Invalid feature block")
            if not self.dimension:
                self.dimension, self.embedding_id = a.shape[1], row.embedding_id
                # Earlier records without vectors retain their zero slots.
                self.file.truncate(self.size * self.dimension * 4)
            if a.shape[1] != self.dimension or row.embedding_id != self.embedding_id:
                raise ValueError("Feature spaces differ")
            norms = np.linalg.norm(a, axis=1)
            if np.all(norms > 1e-12):
                mean = (a / norms[:, None]).mean(axis=0)
                norm = np.linalg.norm(mean)
                if norm > 1e-12:
                    vector = mean / norm
        if self.dimension:
            self.file.seek(idx * self.dimension * 4)
            self.file.write((vector if vector is not None else np.zeros(self.dimension, dtype=np.float32)).astype(np.float32).tobytes())
        payload = asdict(row)
        payload.pop("vectors", None)
        self.db.execute("INSERT OR REPLACE INTO rows VALUES(?,?,?,?,?)",
            (idx, row.ref, row.observation_key, json.dumps(payload, ensure_ascii=False), int(vector is not None)))
        return idx, True

    def get(self, idx):
        return Record.from_dict(json.loads(self.db.execute("SELECT data FROM rows WHERE id=?", (int(idx),)).fetchone()[0]))

    def features(self):
        self.db.commit()
        self.file.flush()
        return np.memmap(self.path, mode="r", dtype=np.float32, shape=(self.size, self.dimension))

    def close(self):
        self.file.close()
        self.db.close()
