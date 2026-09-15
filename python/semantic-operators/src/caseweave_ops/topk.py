"""使用异步比较器和“最差项在顶”的堆执行语义 Top-K。

精确选择依赖稳定的全序比较器，而模型比较未必满足传递性；这里的完成只表示
算法已跑完，不代表已经证明全局语义最优。
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import AsyncIterable, Awaitable, Callable
from .filter import CITATION_SCHEMA
from .model import Runtime
from .types import ProtocolError, Record, verify_citations

COMPARE_SCHEMA = {"type": "object", "additionalProperties": False,
  "required": ["winner", "citations"], "properties": {
  "winner": {"enum": ["left", "right", "tie", "undetermined"]},
  "citations": {"type": "array", "items": CITATION_SCHEMA}}}


@dataclass(frozen=True)
class TopKResult:
    records: tuple[Record, ...]
    examined: int
    unresolved_pairs: int
    algorithm_completed: bool
    global_semantic_optimality: str = "not_established"


class UnresolvedComparison(Exception):
    pass


async def model_compare(runtime: Runtime, instruction: str, left: Record, right: Record) -> int | None:
    response = await runtime.call("sem_topk_compare", instruction,
        {"left": left.model_payload(), "right": right.model_payload()}, COMPARE_SCHEMA)
    winner = response.payload["winner"]
    if winner == "undetermined": return None
    # 确定比较必须同时引用左右两条真实记录，单边证据不能决定胜负。
    citations = verify_citations(response.payload["citations"], [left, right])
    if {c.ref for c in citations} != {left.ref, right.ref}:
        raise ProtocolError("Comparison requires the actual two records' references")
    return -1 if winner == "left" else 1 if winner == "right" else 0


async def sem_topk_heap(source: AsyncIterable[Record], k: int,
                   compare: Callable[[Record, Record], Awaitable[int | None]],
                   *, runtime: Runtime | None = None) -> TopKResult:
    if type(k) is not int or k < 1: raise ValueError("k must be positive")
    heap: list[Record] = []
    seen, unresolved = 0, 0
    identities = set()

    async def order(a: Record, b: Record):
        value = await compare(a, b)
        if value is None: raise UnresolvedComparison()
        if value not in (-1, 0, 1): raise ValueError("Comparator must return -1/0/1/None")
        # 模型判为并列时用稳定 ref 打破平局，使相同输入得到确定顺序。
        if value == 0: return -1 if a.ref < b.ref else 1 if a.ref > b.ref else 0
        return value

    async for row in source:
        if runtime: await runtime.scope.check()
        if row.ref in identities: continue
        identities.add(row.ref)
        seen += 1
        # 比较失败时需要整项回滚，因此先保存本轮修改前的堆。
        before = heap[:]
        try:
            if len(heap) < k:
                # 未满 k 时插入并上浮较差项，始终让堆顶成为当前最差候选。
                heap.append(row)
                i = len(heap)-1
                while i > 0:
                    parent = (i-1)//2
                    if await order(heap[i], heap[parent]) <= 0: break
                    heap[parent], heap[i] = heap[i], heap[parent]
                    i = parent
            elif await order(row, heap[0]) < 0:
                # 新记录优于堆顶时替换最差项，再下沉恢复最差项堆结构。
                heap[0] = row
                i = 0
                while 2*i+1 < len(heap):
                    child = 2*i+1
                    if child+1 < len(heap) and await order(heap[child+1], heap[child]) > 0:
                        child += 1
                    if await order(heap[child], heap[i]) <= 0: break
                    heap[i], heap[child] = heap[child], heap[i]
                    i = child
        except UnresolvedComparison:
            # 未决不能被悄悄当成平局；恢复堆并显式累计不确定比较。
            heap = before
            unresolved += 1
            if runtime:
                runtime.store.observe(runtime.scope.task_id, "topk_unresolved", {"ref": row.ref})
    # 只对 k 个幸存项做插入排序，不重排全量语料；主体复杂度为 O(N log k)。
    result: list[Record] = []
    for row in heap:
        pos = 0
        try:
            while pos < len(result) and await order(row, result[pos]) >= 0: pos += 1
        except UnresolvedComparison:
            unresolved += 1
            pos = len(result)
        result.insert(pos, row)
    if runtime: await runtime.scope.check()
    return TopKResult(tuple(result), seen, unresolved, unresolved == 0)


async def sem_topk(source, k, compare, *, runtime=None, strategy="heap", seed=0):
    if strategy == "heap":
        return await sem_topk_heap(source, k, compare, runtime=runtime)
    if strategy != "quick" or type(k) is not int or k < 1:
        raise ValueError("Expected heap/quick and positive k")
    import random
    import tempfile
    from .filter_adapter import FeatureSpool
    rng, unresolved = random.Random(seed), 0
    with tempfile.TemporaryDirectory(prefix="caseweave-topk-") as root:
        spool = FeatureSpool(root)
        try:
            async for row in source:
                if runtime: await runtime.scope.check()
                spool.add(row)
            examined = spool.size
            pending, selected = list(range(examined)), []
            async def order(a, b):
                nonlocal unresolved
                value = await compare(spool.get(a), spool.get(b))
                if value is None:
                    unresolved += 1
                    return 1  # output remains explicitly incomplete
                if value == 0:
                    return -1 if spool.get(a).ref < spool.get(b).ref else 1
                return value
            # Quickselect visits the entire active partition. It never narrows
            # the population using an embedding Top-K.
            while pending and len(selected) < k:
                pivot = rng.choice(pending)
                better, worse = [], []
                for i in pending:
                    if i == pivot: continue
                    (better if await order(i, pivot) < 0 else worse).append(i)
                if len(selected) + len(better) >= k:
                    pending = better
                else:
                    selected.extend([*better, pivot])
                    pending = worse
            ordered = []
            for i in selected:
                pos = 0
                while pos < len(ordered) and await order(i, ordered[pos]) >= 0: pos += 1
                ordered.insert(pos, i)
            return TopKResult(tuple(spool.get(i) for i in ordered), examined, unresolved, unresolved == 0)
        finally:
            spool.close()
