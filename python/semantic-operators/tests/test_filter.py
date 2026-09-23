import asyncio
from dataclasses import replace
import pytest
from caseweave_ops import *
from caseweave_ops.runtime import ModelRequestError
from caseweave_ops.types import verify_citations
from caseweave_ops.filter import DECISION_SCHEMA
from conftest import record, source, collect, decisions, ScriptedModel


def test_filter_no_prior_labels(make_runtime):
    rt = make_runtime()
    result = asyncio.run(collect(sem_filter(rt, source([record(str(i)) for i in range(19)]), "当前解绑受阻", batch_size=8, scope_mode="candidates")))
    assert len(result) == 19 and all(d.label == "accept" for d in result)
    assert rt.model.calls == 6


def test_acceptance_requires_independent_missing_criterion_review(make_runtime):
    def handler(p, r):
        if p['review_stage'] == 'criterion_gaps':
            assert len(p['records']) == 1
            assert 'label' not in p['records'][0] and 'reason' not in p['records'][0]
            return decisions(p, r, 'undetermined')
        return decisions(p, r)
    rt = make_runtime(handler)
    out = asyncio.run(judge_batch(rt, [record()], '同时满足对象、原状态和变化'))
    assert out[0].label == 'undetermined' and rt.model.calls == 2


def test_judgment_prompt_contains_only_query_records_knowledge_and_output(make_runtime):
    import json
    seen = []
    def handler(payload, request):
        seen.append(request)
        return decisions(payload, request)
    rt = make_runtime(handler)
    rt.knowledge = Knowledge('wiki-v1', ({'id': 'status', 'title': '解绑状态', 'bodyMarkdown': '未完成不能当作已完成。',
        'provenance': 'internal-publication-metadata', 'reference': 'internal-reference'},))
    asyncio.run(judge_batch(rt, [record()], '查询解绑受阻工单'))
    assert len(seen) == 2
    for request in seen:
        system, user = request['messages']
        assert '查询解绑受阻工单' in system['content']
        knowledge = json.loads(system['content'].split('\n相关Wiki：')[1])
        assert knowledge == {'entries': [{'id': 'status', 'title': '解绑状态', 'bodyMarkdown': '未完成不能当作已完成。'}]}
        payload = json.loads(user['content'])
        assert set(payload) == {'records', 'review_stage', 'output_instructions', 'require_source', 'required_fields'}
        assert len(payload['output_instructions']) < 250
        assert set(('accept', 'exclude', 'undetermined')) <= set(request['schema']['properties']['rows']['items']['properties']['label']['enum'])


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


def test_short_aliases_restore_exact_evidence_and_cache(make_runtime):
    def handler(p, r):
        return {"rows": [{"ref": row["alias"], "label": "accept", "knowledge_ids": [], "reason": "原文匹配",
            "citations": [{"ref": row["alias"], "passage_id": row["passages"][0]["alias"],
                "quote": row["passages"][0]["text"]}]} for row in p["records"]]}
    rt = make_runtime(handler)
    rows = [record("opaque-a"), record("opaque-b")]
    first = asyncio.run(judge_batch(rt, rows, "x"))
    second = asyncio.run(judge_batch(rt, rows, "x"))
    assert [d.ref for d in first] == [r.ref for r in rows]
    assert all(d.label == "accept" and d.citations[0].passage_id == r.passages[0].id for d, r in zip(first, rows))
    assert rt.model.calls == 2 and all(d.basis == "reused_model" for d in second)


def test_short_alias_does_not_repair_wrong_passage(make_runtime):
    row = replace(record("opaque"), passages=(Passage("first", "source.raw_dialogue", "已经恢复"),
        Passage("second", "source.raw_dialogue", "仍然不能使用")))
    rt = make_runtime(lambda p, r: {"rows": [{"ref": "@r1", "label": "accept", "knowledge_ids": [], "reason": "不能使用",
        "citations": [{"ref": "@r1", "passage_id": "@p1", "quote": "仍然不能使用"}]}]})
    result = asyncio.run(judge_batch(rt, [row], "x"))
    assert result[0].label == "undetermined" and result[0].error == "invalid_evidence_reference"


def test_source_judgment_omits_generated_summary(make_runtime):
    row = replace(record('ticket'), passages=(Passage('summary', 'summary', '已经完成解绑', origin='generated'),
        Passage('dialogue', 'source.raw_dialogue', '仍然不能解绑')))
    def handler(p, r):
        assert [v['id'] for v in p['records'][0]['passages']] == ['dialogue']
        return decisions(p, r)
    result = asyncio.run(judge_batch(make_runtime(handler), [row], '查找仍受阻', required_fields=('source.raw_dialogue',)))
    assert result[0].label == 'accept' and result[0].citations[0].passage_id == 'dialogue'


def test_unknown_never_coerced_to_boolean(make_runtime):
    rt = make_runtime(lambda p,r: decisions(p,r,"undetermined"))
    out = asyncio.run(judge_batch(rt, [record()], "x"))
    assert out[0].label == "undetermined"


def test_bad_label_raises_structured_failure(make_runtime):
    rt = make_runtime(lambda p,r: decisions(p,r,"Unknown"))
    with pytest.raises(ModelRequestError) as failure: asyncio.run(judge_batch(rt, [record()], "x"))
    assert failure.value.code == "OUTPUT_SCHEMA"
    assert rt.model.calls == 3
    assert rt.store.metrics("task")["failed_attempts"] == 3


def test_harmless_judgment_note_does_not_fail_a_valid_evidence_decision(make_runtime):
    def handler(payload, request):
        result = decisions(payload, request)
        result['rows'][0]['knowledge_ids_note'] = ''
        return result
    rt = make_runtime(handler)
    result = asyncio.run(judge_batch(rt, [record()], 'x'))
    assert result[0].label == 'accept' and result[0].citations
    assert rt.model.calls == 2
    assert rt.store.metrics('task')['failed_attempts'] == 0


def test_source_policy_is_explicit(make_runtime):
    rt = make_runtime()
    row = record(origin="generated")
    a = asyncio.run(judge_batch(rt, [row], "x"))
    b = asyncio.run(judge_batch(rt, [row], "x", require_source=False))
    assert a[0].label == "undetermined" and b[0].label == "accept"
    assert b[0].citations[0].origin == "generated"


def test_display_id_requirement_does_not_hide_available_identity(make_runtime):
    row = replace(record('ticket'), passages=(Passage('id', 'displayId', 'T-1'),
        Passage('body', 'source.raw_dialogue', '已经完成办理')))
    def handler(p, r):
        return {'rows': [{'ref': 'ticket', 'label': 'accept', 'knowledge_ids': [], 'reason': '编号及业务事实均有据',
            'citations': [{'ref': 'ticket', 'passage_id': q['id'], 'quote': q['text']} for q in p['records'][0]['passages']]}]}
    rt = make_runtime(handler)
    result = asyncio.run(judge_batch(rt, [row], '核实T-1的办理事实', required_fields=('displayId', 'source.raw_dialogue')))
    assert result[0].label == 'accept'
    identity_only = replace(row, passages=(row.passages[0],))
    assert asyncio.run(judge_batch(rt, [identity_only], '核实T-1的办理事实'))[0].label == 'undetermined'


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
    assert rt.model.calls==5 and b[0].basis=="reused_model"
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
    assert rt.model.calls==274
    assert rt.store.metrics("task")["observed_qpm_60s"]==274


def test_token_measurement_does_not_stop_execution(make_runtime):
    rt=make_runtime(lambda p,r: ModelReply(decisions(p,r),Usage(10**9,10**8,10**7)),use_cache=False)
    async def run():
        await judge_batch(rt,[record()],"x")
        await judge_batch(rt,[record()],"x")
    asyncio.run(run())
    m=rt.store.metrics("task")
    assert rt.model.calls==4 and m["reported_tpm_receipts_60s"]==4_400_000_000


def test_metrics_window_cache_subset_and_missing(make_runtime):
    clock=[100.0]
    rt=make_runtime(clock=lambda:clock[0],use_cache=False)
    asyncio.run(judge_batch(rt,[record()],"x"))
    m=rt.store.metrics("task")
    assert m["reported_tpm_receipts_60s"]==240 and m["reported_cached_prompt_subset"]==80
    clock[0]=161
    assert rt.store.metrics("task")["observed_qpm_60s"]==0
    rt.model=ScriptedModel(lambda p,r:ModelReply(decisions(p,r)))
    asyncio.run(judge_batch(rt,[record()],"x"))
    m=rt.store.metrics("task")
    assert m["usage_missing_attempts"]==2 and not m["accounting_complete"]


def test_fault_has_no_hidden_retry(make_runtime):
    def fail(p,r): raise RuntimeError("Host model callback failed")
    rt=make_runtime(fail)
    with pytest.raises(RuntimeError): asyncio.run(judge_batch(rt,[record()],"x"))
    assert rt.model.calls==1 and rt.store.metrics("task")["usage_missing_attempts"]==1


def test_finite_example_goal_not_budget(make_runtime):
    rt=make_runtime()
    out=asyncio.run(collect(sem_filter(rt,source([record(str(i)) for i in range(20)]),"x",batch_size=4,stop_after_accepted=3, scope_mode="candidates")))
    assert len(out)==4 and rt.model.calls==2


def test_duplicate_source_not_rejudged(make_runtime):
    rt=make_runtime()
    out=asyncio.run(collect(sem_filter(rt,source([record(),record(),record()]),"x",batch_size=1, scope_mode="candidates")))
    assert len(out)==1 and rt.model.calls==2


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
    assert m["llm_adapter_calls"]==50 and m["running"]==0
