"""定义与宿主身份绑定、不可变且可序列化的算子数据结构。

原文位置统一使用 UTF-16 码元以匹配 TypeScript 宿主；模型只返回段落 ID
和原文片段，数值位置由本地代码计算，不能由模型自行声明。
"""
from __future__ import annotations
import asyncio
import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Awaitable, Callable, Literal

Label = Literal["accept", "exclude", "undetermined"]


def canonical(value: Any) -> str:
    # 固定键顺序和分隔符，保证同一业务值在各处生成完全相同的摘要。
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def utf16len(text: str) -> int:
    # Python 按 Unicode 字符计数，这里换算为前端和 TypeScript 使用的 UTF-16 码元数。
    return len(text.encode("utf-16-le")) // 2


class StaleTask(RuntimeError):
    pass


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class Passage:
    id: str
    field: str
    text: str
    start: int = 0
    origin: Literal["source", "generated", "unknown"] = "source"

    def __post_init__(self) -> None:
        if not self.id or not self.field or self.start < 0:
            raise ValueError("Invalid passage identity or UTF-16 start")
        if self.origin not in ("source", "generated", "unknown"):
            raise ValueError("Unknown source origin")


@dataclass(frozen=True)
class Record:
    ref: str
    version: str
    content_hash: str
    passages: tuple[Passage, ...]
    # 向量只参与本地召回和排序，绝不进入模型上下文成为可伪造的“证据”。
    vectors: tuple[tuple[float, ...], ...] = ()
    embedding_id: str = ""
    attributes: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.ref or not self.version or not self.content_hash:
            raise ValueError("Record identity is required")
        if len({p.id for p in self.passages}) != len(self.passages):
            raise ValueError("Duplicate passage ID inside a record")
        if self.vectors and not self.embedding_id:
            raise ValueError("Real vectors require their embedding identity")

    def model_payload(self) -> dict[str, Any]:
        # 只向模型暴露可核验正文及业务属性，主动剔除本地向量特征。
        return {"ref": self.ref, "version": self.version, "content_hash": self.content_hash,
                "passages": [asdict(p) for p in self.passages], "attributes": self.attributes}

    @property
    def identity(self) -> str:
        # 记录身份随版本或内容变化，用于阻止旧判断套用到新版本。
        return digest([self.ref, self.version, self.content_hash])

    @property
    def observation_key(self) -> str:
        # 观察键还覆盖实际送模内容，业务属性或段落变化也会触发重新判断。
        return digest(self.model_payload())

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Record:
        return cls(ref=value["ref"], version=value["version"], content_hash=value["content_hash"],
                   passages=tuple(Passage(**p) for p in value["passages"]),
                   vectors=tuple(tuple(float(v) for v in row) for row in value.get("vectors", [])),
                   embedding_id=value.get("embedding_id", ""), attributes=value.get("attributes", {}))


@dataclass(frozen=True)
class Knowledge:
    release: str
    entries: tuple[dict[str, Any], ...] = ()

    def __post_init__(self) -> None:
        ids = [e.get("id") for e in self.entries]
        if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
            raise ValueError("Wiki entries need unique IDs")

    @property
    def fingerprint(self) -> str:
        return digest(asdict(self))


@dataclass
class Scope:
    task_id: str
    input_revision: int
    snapshot: str
    # 授权版本由可信宿主提供并写入作用域身份，不接受模型输入覆盖。
    authorization: str
    cancelled: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    validate_host: Callable[[], Awaitable[None]] | None = field(default=None, repr=False)

    @property
    def key(self) -> str:
        # 输入修订、数据快照或授权任一变化，都会形成不可混用的新作用域。
        return digest([self.task_id, self.input_revision, self.snapshot, self.authorization])

    async def check(self) -> None:
        # 先检查本地取消，再向宿主复核资格，防止缓存复用或发布越过权限变化。
        if self.cancelled.is_set():
            raise asyncio.CancelledError("Task cancelled or superseded")
        if self.validate_host is not None:
            await self.validate_host()
        # 宿主复核期间任务也可能被替换，因此返回前必须再检查一次。
        if self.cancelled.is_set():
            raise asyncio.CancelledError("Task cancelled or superseded")


@dataclass(frozen=True)
class Citation:
    ref: str
    version: str
    content_hash: str
    passage_id: str
    field: str
    start: int
    end: int
    quote: str
    origin: str


@dataclass(frozen=True)
class Decision:
    ref: str
    record_identity: str
    predicate_key: str
    label: Label
    citations: tuple[Citation, ...] = ()
    knowledge_ids: tuple[str, ...] = ()
    basis: Literal["model", "reused_model", "proxy", "unresolved"] = "model"
    reason: str = ""
    manifest_id: str | None = None
    error: str | None = None
    proxy_attestation: str | None = None
    inference: dict[str, Any] | None = None


@dataclass(frozen=True)
class Scoring:
    priority: float
    proxy_score: float | None
    support: int
    nearest_similarity: float | None
    conflict: float
    scorer_id: str


def verify_citations(raw: Any, records: list[Record]) -> tuple[Citation, ...]:
    if not isinstance(raw, list):
        raise ProtocolError("citations must be an array")
    # 引文只能落在本次实际提供的记录上，不能跨批次借用其他材料。
    by_ref = {r.ref: r for r in records}
    out: list[Citation] = []
    seen: set[tuple[str, str, str]] = set()
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"ref", "passage_id", "quote"}:
            raise ProtocolError("citation needs exactly ref, passage_id, quote")
        ref, pid, quote = item["ref"], item["passage_id"], item["quote"]
        if not all(isinstance(s, str) and s for s in (ref, pid, quote)):
            raise ProtocolError("citation fields must be nonempty strings")
        record = by_ref.get(ref)
        if record is None:
            raise ProtocolError("Cross-record or unsent citation")
        # 段落 ID 和逐字引文必须同时命中，拒绝模型虚构或改写后的“引用”。
        passage = next((p for p in record.passages if p.id == pid), None)
        if passage is None or quote not in passage.text:
            raise ProtocolError("Quote not present in the actual supplied passage")
        key = (ref, pid, quote)
        # 相同引文只保留一次，避免重复引用人为放大证据量。
        if key in seen:
            continue
        seen.add(key)
        # 数值区间从可信原文反算，并保留来源版本与内容哈希形成完整证据身份。
        start = passage.start + utf16len(passage.text[:passage.text.index(quote)])
        out.append(Citation(ref, record.version, record.content_hash, pid, passage.field,
                            start, start + utf16len(quote), quote, passage.origin))
    return tuple(out)
