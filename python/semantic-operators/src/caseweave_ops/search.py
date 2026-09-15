"""实现核心 sem_search，以及原始向量与首次模型规划并行启动的流程。

搜索输出按 upsert 事件处理，同一记录可从多个通道到达；命中只是候选，不是已确认
业务结果。k 表示 ANN/搜索窗口大小，不表示完整语义结果集的数量。
"""
from __future__ import annotations
import asyncio
import heapq
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import AsyncIterable, AsyncIterator, Any, Protocol
import httpx
import numpy as np
from .types import Record, Scope
from .feedback import unit, norm_text, matrix, rocchio, FeedbackSet
from .model import Runtime
from .planner import plan_query
from .filter import batches


@dataclass(frozen=True)
class Hit:
    record: Record
    channel: str
    score: float | None


class SearchBackend(Protocol):
    def semantic(self, vectors: list[list[float]], embedding_id: str, k: int) -> AsyncIterator[Hit]: ...
    def lexical(self, keywords: list[str]) -> AsyncIterator[Hit]: ...


class EmbeddingPort(Protocol):
    identity: str
    async def embed_queries(self, texts: list[str]) -> list[list[float]]: ...


async def _take(scope: Scope, queue: asyncio.Queue):
    # 同时等待队列数据和任务取消，避免无新数据时无法及时响应撤销。
    getter = asyncio.create_task(queue.get())
    cancelled = asyncio.create_task(scope.cancelled.wait())
    try:
        done, _ = await asyncio.wait({getter, cancelled}, return_when=asyncio.FIRST_COMPLETED)
        if cancelled in done and scope.cancelled.is_set():
            raise asyncio.CancelledError("Search cancelled or superseded")
        return await getter
    finally:
        for task in (getter, cancelled):
            if not task.done(): task.cancel()
        await asyncio.gather(getter, cancelled, return_exceptions=True)


async def _pump(stream: AsyncIterable[Any], queue: asyncio.Queue, tag: str) -> None:
    try:
        # 将各通道值、异常和完成信号统一封装后送入共享队列。
        async for value in stream:
            await queue.put((tag, value, None))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await queue.put((tag, None, exc))
    finally:
        # 消费方取消后不再向满队列写完成信号，避免生产任务永久阻塞。
        if not asyncio.current_task().cancelling():
            await queue.put((tag, None, StopAsyncIteration()))


async def sem_search(scope: Scope, backend: SearchBackend, vectors: list[list[float]],
                     embedding_id: str, keywords: list[str], k: int = 20, *, expressions: list[str] | None = None,
                     feedback: FeedbackSet | None = None) -> AsyncIterator[Hit]:
    if type(k) is not int or k < 1:
        raise ValueError("Search window must be positive")
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    # 向量、关键词和语义文本各自形成独立通道，可并行返回候选。
    lanes = []
    if vectors:
        lanes.append(_pump(backend.semantic(vectors, embedding_id, k), queue, "semantic"))
    if vectors and feedback and feedback.samples:
        positive, negative = [], []
        for row, label in feedback.samples.values():
            features = matrix(row, embedding_id, len(vectors[0]))
            if features is not None:
                (positive if label else negative).extend(features)
        if positive or negative:
            # Keep q0, add a separate learned numeric query; never stringify and
            # re-embed a Rocchio vector or train from proxy/withdrawn decisions.
            learned = [rocchio(q, positive, negative).tolist() for q in vectors]
            lanes.append(_pump(backend.semantic(learned, embedding_id, k), queue, "feedback"))
    if keywords:
        lanes.append(_pump(backend.lexical(keywords), queue, "lexical"))
    # 语义改写保序去重，避免相同表达重复扫描后端。
    for text in dict.fromkeys(expressions or []):
        if not isinstance(text, str) or not text.strip(): raise ValueError("Invalid search expression")
        lanes.append(_pump(backend.semantic_text(text, k), queue, "semantic"))
    tasks = [asyncio.create_task(c) for c in lanes]
    # 共享队列复用所有通道；先持续交付可用候选，最后统一报告通道故障。
    running, faults = len(tasks), []
    try:
        while running:
            await scope.check()
            _, value, error = await _take(scope, queue)
            if isinstance(error, StopAsyncIteration):
                running -= 1
            elif error is not None:
                faults.append(error)
            else:
                await scope.check()
                yield value
        if faults:
            raise ExceptionGroup("Search channel failure; already emitted hits remain usable candidates", faults)
    finally:
        for task in tasks:
            if not task.done(): task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def bootstrap(runtime: Runtime, backend: SearchBackend, embedding: EmbeddingPort,
                    query: str, k: int = 20) -> AsyncIterator[dict[str, Any]]:
    """立即启动原始查询向量，同时由首次模型调用生成关键词和语义改写。

    原始向量通道不等待规划或学习；流程没有有限总调用额度。宿主可取消协程或设置
    Scope.cancelled 终止任务，任一通道失败都会显式返回而不是伪装成空结果成功。
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    async def raw_lane():
        # 原始 query 直接向量化，保证快查不受模型规划延迟影响。
        vectors = await embedding.embed_queries([query])
        async for hit in backend.semantic(vectors, embedding.identity, k):
            yield {"type": "candidate", "channel": "raw_vector", "hit": hit}
    async def plan_lane():
        # 规划通道先发布完整计划，再用改写向量和关键词拓展召回。
        plan = await plan_query(runtime, query)
        yield {"type": "plan", "plan": plan}
        expressions = [x for x in plan["retrieval_expressions"] if x != query]
        async def rewritten():
            for start in range(0, len(expressions), 16):
                vectors = await embedding.embed_queries(expressions[start:start + 16])
                async for hit in backend.semantic(vectors, embedding.identity, k):
                    yield hit
        lanes = [backend.lexical(plan["keywords"]), rewritten()]
        q = asyncio.Queue(maxsize=64)
        workers = [asyncio.create_task(_pump(lane, q, str(i))) for i, lane in enumerate(lanes)]
        running = len(workers)
        try:
            while running:
                _, hit, error = await _take(runtime.scope, q)
                if isinstance(error, StopAsyncIteration): running -= 1
                elif error is not None: yield {"type": "error", "lane": "planned", "error": type(error).__name__}
                else: yield {"type": "candidate", "channel": hit.channel, "hit": hit}
        finally:
            for worker in workers:
                if not worker.done(): worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
    # 两条通道同时启动，通过同一队列按实际完成顺序流式汇合。
    tasks = [asyncio.create_task(_pump(raw_lane(), queue, "raw")),
             asyncio.create_task(_pump(plan_lane(), queue, "plan"))]
    running = 2
    try:
        while running:
            await runtime.scope.check()
            tag, value, error = await _take(runtime.scope, queue)
            if isinstance(error, StopAsyncIteration):
                running -= 1
            elif error is not None:
                yield {"type": "error", "lane": tag, "error": type(error).__name__}
            else:
                await runtime.scope.check()
                yield value
    finally:
        for t in tasks:
            if not t.done(): t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class JsonlBackend:
    """真实磁盘流式本地适配器，不替代生产环境的 Milvus。

    每个 JSONL 行遵循 Record Schema 并携带预计算真实向量。线性全量扫描仅用于
    可移植验证和小语料；生产环境通过既有鉴权 Provider 实现 SearchBackend。
    """
    def __init__(self, path: str | Path):
        self.path = Path(path)

    async def records(self) -> AsyncIterator[Record]:
        with self.path.open(encoding="utf-8") as handle:
            while True:
                # 分块文件读取放入工作线程，避免同步磁盘操作长期占用事件循环。
                lines = await asyncio.to_thread(_read_lines, handle, 128)
                if not lines: break
                for line in lines:
                    if line.strip():
                        yield Record.from_dict(json.loads(line))

    async def lexical(self, keywords: list[str]) -> AsyncIterator[Hit]:
        words = [norm_text(w).strip() for w in keywords if w.strip()]
        if not words: return
        async for r in self.records():
            # 各段落独立匹配，禁止跨字段拼接词语制造并不存在的同段关系。
            if any(w in norm_text(p.text) for w in words for p in r.passages):
                # 字面通道只表示命中，不把扫描顺序冒充 BM25 排名。
                yield Hit(r, "keyword", None)

    async def semantic(self, vectors: list[list[float]], embedding_id: str, k: int) -> AsyncIterator[Hit]:
        if not vectors: return
        if type(k) is not int or k < 1: raise ValueError("k must be positive")
        queries = np.vstack([unit(v) for v in vectors])
        # 线性扫描期间只保留 k 个最高分记录，空间复杂度保持 O(k)。
        heap = []
        sequence = 0
        async for rows in batches(self.records(), 128):
            features = [(r, matrix(r, embedding_id, queries.shape[1])) for r in rows]
            features = [(r, a) for r, a in features if a is not None]
            if not features: continue
            offsets = np.r_[0, np.cumsum([len(a) for _, a in features])]
            scores = np.full(offsets[-1], -np.inf)
            vectors = np.vstack([a for _, a in features])
            # Bound the query axis as well as the feature-read page.
            for start in range(0, len(queries), 16):
                scores = np.maximum(scores, (vectors @ queries[start:start+16].T).max(axis=1))
            for index, (r, _) in enumerate(features):
                score = float(scores[offsets[index]:offsets[index+1]].max())
                item = (score, sequence, r)
                sequence += 1
                if len(heap) < k: heapq.heappush(heap, item)
                elif score > heap[0][0]: heapq.heapreplace(heap, item)
        for score, _, r in sorted(heap, key=lambda x: (-x[0], x[1])):
            yield Hit(r, "vector", score)


def _read_lines(handle, n):
    result = []
    for _ in range(n):
        line = handle.readline()
        if not line: break
        result.append(line)
    return result


class ExistingEmbeddingService:
    """对接既有 model-service `/v1/embeddings` 契约的网络适配器。"""
    def __init__(self, url: str, model: str, revision: str, dimensions: int, protocol_version: str,
                 identity: str, *, client: httpx.AsyncClient | None = None):
        self.url, self.model, self.revision = url.rstrip("/"), model, revision
        self.dimensions, self.protocol_version, self.identity = dimensions, protocol_version, identity
        self.client = client or httpx.AsyncClient(timeout=None)
        self.owns_client = client is None

    async def embed_queries(self, texts: list[str]) -> list[list[float]]:
        import uuid
        if not texts: return []
        request_id = str(uuid.uuid4())
        # 请求显式声明协议、模型、维度和完整输入要求，禁止服务端静默降级。
        response = await self.client.post(self.url + "/v1/embeddings", json={
            "protocolVersion": self.protocol_version, "requestId": request_id,
            "model": self.model, "input": texts, "inputType": "query", "normalize": True,
            "dimensions": self.dimensions, "requireCompleteInput": True})
        response.raise_for_status()
        data = response.json()
        # 严格核对响应身份和归一化契约，避免串包或错误模型向量进入索引空间。
        if (data.get("protocolVersion") != self.protocol_version or data.get("requestId") != request_id or
            data.get("model") != self.model or data.get("revision") != self.revision or
            data.get("dimensions") != self.dimensions or data.get("normalization") != "l2" or data.get("inputComplete") is not True):
            raise ValueError("Embedding response identity/completeness mismatch")
        items = data.get("data", [])
        # 数量和索引必须一一对应，不能容忍缺失、重复或重排后的向量行。
        if len(items) != len(texts) or [r.get("index") for r in items] != list(range(len(texts))):
            raise ValueError("Missing, duplicate or reordered embedding rows")
        vectors = [unit(r["embedding"]).tolist() for r in items]
        if any(len(v) != self.dimensions for v in vectors):
            raise ValueError("Wrong embedding dimension")
        return vectors

    async def aclose(self):
        if self.owns_client: await self.client.aclose()
