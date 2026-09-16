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


async def merge_sort(items, order):
    """自底向上归并：比较器可异步调用模型，末尾排序只需 O(k log k) 次比较。"""
    result, width = list(items), 1
    while width < len(result):
        merged = []
        for start in range(0, len(result), 2 * width):
            middle, end = min(start + width, len(result)), min(start + 2 * width, len(result))
            left, right = start, middle
            while left < middle and right < end:
                if await order(result[left], result[right]) <= 0:
                    merged.append(result[left]); left += 1
                else:
                    merged.append(result[right]); right += 1
            merged.extend(result[left:middle])
            merged.extend(result[right:end])
        result, width = merged, width * 2
    return result


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
        # 模型判为并列时用稳定 ref 打破平局，使相同输入得到确定顺序。
        if value == 0: return -1 if a.ref < b.ref else 1 if a.ref > b.ref else 0
        return value

    async for row in source:
        if runtime: await runtime.scope.check()
        if row.ref in identities: continue
        identities.add(row.ref)
        seen += 1
        # Find the O(log k) sift path before moving anything. An unresolved
        # comparison leaves the heap untouched; no O(k) copy per input row.
        try:
            if len(heap) < k:
                i = len(heap)
                path = [i]
                while i > 0:
                    parent = (i-1)//2
                    if await order(row, heap[parent]) <= 0: break
                    path.append(parent)
                    i = parent
                heap.append(row)
            elif await order(row, heap[0]) < 0:
                i = 0
                path = [i]
                while 2*i+1 < len(heap):
                    child = 2*i+1
                    if child+1 < len(heap) and await order(heap[child+1], heap[child]) > 0:
                        child += 1
                    if await order(heap[child], row) <= 0: break
                    path.append(child)
                    i = child
            else:
                continue
            for destination, origin in zip(path, path[1:]):
                heap[destination] = heap[origin]
            heap[path[-1]] = row
        except UnresolvedComparison:
            unresolved += 1
            if runtime:
                runtime.store.observe(runtime.scope.task_id, "topk_unresolved", {"ref": row.ref})

    async def final_order(a, b):
        nonlocal unresolved
        try:
            return await order(a, b)
        except UnresolvedComparison:
            unresolved += 1
            return 0
    result = await merge_sort(heap, final_order)
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
        spool = FeatureSpool(root, store_vectors=False)
        try:
            async for row in source:
                if runtime: await runtime.scope.check()
                spool.add(row)
            examined = spool.size
            pending, selected = (list(range(examined)), []) if k < examined else ([], list(range(examined)))
            async def order(a, b):
                nonlocal unresolved
                value = await compare(a, b)
                if value is None:
                    unresolved += 1
                    return 1  # output remains explicitly incomplete
                if value == 0:
                    return -1 if a.ref < b.ref else 1
                return value
            # Quickselect visits the entire active partition. It never narrows
            # the population using an embedding Top-K.
            while pending and len(selected) < k:
                pivot = rng.choice(pending)
                pivot_row = spool.get(pivot)
                better, worse = [], []
                for i in pending:
                    if i == pivot: continue
                    (better if await order(spool.get(i), pivot_row) < 0 else worse).append(i)
                if len(selected) + len(better) >= k:
                    pending = better
                else:
                    selected.extend([*better, pivot])
                    pending = worse
            ordered = await merge_sort([spool.get(i) for i in selected], order)
            return TopKResult(tuple(ordered), examined, unresolved, unresolved == 0)
        finally:
            spool.close()
