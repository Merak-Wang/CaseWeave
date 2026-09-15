"""Captured 0.3.0 behaviour: sorting never removes a strong judgment."""
import asyncio
from caseweave_ops.dispatch import invoke_rows
from conftest import record, source, decisions


def test_batch_sorting_judges_the_same_complete_input(make_runtime):
    rows = [record(str(i), vector=(1, i / 24)) for i in range(24)]
    requests = []
    def model(payload, request):
        requests.append(tuple(r['ref'] for r in payload['records']))
        return decisions(payload, request)
    async def run(params):
        rt = make_runtime(model)
        return [v async for v in invoke_rows('sem_filter', rt, source(rows), 'x', {'algorithm': 'reference', **params})]
    plain = asyncio.run(run({}))
    plain_requests = requests[:]
    requests.clear()
    scored = asyncio.run(run({'queries': [[1, 0]], 'embedding_id': 'synthetic-test-space'}))
    assert len(plain) == len(scored) == 24
    assert len(plain_requests) == len(requests) == 3
    assert {r for batch in requests for r in batch} == {r.ref for r in rows}
    assert {frozenset(b) for b in requests} == {frozenset(b) for b in plain_requests}
