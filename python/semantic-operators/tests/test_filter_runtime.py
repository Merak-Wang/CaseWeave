import asyncio
from dataclasses import replace
import pytest
from caseweave_ops import *
from caseweave_ops.types import verify_citations
from caseweave_ops.filter import DECISION_SCHEMA
from conftest import record, source, collect, decisions, ScriptedModel


def test_filter_no_prior_labels(make_runtime):
    rt = make_runtime()
    result = asyncio.run(collect(sem_filter(rt, source([record(str(i)) for i in range(19)]), "当前解绑受阻", batch_size=8)))
    assert len(result) == 19 and all(d.label == "accept" for d in result)
    assert rt.model.calls == 3


def test_missing_and_duplicate_remain_unknown(make_runtime):
    def handler(p, r):
        values = decisions(p, r)["rows"]
        return {"rows": [values[0], values[0]]}
    rt = make_runtime(handler)
    out = asyncio.run(judge_batch(rt, [record("a"), record("b")], "x"))
    assert [d.label for d in out] == ["undetermined", "undetermined"]


def test_wrong_record_citation_rejected(make_runtime):
    def handler(p, r):
        out = decisions(p, r)
        out["rows"][0]["citations"][0]["ref"] = "b"
        return out
    rt = make_runtime(handler)
    out = asyncio.run(judge_batch(rt, [record("a"), record("b")], "x"))
    assert out[0].label == "undetermined" and out[1].label == "accept"


def test_unknown_never_coerced_to_boolean(make_runtime):
    rt = make_runtime(lambda p,r: decisions(p,r,"undetermined"))
    out = asyncio.run(judge_batch(rt, [record()], "x"))
    assert out[0].label == "undetermined"


def test_bad_label_raises_structured_failure(make_runtime):
    rt = make_runtime(lambda p,r: decisions(p,r,"Unknown"))
    with pytest.raises(ProtocolError): asyncio.run(judge_batch(rt, [record()], "x"))
    assert rt.store.metrics("task")["failed_attempts"] == 1


def test_source_policy_is_explicit(make_runtime):
    rt = make_runtime()
    row = record(origin="generated")
    a = asyncio.run(judge_batch(rt, [row], "x"))
    b = asyncio.run(judge_batch(rt, [row], "x", require_source=False))
    assert a[0].label == "undetermined" and b[0].label == "accept"
    assert b[0].citations[0].origin == "generated"


def test_wiki_reference_must_be_supplied(make_runtime):
    def handler(p,r):
        out = decisions(p,r); out["rows"][0]["knowledge_ids"]=["invented"]
        return out
    rt=make_runtime(handler)
    assert asyncio.run(judge_batch(rt,[record()],"x"))[0].label=="undetermined"


def test_utf16_offsets_with_emoji():
    row = replace(record(text="甲😀已经解绑"), passages=(Passage("p", "source.raw_dialogue", "甲😀已经解绑", 20),))
    c = verify_citations([{"ref":"a","passage_id":"p","quote":"已经解绑"}],[row])[0]
    assert (c.start,c.end)==(23,27)


def test_cache_is_operator_and_auth_scoped(make_runtime):
    rt = make_runtime()
    row=record()
    async def run():
        a=await judge_batch(rt,[row],"x")
        b=await judge_batch(rt,[row],"x")
        await rt.call("different_op","x",{"records":[row.model_payload()],"requested_refs":["a"]},DECISION_SCHEMA)
        rt.scope.authorization="auth-v2"
        c=await judge_batch(rt,[row],"x")
        return a,b,c
    a,b,c=asyncio.run(run())
    assert rt.model.calls==3 and b[0].basis=="reused_model"
    assert a[0].manifest_id==b[0].manifest_id!=c[0].manifest_id


def test_cancel_prevents_call_and_stale_result(make_runtime):
    rt=make_runtime()
    rt.scope.cancelled.set()
    with pytest.raises(asyncio.CancelledError): asyncio.run(judge_batch(rt,[record()],"x"))
    assert rt.model.calls==0
    async def test_inflight():
        gate=asyncio.Event()
        async def slow(p,r): gate.set(); await asyncio.sleep(60)
        r=make_runtime(slow)
        task=asyncio.create_task(judge_batch(r,[record()],"x"))
        await gate.wait(); r.scope.cancelled.set()
        with pytest.raises(asyncio.CancelledError): await task
        assert r.store.metrics("task")["cancelled_attempts"]==1
    asyncio.run(test_inflight())


def test_no_task_call_quota(make_runtime):
    rt=make_runtime(use_cache=False)
    async def run():
        for i in range(137): await judge_batch(rt,[record(str(i))],"x")
    asyncio.run(run())
    assert rt.model.calls==137
    assert rt.store.metrics("task")["observed_qpm_60s"]==137


def test_token_measurement_does_not_stop_execution(make_runtime):
    rt=make_runtime(lambda p,r: ModelReply(decisions(p,r),Usage(10**9,10**8,10**7)),use_cache=False)
    async def run():
        await judge_batch(rt,[record()],"x")
        await judge_batch(rt,[record()],"x")
    asyncio.run(run())
    m=rt.store.metrics("task")
    assert rt.model.calls==2 and m["reported_tpm_receipts_60s"]==2_200_000_000


def test_metrics_window_cache_subset_and_missing(make_runtime):
    clock=[100.0]
    rt=make_runtime(clock=lambda:clock[0],use_cache=False)
    asyncio.run(judge_batch(rt,[record()],"x"))
    m=rt.store.metrics("task")
    assert m["reported_tpm_receipts_60s"]==120 and m["reported_cached_prompt_subset"]==40
    clock[0]=161
    assert rt.store.metrics("task")["observed_qpm_60s"]==0
    rt.model=ScriptedModel(lambda p,r:ModelReply(decisions(p,r)))
    asyncio.run(judge_batch(rt,[record()],"x"))
    m=rt.store.metrics("task")
    assert m["usage_missing_attempts"]==1 and not m["accounting_complete"]


def test_fault_has_no_hidden_retry(make_runtime):
    def fail(p,r): raise ProviderError(429,retry_after="30")
    rt=make_runtime(fail)
    with pytest.raises(ProviderError): asyncio.run(judge_batch(rt,[record()],"x"))
    assert rt.model.calls==1 and rt.store.metrics("task")["usage_missing_attempts"]==1


def test_finite_example_goal_not_budget(make_runtime):
    rt=make_runtime()
    out=asyncio.run(collect(sem_filter(rt,source([record(str(i)) for i in range(20)]),"x",batch_size=4,stop_after_accepted=3)))
    assert len(out)==4 and rt.model.calls==1


def test_duplicate_source_not_rejudged(make_runtime):
    rt=make_runtime()
    out=asyncio.run(collect(sem_filter(rt,source([record(),record(),record()]),"x",batch_size=1)))
    assert len(out)==1 and rt.model.calls==1


def test_inflight_revision_change_rejects_result(make_runtime):
    async def run():
        started=asyncio.Event(); release=asyncio.Event()
        async def slow(p,r): started.set(); await release.wait(); return decisions(p,r)
        rt=make_runtime(slow)
        task=asyncio.create_task(judge_batch(rt,[record()],"x"))
        await started.wait(); rt.scope.input_revision=2; release.set()
        with pytest.raises(StaleTask): await task
        assert rt.store.metrics("task")["failed_attempts"]==1
    asyncio.run(run())


def test_concurrent_model_requests_are_counted_without_quota(make_runtime):
    rt=make_runtime(use_cache=False)
    async def run():
        await asyncio.gather(*(judge_batch(rt,[record(str(i))],"x") for i in range(25)))
    asyncio.run(run())
    m=rt.store.metrics("task")
    assert m["llm_adapter_calls"]==25 and m["running"]==0
