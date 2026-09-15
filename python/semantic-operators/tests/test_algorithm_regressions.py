import asyncio
import json
from dataclasses import replace
import pytest
from caseweave_ops import sem_topk, bootstrap, Hit, sem_extract, sem_agg
from caseweave_ops.join import indexed_pairs
from conftest import record, source, collect
from test_core_operators import plan, map_payload


def test_keyword_does_not_wait_for_rewrite_embedding(make_runtime):
    async def run():
        gate = asyncio.Event()
        class E:
            identity = 'synthetic-test-space'
            async def embed_queries(self, texts):
                if texts != ['original']: await gate.wait()
                return [[1, 0] for _ in texts]
        class B:
            async def semantic(self, *args): yield Hit(record(), 'vector', 1)
            async def lexical(self, *args): yield Hit(record('keyword'), 'keyword', None)
        stream = bootstrap(make_runtime(lambda p, r: plan()), B(), E(), 'original')
        try:
            while True:
                event = await asyncio.wait_for(anext(stream), 2)
                if event.get('channel') == 'keyword': break
        finally:
            gate.set(); await stream.aclose()
    asyncio.run(run())


@pytest.mark.parametrize('strategy', ['heap', 'quick'])
def test_topk_real_comparator_visits_global_input(strategy):
    calls = []
    async def compare(a, b):
        calls.append((a.ref, b.ref))
        return -1 if int(a.ref) > int(b.ref) else 1
    values = [record(str(i)) for i in range(127)]
    out = asyncio.run(sem_topk(source([*values, *values[-5:]]), 9, compare, strategy=strategy))
    assert [r.ref for r in out.records] == [str(i) for i in range(126, 117, -1)]
    assert out.examined == len(values)
    assert {v for pair in calls for v in pair} == {r.ref for r in values}


def test_indexed_blocking_reports_omissions_separately():
    left = [record('l1', 'a'), record('l2', 'b')]
    right = [record('r1', 'a'), record('r2', 'b'), record('r3', 'c')]
    out = asyncio.run(collect(indexed_pairs(source(left), source(right), lambda r: [r.passages[0].text])))
    pairs = {(a.ref, b.ref) for a, b in out}
    gold = {('l1', 'r1'), ('l2', 'r2'), ('l1', 'r3')}  # includes cross-key match
    assert pairs == {('l1', 'r1'), ('l2', 'r2')}
    assert len(gold & pairs) / len(gold) == 2 / 3  # not a lossless-speedup claim


def test_schema_local_refs_and_schema_specific_reuse(make_runtime):
    schema = {'type': 'object', '$defs': {'state': {'type': 'string'}},
              'properties': {'state': {'$ref': '#/$defs/state'}}, 'required': ['state']}
    rt = make_runtime(map_payload)
    a = asyncio.run(collect(sem_extract(rt, source([record()]), 'state', schema)))
    b = asyncio.run(collect(sem_extract(rt, source([record()]), 'state', schema)))
    assert a == b and rt.model.calls == 1
    other = {**schema, 'description': 'a different schema identity'}
    asyncio.run(collect(sem_extract(rt, source([record()]), 'state', other)))
    assert rt.model.calls == 2
    stored = rt.store.db.execute("SELECT count(*) FROM outputs WHERE op LIKE 'sem_extract:%'").fetchone()[0]
    assert stored == 2


def test_transform_reuses_original_batch_receipt(make_runtime):
    rt = make_runtime(map_payload)
    receipts = []
    async def reuse(request, payload): receipts.append((request, payload))
    rt.model.reuse = reuse
    schema = {'type': 'object', 'properties': {'state': {'type': 'string'}}}
    asyncio.run(collect(sem_extract(rt, source([record('a'), record('b')]), 'state', schema)))
    asyncio.run(collect(sem_extract(rt, source([record('b')]), 'state', schema)))
    assert rt.model.calls == 1 and len(receipts) == 1
    assert receipts[0][0]['operation'] == 'sem_extract'
    assert len(json.loads(receipts[0][0]['messages'][-1]['content'])['records']) == 2


def test_aggregate_parents_do_not_receive_leaf_text(make_runtime):
    payloads = []
    def model(p, r):
        payloads.append(p)
        return {'status': 'ok', 'text': 'condensed', 'source_ids': [s['id'] for s in p['sources']]}
    rows = [record(str(i), 'unique long source ' + str(i) * 400) for i in range(16)]
    rt = make_runtime(model)
    summary = asyncio.run(sem_agg(rt, source(rows), 'summarize', fan_in=4))
    parents = [s for p in payloads for s in p['sources'] if s['origin'] == 'derived_summary']
    assert parents and all('records' not in p and p['text'] == 'condensed' for p in parents)
    assert len(summary.citations) == len(rows) and summary.complete


def test_numeric_feedback_adds_search_lane_and_retraction_removes_it(make_runtime):
    from caseweave_ops import sem_search, sem_filter
    from caseweave_ops.feedback import FeedbackSet
    rt = make_runtime()
    feedback = FeedbackSet(rt.predicate_key('x'))
    labeled = record('labeled', vector=(0, 1))
    asyncio.run(collect(sem_filter(rt, source([labeled]), 'x', feedback=feedback)))
    received = []
    class B:
        async def semantic(self, vectors, embedding_id, k):
            received.append(vectors)
            yield Hit(record(str(len(received))), 'vector', 1)
    asyncio.run(collect(sem_search(rt.scope, B(), [[1, 0]], labeled.embedding_id, [], feedback=feedback)))
    assert len(received) == 2 and [[1, 0]] in received
    assert any(v[0][1] > 0 for v in received)
    feedback.revoke(labeled.ref)
    received.clear()
    asyncio.run(collect(sem_search(rt.scope, B(), [[1, 0]], labeled.embedding_id, [], feedback=feedback)))
    assert received == [[[1, 0]]]
