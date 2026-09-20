import asyncio
import base64
import json
from dataclasses import replace
import numpy as np
import pytest
from caseweave_ops import *
from conftest import record, source, collect

def map_payload(p,r):
    return {"rows":[{"ref":x["ref"],"status":"ok","data":{"state":"受阻"},
        "citations":[{"ref":x["ref"],"passage_id":x["passages"][0]["id"],"quote":x["passages"][0]["text"]}],
        "field_citations":{"state":[{"ref":x["ref"],"passage_id":x["passages"][0]["id"],"quote":x["passages"][0]["text"]}]}}
        for x in p["records"]]}

SCHEMA={"type":"object","properties":{"state":{"type":"string"}},"required":["state"],"additionalProperties":False}


@pytest.mark.parametrize("op",[sem_extract])
def test_transform_schema_and_citations(op,make_runtime):
    rt=make_runtime(map_payload)
    out=asyncio.run(collect(op(rt,source([record()]),"提取状态",SCHEMA)))
    assert out[0].status=="ok" and out[0].data["state"]=="受阻"


def test_extract_requires_field_evidence(make_runtime):
    def f(p,r):
        out=map_payload(p,r);out["rows"][0]["field_citations"]={}
        return out
    rt=make_runtime(f)
    out=asyncio.run(collect(sem_extract(rt,source([record()]),"提取状态",SCHEMA)))
    assert out[0].status=="undetermined" and out[0].data is None


@pytest.mark.parametrize("n,fan",[(0,3),(1,3),(2,3),(3,3),(4,3),(9,3),(17,4)])
def test_aggregate_streams_all_records_and_keeps_leaf_lineage(n,fan,make_runtime):
    def f(p,r):return {"status":"ok","text":"fixture summary","source_ids":[s["id"] for s in p["sources"]]}
    rt=make_runtime(f)
    out=asyncio.run(sem_agg(rt,source([record(str(i)) for i in range(n)]),"归纳",fan_in=fan))
    assert out.leaves==n and out.complete
    assert {c.ref for c in out.citations}=={str(i) for i in range(n)}
    if n==0: assert rt.model.calls==0


def test_enriched_source_can_be_reprocessed(make_runtime):
    rt=make_runtime()
    row=record()
    more=replace(row,passages=row.passages+(Passage("later","source.raw_dialogue","后续更正",100),))
    out=asyncio.run(collect(sem_filter(rt,source([row,more]),"x",batch_size=1, scope_mode="candidates")))
    assert len(out)==2 and rt.model.calls==4


def test_source_fields_parse_without_model_and_missing_fact_stays_unknown(make_runtime):
    def forbidden(*args): raise AssertionError('Field read must not call a model')
    rt = make_runtime(forbidden)
    schema = {'type': 'object', 'properties': {'amount': {'type': 'number'}}, 'required': ['amount']}
    rows = [replace(record(str(i)), passages=(Passage('amount', 'amount', v, origin=origin),))
            for i, (v, origin) in enumerate([('12.5', 'source'), ('12.5', 'generated'), ('unknown', 'source'), ('NaN', 'source')])]
    results = asyncio.run(collect(sem_extract(rt, source(rows), 'read amount', schema, field_map={'amount': 'amount'})))
    assert [r.status for r in results] == ['ok', 'undetermined', 'undetermined', 'undetermined']
    assert results[0].data == {'amount': 12.5} and results[0].basis == 'field'
    assert rt.model.calls == 0


def writer(payload, _):
    return {'status': 'ok', 'text': 'explicit test summary', 'source_ids': [s['id'] for s in payload['sources']]}


def test_code_statistics_do_not_claim_missing_facts_are_zero(make_runtime):
    rt = make_runtime(writer)
    rows = [replace(record(str(i)), passages=(Passage('amount', 'amount', value, origin='source'),))
            for i, value in enumerate(['2', '3', 'unknown'])]
    result = asyncio.run(sem_agg(rt, source(rows), 'statistics', numeric_fields=['amount'], fan_in=2))
    field = result.statistics['fields']['amount']
    assert field == {'present': 2, 'missing': 1, 'observed_sum': 5., 'exact': False, 'sum': None, 'mean': None}
    assert len(result.citations) == 3 and result.statistics['coverage'] == 'supplied_records_only'
    assert result.parent_ids


def test_evidence_window_changes_only_answer_evidence_not_membership(make_runtime):
    rows = [record(str(i)) for i in range(8)]
    X = np.eye(4, dtype='<f4')[np.arange(8)//2]
    results = []
    for k in (2, 4):
        rt = make_runtime(writer)
        async def resource(method, p):
            assert method == 'evidence.features'  # No predictions.write or membership mutation.
            assert p['refs'] == [r.ref for r in rows]
            return {'ids': list(range(8)), 'refs': p['refs'], 'dense': base64.b64encode(X.tobytes()).decode(),
                    'dimensions': 4, 'available': base64.b64encode(bytes([1]*8)).decode()}
        rt.resources = resource
        result = asyncio.run(sem_agg(rt, source(rows), 'typical cases', evidence_window=k, population_count=5000))
        results.append(result)
        assert len(result.citations) == k and result.statistics['population_count'] == 5000
        assert result.statistics['coverage'] == 'selected_evidence_only'
        assert len({int(c.ref)//2 for c in result.citations}) == k
    assert results[0].leaves == 2 and results[1].leaves == 4


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
