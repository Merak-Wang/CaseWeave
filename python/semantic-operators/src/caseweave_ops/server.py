"""既有 TS Host 的算子服务；仅使用宿主 stdio 回调、取消和执行逻辑。"""
from __future__ import annotations
import argparse
import asyncio
import json
import sys
import threading
import uuid
from pathlib import Path
from typing import Any
from . import invoke_rows
from .types import Scope, Knowledge, Record, canonical
from .runtime import Runtime, ModelReply, ArtifactStore, Usage, ModelRequestError
from .search import sem_search, Hit, plan_query

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

    async def pages(self, job: str, method: str, scope: Scope, payload: dict):
        cursor = None
        visited = set()
        # 行、检索命中和连接对共用逐页读取；游标回环只在这个传输边界检查。
        while True:
            await scope.check()
            page = await self.exchange(job, method, {**payload, "cursor": cursor})
            yield page
            next_cursor = page.get("next_cursor")
            if next_cursor is None: break
            if next_cursor in visited: raise ValueError("Provider cursor made no progress")
            visited.add(next_cursor)
            cursor = next_cursor

    async def row_source(self, job: str, handle: str, scope: Scope, page_size=128):
        async for page in self.pages(job, "rows.read", scope, {"handle": handle, "page_size": page_size}):
            for row in page["rows"]:
                yield Record.from_dict(row)

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
        runtime.resources = lambda method, payload: bridge.exchange(job, method, payload)
        source = self.row_source(job, value.get("source_handle", "$source"), scope)
        op, params = value["op"], value.get("params", {})
        try:
            if op == "query_plan":
                plan = await plan_query(runtime, value["instruction"], params.get("confirmed_context", ""))
                self.send({"type": "result", "job": job, "value": {"type": "plan", "value": plan}})
            elif op == "sem_search":
                class HostSearch:
                    async def _pages(self, kind, args):
                        async for p in bridge.pages(job, "search."+kind, scope, args):
                            for row in p["hits"]:
                                yield Hit(Record.from_dict(row["record"]), kind, row.get("score"))
                    def semantic(self, vectors, embedding_id, k):
                        return self._pages("vector", {"vectors": vectors, "embedding_id": embedding_id, "k": k})
                    def lexical(self, keywords): return self._pages("keyword", {"keywords": keywords})
                    def semantic_text(self, text, k): return self._pages("vector", {"text": text, "k": k})
                async for hit in sem_search(scope, HostSearch(), params.get("vectors", []), params.get("embedding_id", ""), params.get("keywords", []), params.get("k", 20), expressions=params.get("expressions", [])):
                    self.send({"type": "result", "job": job, "value": {"type": "candidate", "record": hit.record.model_payload(), "channel": hit.channel, "score": hit.score}})
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
            frame = {"type": "error", "job": job, "error": type(exc).__name__, "metrics": self.store.metrics(scope.task_id)}
            if isinstance(exc, ModelRequestError) and exc.retries_handled:
                frame["model_failure"] = {"code": exc.code, "message": exc.message, "retryable": False,
                    "requestRetryable": exc.retryable, "retryAfterMs": exc.retry_after_ms,
                    "status": exc.status,
                    "usage": {"prompt_tokens": exc.usage.prompt_tokens, "completion_tokens": exc.usage.completion_tokens,
                              "cached_prompt_tokens": exc.usage.cached_prompt_tokens}}
                if exc.diagnostic: frame["model_failure"]["diagnostic"] = exc.diagnostic
            self.send(frame)
        finally:
            self.jobs.pop(job, None)

    async def handle(self, value):
        kind = value["type"]
        if kind == "response":
            # 回调响应只结算仍在等待的 Future，迟到或重复响应不会二次写入。
            future = self.pending.get(value["id"])
            if future is not None and not future.done():
                if "error" in value:
                    failure = value["error"]
                    if isinstance(failure, dict):
                        future.set_exception(ModelRequestError(failure.get("code", "MODEL_ERROR"), failure.get("message", "Model request failed"),
                            failure.get("retryable") is True, failure.get("retryAfterMs"), Usage(**failure.get("usage", {})),
                            failure.get("diagnostic"), failure.get("status")))
                    else:
                        future.set_exception(RuntimeError("Host callback failed"))
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
    parser = argparse.ArgumentParser(description="CaseWeave stdio operator service")
    parser.add_argument("--stdio", action="store_true", help="Use the Host NDJSON pipe")
    parser.add_argument("--state", default=".cache/semantic-operators/artifacts.sqlite")
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    store = ArtifactStore(Path(args.state))
    try:
        asyncio.run(Bridge(store).run())
    finally:
        store.close()


if __name__ == "__main__":
    main()
