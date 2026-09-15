"""All model outputs and tiny numeric embeddings in these tests are explicit doubles."""
import asyncio
import json
import pytest
from caseweave_ops import Record, Passage, Scope, Runtime, Knowledge, ArtifactStore, ModelReply, Usage
from caseweave_ops.types import digest


def record(ref="a", text="本次要求客服解绑，系统仍提示失败。", vector=(1.0, 0.0), origin="source"):
    return Record(ref, "v1", digest(text), (Passage("p-"+ref, "source.raw_dialogue", text, 0, origin),), (tuple(vector),), "synthetic-test-space")


class ScriptedModel:
    identity = "explicit-test-double-v1"
    def __init__(self, handler): self.handler, self.calls = handler, 0
    async def generate(self, request):
        self.calls += 1
        payload = json.loads(request["messages"][-1]["content"])
        value = self.handler(payload, request)
        if hasattr(value, "__await__"): value = await value
        return value if isinstance(value, ModelReply) else ModelReply(value, Usage(100, 20, 40))


def decisions(payload, _request=None, label="accept"):
    return {"rows": [{"ref": r["ref"], "label": label,
       "citations": [{"ref": r["ref"], "passage_id": r["passages"][0]["id"], "quote": r["passages"][0]["text"]}],
       "knowledge_ids": [], "reason": "synthetic fixture decision"} for r in payload["records"]]}


@pytest.fixture
def make_runtime(tmp_path):
    opened = []
    def make(handler=decisions, clock=None, **kwargs):
        store = ArtifactStore(":memory:", **({"clock": clock} if clock else {}))
        model = ScriptedModel(handler)
        rt = Runtime(Scope("task", 1, "snapshot", "auth-v1"), model, store, Knowledge("wiki-v1"), **kwargs)
        opened.append(store)
        return rt
    yield make
    for store in opened: store.close()


async def source(rows):
    for r in rows: yield r


async def collect(stream): return [v async for v in stream]
