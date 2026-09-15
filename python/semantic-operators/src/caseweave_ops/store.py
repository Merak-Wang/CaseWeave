"""保存私有执行产物和用量观测，不承担配额或限流职责。

SQLite 仅是可运行的开发适配器，不是第二套生产权威状态；任务、租约和来源准入
仍由 CaseWeave 宿主及 MySQL 负责。
"""
from __future__ import annotations
import json
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from .types import canonical


@dataclass(frozen=True)
class Usage:
    # 输入 token 已包含缓存命中部分，cached_prompt_tokens 只是其中的子集。
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cached_prompt_tokens: int | None = None

    def __post_init__(self) -> None:
        for v in (self.prompt_tokens, self.completion_tokens, self.cached_prompt_tokens):
            if v is not None and (type(v) is not int or v < 0):
                raise ValueError("Usage must be nonnegative integer or unknown")
        if self.prompt_tokens is not None and self.cached_prompt_tokens is not None:
            if self.cached_prompt_tokens > self.prompt_tokens:
                raise ValueError("Cached prompt tokens cannot exceed total prompt tokens")


class ArtifactStore:
    def __init__(self, path: str | Path = ":memory:", clock: Callable[[], float] = time.time):
        self.clock, self.lock = clock, threading.RLock()
        # 新建持久化文件时直接使用仅属主可读写权限，避免短暂暴露执行材料。
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            if not Path(path).exists():
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        # WAL 支持读写并行；调用、缓存、观测和输出分表保存，避免语义混用。
        self.db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS calls(
          id TEXT PRIMARY KEY, task TEXT NOT NULL, scope TEXT NOT NULL, op TEXT NOT NULL,
          started REAL NOT NULL, ended REAL, status TEXT NOT NULL,
          prompt INTEGER, completion INTEGER, cached INTEGER, error TEXT, request_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS calls_task_time ON calls(task,started);
        CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS observations(
          id INTEGER PRIMARY KEY, task TEXT NOT NULL, at REAL NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outputs(
          scope TEXT NOT NULL, op TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
          PRIMARY KEY(scope,op,id));
        ''')
        self.db.commit()

    def begin(self, task: str, scope: str, op: str, request: dict[str, Any]) -> str:
        ident = str(uuid.uuid4())
        # 请求发出前登记 running，后续所有结算都以该唯一调用 ID 为准。
        with self.lock, self.db:
            self.db.execute("INSERT INTO calls(id,task,scope,op,started,status,request_json) VALUES(?,?,?,?,?,'running',?)",
                            (ident, task, scope, op, self.clock(), canonical(request)))
        return ident

    def finish(self, ident: str, status: str, usage: Usage, error: str | None = None) -> None:
        # ended IS NULL 相当于一次性结算门，防止并发路径重复覆盖最终状态。
        with self.lock, self.db:
            result = self.db.execute("UPDATE calls SET ended=?,status=?,prompt=?,completion=?,cached=?,error=? WHERE id=? AND ended IS NULL",
                (self.clock(), status, usage.prompt_tokens, usage.completion_tokens, usage.cached_prompt_tokens, error, ident))
            if result.rowcount != 1:
                raise ValueError("Unknown or already settled call")

    def get_cache(self, key: str) -> Any | None:
        with self.lock:
            row = self.db.execute("SELECT value FROM cache WHERE key=?", (key,)).fetchone()
        return None if row is None else json.loads(row[0])

    def request(self, ident: str) -> dict:
        with self.lock:
            row = self.db.execute("SELECT request_json,op FROM calls WHERE id=?", (ident,)).fetchone()
            return {**json.loads(row[0]), "operation": row[1]}

    def put_cache(self, key: str, value: Any) -> None:
        # 缓存内容采用规范 JSON，保证重启后复用结果与首次结果结构一致。
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO cache VALUES(?,?)", (key, canonical(value)))

    def observe(self, task: str, kind: str, data: Any) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT INTO observations(task,at,kind,data) VALUES(?,?,?,?)",
                            (task, self.clock(), kind, canonical(data)))

    def save(self, scope: str, op: str, ident: str, value: Any) -> None:
        # 输出以作用域、算子和输入身份幂等覆盖，支撑断点恢复而不制造重复结果。
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO outputs VALUES(?,?,?,?)", (scope, op, ident, canonical(value)))

    def exists(self, scope: str, op: str, ident: str) -> bool:
        with self.lock:
            return self.db.execute("SELECT 1 FROM outputs WHERE scope=? AND op=? AND id=?", (scope, op, ident)).fetchone() is not None

    def output(self, scope: str, op: str, ident: str) -> Any | None:
        with self.lock:
            row = self.db.execute("SELECT value FROM outputs WHERE scope=? AND op=? AND id=?", (scope, op, ident)).fetchone()
        return None if row is None else json.loads(row[0])

    def rows(self, scope: str, op: str):
        # 使用数据库游标逐条读取，避免把整批结果一次性装入内存。
        with self.lock:
            cursor = self.db.execute("SELECT value FROM outputs WHERE scope=? AND op=? ORDER BY id", (scope, op))
        for row in cursor:
            yield json.loads(row[0])

    def metrics(self, task: str) -> dict[str, Any]:
        now = self.clock()
        # 在数据库内聚合累计量和滚动 60 秒窗口，计量只描述事实、不触发停机。
        with self.lock:
            r = self.db.execute('''SELECT COUNT(*) AS attempts,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN started>? THEN 1 ELSE 0 END) AS qpm,
              SUM(prompt) AS prompt, SUM(completion) AS completion, SUM(cached) AS cached,
              SUM(CASE WHEN prompt IS NULL OR completion IS NULL THEN 1 ELSE 0 END) AS missing,
              SUM(CASE WHEN ended>? THEN COALESCE(prompt,0)+COALESCE(completion,0) ELSE 0 END) AS tpm,
              SUM(CASE WHEN ended>? AND (prompt IS NULL OR completion IS NULL) THEN 1 ELSE 0 END) AS missing_tpm,
              SUM(CASE WHEN ended IS NOT NULL THEN ended-started ELSE 0 END) AS request_seconds
              FROM calls WHERE task=?''', (now-60, now-60, now-60, task)).fetchone()
            hits = self.db.execute("SELECT COUNT(*) FROM observations WHERE task=? AND kind='cache_hit'", (task,)).fetchone()[0]
        return {"llm_adapter_calls": r["attempts"], "running": r["running"] or 0,
                "failed_attempts": r["errors"] or 0, "cancelled_attempts": r["cancelled"] or 0,
                "cache_hits": hits, "observed_qpm_60s": r["qpm"] or 0,
                "reported_prompt_tokens": r["prompt"] or 0, "reported_completion_tokens": r["completion"] or 0,
                "reported_cached_prompt_subset": r["cached"] or 0,
                "usage_missing_attempts": r["missing"] or 0,
                "reported_tpm_receipts_60s": r["tpm"] or 0,
                "tpm_missing_receipts_60s": r["missing_tpm"] or 0,
                "sum_request_seconds": r["request_seconds"] or 0.0,
                "accounting_complete": (r["missing"] or 0) == 0,
                "count_basis": "one ModelPort.generate invocation; direct HTTP is 1:1, DSH physical retries must be reported by host",
                "semantics": "QPM=attempt starts in (now-60,now]; TPM=reported prompt+completion by receipt time; cache tokens not double-counted; no execution limit"}

    def close(self) -> None:
        self.db.close()
