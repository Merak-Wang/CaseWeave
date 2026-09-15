"""通过跨平台 NDJSON 标准输入输出协议连接既有 TypeScript 宿主。

宿主按需提供已授权数据，并使用自身 DSH 路由执行模型请求。Python 只输出核心
结果和计量，不自行授权租户或发布产品确认结果，也不假设新增 HTTP 路由。

宿主输入：run / response / cancel / shutdown；Python 输出：request / result /
done / error。任务边界来自有限输入和算法进度，而不是调用或 token 预算。
"""
from __future__ import annotations
import asyncio
import json
import sys
import threading
import uuid
from pathlib import Path
from typing import Any
from .types import Scope, Knowledge, Record, canonical
from .model import Runtime, ModelReply
from .store import ArtifactStore, Usage
from .dispatch import invoke_rows
# Load BLAS before starting the blocking stdin reader on Windows. Loading its
# native DLLs for the first time inside a running callback can deadlock.
from .filter_adapter import clustered_filter
from .search import sem_search, Hit
from .planner import plan_query
from .join import sem_join, indexed_pairs
from dataclasses import asdict


class Bridge:
    def __init__(self, store: ArtifactStore):
        self.store = store
        self.pending: dict[str, asyncio.Future] = {}
        self.jobs: dict[str, tuple[Scope, asyncio.Task]] = {}

    def send(self, value: Any):
        # 每条消息独占一行并立即刷新，避免宿主等待缓冲区导致双向死锁。
        sys.stdout.write(canonical(value)+"\n")
        sys.stdout.flush()

    async def exchange(self, job: str, method: str, payload: Any):
        # 为每次宿主回调建立独立 Future，用请求 ID 精确关联异步响应。
        ident = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        self.send({"type": "request", "id": ident, "job": job, "method": method, "payload": payload})
        try:
            return await future
        finally:
            # 成功、失败或取消都移除挂起项，防止长任务累计无效 Future。
            self.pending.pop(ident, None)

    async def row_source(self, job: str, handle: str, scope: Scope, page_size=128):
        cursor = None
        visited = set()
        # 按宿主游标逐页拉取，不把完整来源一次性搬入 Python 内存。
        while True:
            await scope.check()
            page = await self.exchange(job, "rows.read", {"handle": handle, "cursor": cursor, "page_size": page_size})
            for row in page["rows"]:
                yield Record.from_dict(row)
            next_cursor = page.get("next_cursor")
            if next_cursor is None: break
            # 游标必须单调前进；停滞或回环会被视为 Provider 协议错误。
            if next_cursor == cursor or next_cursor in visited: raise ValueError("Provider cursor made no progress")
            visited.add(next_cursor)
            cursor = next_cursor

    async def execute(self, value: dict[str, Any], scope: Scope):
        job = value["job"]
        bridge = self
        # 模型实际执行留在宿主侧，Python 只通过受控回调获取结构化响应和用量。
        class HostModel:
            identity = value["model_identity"]
            async def reuse(self, request, payload):
                await bridge.exchange(job, "llm.reuse", {"request": request, "payload": payload})
            async def generate(self, request):
                response = await bridge.exchange(job, "llm.generate", request)
                return ModelReply(response["payload"], Usage(**response.get("usage", {})), response.get("provider_request_id"))
        # Runtime 将宿主提供的作用域、模型身份和知识版本绑定成同一执行上下文。
        runtime = Runtime(scope, HostModel(), self.store, Knowledge(value["knowledge"]["release"], tuple(value["knowledge"].get("entries", []))))
        source = self.row_source(job, value.get("source_handle", "$source"), scope)
        op, params = value["op"], value.get("params", {})
        try:
            if op == "query_plan":
                plan = await plan_query(runtime, value["instruction"], params.get("confirmed_context", ""))
                self.send({"type": "result", "job": job, "value": {"type": "plan", "value": plan}})
            elif op == "sem_search":
                class HostSearch:
                    async def _pages(self, kind, args):
                        cursor = None
                        visited = set()
                        # 搜索通道同样逐页回调，并拒绝重复游标造成无限循环。
                        while True:
                            await scope.check()
                            p = await bridge.exchange(job, "search."+kind, {**args, "cursor": cursor})
                            for row in p["hits"]:
                                yield Hit(Record.from_dict(row["record"]), kind, row.get("score"))
                            next_cursor = p.get("next_cursor")
                            if next_cursor is None: break
                            if next_cursor == cursor or next_cursor in visited: raise ValueError("Search cursor made no progress")
                            visited.add(next_cursor)
                            cursor = next_cursor
                    def semantic(self, vectors, embedding_id, k):
                        return self._pages("vector", {"vectors": vectors, "embedding_id": embedding_id, "k": k})
                    def lexical(self, keywords): return self._pages("keyword", {"keywords": keywords})
                    def semantic_text(self, text, k): return self._pages("vector", {"text": text, "k": k})
                async for hit in sem_search(scope, HostSearch(), params.get("vectors", []), params.get("embedding_id", ""), params.get("keywords", []), params.get("k", 20), expressions=params.get("expressions", [])):
                    self.send({"type": "result", "job": job, "value": {"type": "candidate", "record": hit.record.model_payload(), "channel": hit.channel, "score": hit.score}})
            elif op == "sem_join":
                async def pairs():
                    cursor = None
                    visited = set()
                    # 连接候选对由宿主分页面提供，Python 不掌握也不扩大全局数据权限。
                    while True:
                        await scope.check()
                        page = await self.exchange(job, "pairs.read", {"handle": value["source_handle"], "cursor": cursor})
                        for pair in page["pairs"]: yield Record.from_dict(pair["left"]), Record.from_dict(pair["right"])
                        next_cursor = page.get("next_cursor")
                        if next_cursor is None: break
                        if next_cursor == cursor or next_cursor in visited: raise ValueError("Pair cursor made no progress")
                        visited.add(next_cursor)
                        cursor = next_cursor
                async def blocked():
                    field = params["blocking_field"]
                    def keys(row): return [p.text.strip().casefold() for p in row.passages if p.field == field and p.text.strip()]
                    right = self.row_source(job, value["source_handle"], scope)
                    async for left, other in indexed_pairs(source, right, keys):
                        if left.ref < other.ref: yield left, other
                stream = blocked() if params.get("blocking_field") else pairs()
                count = 0
                async for item in sem_join(runtime, stream, value["instruction"], batch_size=params.get("batch_size", 8)):
                    count += 1
                    self.send({"type": "result", "job": job, "value": {"type": "join", "value": asdict(item)}})
                self.send({"type": "result", "job": job, "value": {"type": "join_summary", "candidate_pairs": count,
                    "strategy": "indexed_blocking" if params.get("blocking_field") else "provided_pairs", "blocking_recall": "not_established"}})
            else:
                async for event in invoke_rows(op, runtime, source, value["instruction"], params):
                    self.send({"type": "result", "job": job, "value": event})
            # 只有全部算子正常结束且作用域仍有效时才发送 done。
            await scope.check()
            self.send({"type": "done", "job": job, "metrics": self.store.metrics(scope.task_id),
                       "scope": scope.key, "global_semantic_recall": "not_established"})
        except asyncio.CancelledError:
            # 取消使用稳定错误码，宿主可据此区分真实终止和普通执行故障。
            self.send({"type": "error", "job": job, "error": "cancelled_or_superseded"})
        except Exception as exc:
            # 普通故障只返回异常类型和计量，不通过桥接协议泄露内部错误正文。
            self.send({"type": "error", "job": job, "error": type(exc).__name__, "metrics": self.store.metrics(scope.task_id)})
        finally:
            self.jobs.pop(job, None)

    async def handle(self, value):
        kind = value["type"]
        if kind == "response":
            # 回调响应只结算仍在等待的 Future，迟到或重复响应不会二次写入。
            future = self.pending.get(value["id"])
            if future is not None and not future.done():
                if "error" in value: future.set_exception(RuntimeError("Host callback failed"))
                else: future.set_result(value["payload"])
        elif kind == "run":
            job = value["job"]
            if job in self.jobs: raise ValueError("Duplicate active job")
            # run 立即创建后台任务，使主循环仍能继续接收 response 和 cancel。
            scope = Scope(**value["scope"])
            task = asyncio.create_task(self.execute(value, scope))
            self.jobs[job] = scope, task
        elif kind == "cancel":
            item = self.jobs.get(value["job"])
            if item:
                # 同时设置领域取消信号和 asyncio 取消，覆盖协作式检查与阻塞等待。
                item[0].cancelled.set()
                item[1].cancel()
        elif kind == "shutdown": return False
        else: raise ValueError("Unknown frame")
        return True

    async def close(self):
        running = list(self.jobs.values())
        for scope, task in running:
            scope.cancelled.set(); task.cancel()
        await asyncio.gather(*(t for _, t in running), return_exceptions=True)

    async def run(self):
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()
        def read_stdin():
            # 标准输入是阻塞接口，独立线程读取后再安全投递回事件循环。
            for line in sys.stdin:
                try: loop.call_soon_threadsafe(queue.put_nowait, line)
                except RuntimeError: return
            try: loop.call_soon_threadsafe(queue.put_nowait, None)
            except RuntimeError: pass
        threading.Thread(target=read_stdin, daemon=True).start()
        while True:
            line = await queue.get()
            if line is None: break
            try:
                if not await self.handle(json.loads(line)): break
            except Exception as exc:
                self.send({"type": "error", "error": "invalid_frame:"+type(exc).__name__})
        await self.close()


def main():
    # Windows 管道可能继承旧代码页，显式统一 UTF-8 以保证 NDJSON 中文不损坏。
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    import argparse
    parser = argparse.ArgumentParser(description="CaseWeave Python core operator stdio service")
    parser.add_argument("--state", required=True, help="Private SQLite execution-artifact file; not the production task authority")
    args = parser.parse_args()
    store = ArtifactStore(Path(args.state))
    try: asyncio.run(Bridge(store).run())
    finally: store.close()


if __name__ == "__main__": main()
