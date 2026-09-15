"""Minimal disk/text/result adapter for the numeric filtering kernel."""
import asyncio
import json
import sqlite3
import tempfile
from dataclasses import asdict
from pathlib import Path
import numpy as np
from .cluster import FilterOptions, cluster_filter
from .filter import batches, judge_batch
from .types import Citation, Decision, Record, StaleTask, verify_citations


class FeatureSpool:
    """Bounded row ingestion, stable-ref upsert, on-disk text and float32 features."""
    def __init__(self, root):
        self.db = sqlite3.connect(str(Path(root) / "rows.sqlite"))
        self.db.execute("CREATE TABLE rows(id INTEGER PRIMARY KEY, ref TEXT UNIQUE, observation TEXT, data TEXT, usable INTEGER)")
        self.path = Path(root) / "vectors.f32"
        self.file = self.path.open("w+b")
        self.dimension, self.embedding_id = 0, ""
        self.size = 0

    def add(self, row):
        previous = self.db.execute("SELECT id,observation FROM rows WHERE ref=?", (row.ref,)).fetchone()
        if previous and previous[1] == row.observation_key:
            return previous[0], False
        idx = previous[0] if previous else self.size
        if not previous:
            self.size += 1
        vector = None
        if row.vectors:
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
        self.db.execute("INSERT OR REPLACE INTO rows VALUES(?,?,?,?,?)",
            (idx, row.ref, row.observation_key, json.dumps(asdict(row), ensure_ascii=False), int(vector is not None)))
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


def restored(value):
    return Decision(**{**value, "citations": tuple(Citation(**c) for c in value["citations"]),
                       "knowledge_ids": tuple(value["knowledge_ids"]),
                       "basis": "reused_model" if value["basis"] == "model" else value["basis"]})


async def clustered_filter(runtime, source, instruction, *, batch_size=8, options=None,
        algorithm="cluster", require_source=True, required_fields=(), feedback=None,
        scorer=None, gates=(), replay_saved=False, stop_after_accepted=None, host_labels=None):
    cfg = options if isinstance(options, FilterOptions) else FilterOptions(**(options or {}))
    key = runtime.predicate_key(instruction)
    progress = "sem_filter:" + key + (":source" if require_source else ":overview") + ":fields:" + ",".join(sorted(required_fields))
    if feedback and feedback.predicate_key != key:
        raise ValueError("Feedback predicate does not match the filter")
    if gates:
        raise ValueError("Use the independent regional check, not legacy gates")
    if stop_after_accepted is not None and (type(stop_after_accepted) is not int or stop_after_accepted < 1):
        raise ValueError("Example target must be positive")
    accepted = 0
    known = {}
    observed = {}
    host_labels = host_labels or {}
    revoked = {ref for ref, label in host_labels.items() if label == -1}

    async def publish(row, decision, phase):
        await runtime.scope.check()
        if runtime.predicate_key(instruction) != key:
            raise StaleTask("Filter predicate changed")
        runtime.store.save(runtime.scope.key, progress, row.observation_key, asdict(decision))
        runtime.store.observe(runtime.scope.task_id, "filter_decision", {
            "ref": row.ref, "observation": row.observation_key, "basis": decision.basis,
            "label": decision.label, "phase": phase, "manifest": decision.manifest_id})
        if feedback:
            feedback.observe(row, decision)

    with tempfile.TemporaryDirectory(prefix="caseweave-filter-") as root:
        spool = FeatureSpool(root)
        X = None
        try:
            # First batch is immediately useful; clustering waits for neither a
            # new index nor a corpus-wide text list. Text ingestion stays paged.
            first = True
            async for rows in batches(source, batch_size):
                await runtime.scope.check()
                fresh = []
                for row in rows:
                    idx, changed = spool.add(row)
                    if not changed:
                        continue
                    known.pop(idx, None)
                    saved = runtime.store.output(runtime.scope.key, progress, row.observation_key)
                    if row.ref in host_labels and host_labels[row.ref] in (0, 1):
                        # Current host-authorized strong labels take precedence
                        # over an older operator output. The host owns their
                        # receipts and already displays them; do not forge one.
                        known[idx] = host_labels[row.ref]
                        if saved and int(saved['label'] == 'accept') != known[idx]:
                            runtime.store.save(runtime.scope.key, progress, row.observation_key,
                                asdict(Decision(row.ref, row.identity, key, 'undetermined', basis='unresolved', reason='superseded by host strong judgment')))
                        accepted += known[idx] == 1
                        continue
                    if row.ref in revoked or (feedback and row.ref in feedback.revoked):
                        saved = None
                        # Persist the retraction so a later worker cannot revive
                        # the old label even if this run fails before rejudging.
                        runtime.store.save(runtime.scope.key, progress, row.observation_key,
                            asdict(Decision(row.ref, row.identity, key, 'undetermined', basis='unresolved', reason='feedback retracted')))
                    elif feedback and row.ref in feedback.decisions:
                        prior_row, _ = feedback.samples[row.ref]
                        if prior_row.observation_key == row.observation_key:
                            saved = asdict(feedback.decisions[row.ref])
                            runtime.store.save(runtime.scope.key, progress, row.observation_key, saved)
                    # Unknown is repairable. Proxies are recomputed using current
                    # strong feedback, never replayed as new training labels.
                    if saved and saved["label"] != "undetermined" and saved["basis"] in {"model", "reused_model"}:
                        decision = restored(saved)
                        known[idx] = int(decision.label == "accept")
                        if feedback:
                            feedback.observe(row, decision)
                        if replay_saved:
                            await runtime.scope.check()
                            yield decision
                            accepted += decision.label == "accept"
                    elif first:
                        fresh.append((idx, row))
                if fresh:
                    values = await judge_batch(runtime, [r for _, r in fresh], instruction,
                        require_source=require_source, required_fields=required_fields,
                        use_cache=False if any(r.ref in revoked or (feedback and r.ref in feedback.revoked) for _, r in fresh) else None)
                    for (idx, row), decision in zip(fresh, values):
                        known[idx] = {"accept": 1, "exclude": 0, "undetermined": -1}[decision.label]
                        await publish(row, decision, "fast")
                        yield decision
                        accepted += decision.label == "accept"
                first = False
                if stop_after_accepted and accepted >= stop_after_accepted:
                    return
                await asyncio.sleep(0)

            async def judge(ids, phase):
                for start in range(0, len(ids), batch_size):
                    part = ids[start:start + batch_size]
                    rows = [spool.get(i) for i in part]
                    values = await judge_batch(runtime, rows, instruction,
                        require_source=require_source, required_fields=required_fields,
                        use_cache=False if any(r.ref in revoked or (feedback and r.ref in feedback.revoked) for r in rows) else None)
                    for i, row, decision in zip(part, rows, values):
                        observed[int(i)] = decision
                        await publish(row, decision, phase)
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
                                basis="proxy", reason="聚类选样及独立检验后的代理推断；本条未调用强模型。" if algorithm == "cluster" else "CSV 投票对照推断；未经独立检验。",
                                inference={"algorithm": algorithm, "proposal": cfg.proposal, **detail})
                            await publish(row, decision, "proxy")
                        yield decision
                        accepted += decision.label == "accept"
                    if stop_after_accepted and accepted >= stop_after_accepted:
                        return
            runtime.store.observe(runtime.scope.task_id, "input_enumerated", {
                "op": "sem_filter", "algorithm": algorithm, "unique_records": spool.size,
                "meaning": "supplied candidates processed; Unknown remains unresolved; global recall not established"})
        finally:
            if X is not None:
                X._mmap.close()
            spool.close()
