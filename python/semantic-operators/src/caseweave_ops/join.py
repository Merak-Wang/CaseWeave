"""在流式候选对上执行语义连接；候选阻塞本身不能证明连接召回完整。"""
from __future__ import annotations
from dataclasses import asdict, dataclass
from typing import AsyncIterable, AsyncIterator, Callable
from .filter import CITATION_SCHEMA, batches
from .model import Runtime
from .types import Record, Citation, ProtocolError, digest, verify_citations

JOIN_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["rows"], "properties": {
  "rows": {"type": "array", "items": {"type": "object", "additionalProperties": False,
    "required": ["pair_id", "label", "citations", "reason"], "properties": {
      "pair_id": {"type": "string"}, "label": {"enum": ["accept", "exclude", "undetermined"]},
      "citations": {"type": "array", "items": CITATION_SCHEMA}, "reason": {"type": "string"}}}}}}


@dataclass(frozen=True)
class JoinResult:
    pair_id: str
    left: str
    right: str
    label: str
    citations: tuple[Citation, ...]
    manifest_id: str
    error: str | None = None


async def cartesian_pairs(left: AsyncIterable[Record], right_factory: Callable[[], AsyncIterable[Record]]):
    """精确枚举笛卡尔积；每个左项重开右流，不物化 N×M 对。"""
    async for l in left:
        async for r in right_factory():
            yield l, r


async def indexed_pairs(left, right, keys):
    """Disk inverted index over explicit blocking keys. Empty keys match nothing.

    Blocking only proposes pairs: omitted cross-key pairs must be evaluated in
    recall benchmarks separately from the subsequent semantic judge.
    """
    import json
    import sqlite3
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory(prefix="caseweave-join-") as root:
        db = sqlite3.connect(str(Path(root) / "blocking.sqlite"))
        db.executescript('CREATE TABLE records(ref TEXT PRIMARY KEY, data TEXT); CREATE TABLE blocks(key TEXT, ref TEXT, PRIMARY KEY(key,ref));')
        try:
            async for row in right:
                db.execute('INSERT OR REPLACE INTO records VALUES(?,?)', (row.ref, json.dumps(asdict(row))))
                db.execute('DELETE FROM blocks WHERE ref=?', (row.ref,))
                db.executemany('INSERT INTO blocks VALUES(?,?)', [(key, row.ref) for key in set(keys(row)) if key])
            db.commit()
            async for row in left:
                values = sorted({key for key in keys(row) if key})
                if not values: continue
                query = 'SELECT DISTINCT r.data FROM records r JOIN blocks b USING(ref) WHERE b.key IN (' + ','.join('?' for _ in values) + ')'
                for (data,) in db.execute(query, values):
                    yield row, Record.from_dict(json.loads(data))
        finally:
            db.close()


async def sem_join(runtime: Runtime, pairs: AsyncIterable[tuple[Record, Record]],
                   instruction: str, *, batch_size: int = 8) -> AsyncIterator[JoinResult]:
    async for group in batches(pairs, batch_size):
        await runtime.scope.check()
        indexed = {}
        payload = []
        for left, right in group:
            if left.ref == right.ref and left.identity != right.identity:
                raise ValueError("Two versions share a ref in the same pair")
            # 连接对身份覆盖左右记录版本，同批重复对只提交模型一次。
            ident = digest([left.identity, right.identity])
            if ident in indexed: continue
            indexed[ident] = left, right
            payload.append({"pair_id": ident, "left": left.model_payload(), "right": right.model_payload()})
        result = await runtime.call("sem_join", instruction+" 每个确定判断引用左右两条记录，不将阻塞候选视作完整连接。", {"pairs": payload}, JOIN_SCHEMA)
        # 按 pair_id 保留列表，以便把缺失或重复返回识别为协议错误。
        by_id = {}
        for row in result.payload["rows"]: by_id.setdefault(row["pair_id"], []).append(row)
        for ident, (left, right) in indexed.items():
            values = by_id.get(ident, [])
            label, citations, error = "undetermined", (), None
            try:
                if len(values) != 1: raise ProtocolError("missing_or_duplicate_pair")
                row = values[0]
                # 确定判断必须同时引用左右原文，不能用单边相似性替代关系证据。
                citations = verify_citations(row["citations"], [left, right])
                if row["label"] != "undetermined" and {c.ref for c in citations} != {left.ref, right.ref}:
                    raise ProtocolError("pair_decision_missing_one_side")
                label = row["label"]
            except ProtocolError as exc:
                # 单对输出不合规时维持未决并清空引文，不影响同批其他合法连接。
                error, citations = str(exc), ()
            # 落库和流式发布前再次检查权限与取消状态，阻止陈旧结果外泄。
            await runtime.scope.check()
            output = JoinResult(ident, left.ref, right.ref, label, citations, result.manifest_id, error)
            runtime.store.save(runtime.scope.key, "sem_join:"+runtime.predicate_key(instruction), ident, asdict(output))
            yield output
