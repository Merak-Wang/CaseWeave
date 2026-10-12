"""紧凑二分类的来源、缓存、取消和计量边界；全部使用合成模型。"""
import asyncio,json
from dataclasses import replace
import pytest
from caseweave_ops import Knowledge,ModelReply,Usage,Passage,StaleTask
from caseweave_ops.filter import judge_batch,COMPACT_DECISION_SCHEMA
from caseweave_ops.runtime import ModelRequestError
from caseweave_ops.types import verify_citations
from conftest import record,decisions,ScriptedModel


def test_single_binary_call_without_independent_second_review(make_runtime):
    rt=make_runtime()
    out=asyncio.run(judge_batch(rt,[record(str(i)) for i in range(19)],'当前解绑受阻'))
    assert len(out)==19 and all(d.label=='accept' and d.confidence==1 for d in out)
    assert rt.model.calls==1


def test_prompt_contains_query_business_knowledge_and_compact_output(make_runtime):
    seen=[]
    def handler(p,r): seen.append((p,r)); return decisions(p,r)
    rt=make_runtime(handler)
    rt.knowledge=Knowledge('wiki-v1',({'id':'status','title':'解绑状态','bodyMarkdown':'未完成不能当作已完成。','provenance':'private','reference':'private'},))
    asyncio.run(judge_batch(rt,[record()],'查询解绑受阻工单'))
    assert len(seen)==1
    p,r=seen[0]; system=r['messages'][0]['content']
    assert '查询解绑受阻工单' in system and 'yes（相关）或no（不相关）' in system
    assert 'undetermined' not in system
    assert json.loads(system.split('\n相关Wiki：')[1])=={'entries':[{'id':'status','title':'解绑状态','bodyMarkdown':'未完成不能当作已完成。'}]}
    assert set(p)=={'records','decision_format','output_instructions','require_source','required_fields'}
    schema=r['schema']['properties']['rows']['items']
    assert schema['required']==['ref','label','confidence'] and schema['additionalProperties'] is False
    assert schema['properties']['label']['enum']==['yes','no']
    assert schema['properties']['confidence']=={'type':'number','minimum':0,'maximum':1}
    assert 'review_stage' not in p and 'citations' not in schema['properties']


def test_missing_duplicate_and_foreign_refs_are_technical_unknowns(make_runtime):
    rt=make_runtime(lambda p,r:{'rows':[{'ref':'@r1','label':'yes','confidence':.8}]*2})
    out=asyncio.run(judge_batch(rt,[record('a'),record('b')],'x'))
    assert [d.label for d in out]==['undetermined','undetermined']
    assert all(d.error=='missing_or_duplicate_output' for d in out)
    rt=make_runtime(lambda p,r:{'rows':[{'ref':'foreign','label':'no','confidence':.8}]})
    assert asyncio.run(judge_batch(rt,[record()],'x'))[0].label=='undetermined'


def test_short_alias_restores_exact_identity_evidence_and_cache(make_runtime):
    rt=make_runtime(lambda p,r:{'rows':[{'ref':v['ref'],'label':'yes','confidence':.83} for v in reversed(p['records'])]})
    rows=[record('opaque-a'),record('opaque-b')]
    first=asyncio.run(judge_batch(rt,rows,'x')); second=asyncio.run(judge_batch(rt,rows,'x'))
    assert [d.ref for d in first]==[r.ref for r in rows]
    assert all(d.label=='accept' and d.citations[0].passage_id==r.passages[0].id for d,r in zip(first,rows))
    assert all(d.confidence==.83 for d in first+second)
    assert rt.model.calls==1 and all(d.basis=='reused_model' for d in second)


def test_source_judgment_omits_generated_summary_and_keeps_required_identity(make_runtime):
    row=replace(record('ticket'),passages=(Passage('summary','summary','已经完成解绑',origin='generated'),Passage('id','displayId','T-1'),Passage('dialogue','source.raw_dialogue','仍然不能解绑')))
    def handler(p,r):
        assert [v['id'] for v in p['records'][0]['passages']]==['id','dialogue']
        return decisions(p,r)
    out=asyncio.run(judge_batch(make_runtime(handler),[row],'查找仍受阻',required_fields=('source.raw_dialogue',)))
    assert out[0].label=='accept' and out[0].citations[0].passage_id=='dialogue'
    rt=make_runtime(); only=replace(row,passages=(row.passages[1],))
    assert asyncio.run(judge_batch(rt,[only],'x'))[0].label=='undetermined' and rt.model.calls==0


@pytest.mark.parametrize('bad', [{'ref':'@r1','label':'Unknown','confidence':.5},{'ref':'@r1','label':'yes','confidence':1.01},{'ref':'@r1','label':'yes','confidence':.8,'citations':[]}])
def test_invalid_output_is_structured_failure_not_business_negative(make_runtime,bad):
    rt=make_runtime(lambda p,r:{'rows':[bad]})
    with pytest.raises(ModelRequestError) as failure: asyncio.run(judge_batch(rt,[record()],'x'))
    assert failure.value.code=='OUTPUT_SCHEMA' and rt.model.calls==3
    assert rt.store.metrics('task')['failed_attempts']==3


def test_source_policy_and_negative_binary_are_explicit(make_runtime):
    rt=make_runtime(lambda p,r:decisions(p,r,'exclude')); row=record(origin='generated')
    a=asyncio.run(judge_batch(rt,[row],'x')); b=asyncio.run(judge_batch(rt,[row],'x',require_source=False))
    assert a[0].label=='undetermined' and b[0].label=='exclude' and b[0].confidence==1
    assert b[0].citations[0].origin=='generated' and rt.model.calls==1


def test_utf16_offsets_with_emoji():
    row=replace(record(text='甲😀已经解绑'),passages=(Passage('p','source.raw_dialogue','甲😀已经解绑',20),))
    c=verify_citations([{'ref':'a','passage_id':'p','quote':'已经解绑'}],[row])[0]
    assert (c.start,c.end)==(23,27)


def test_cache_is_operator_and_authorization_scoped(make_runtime):
    rt=make_runtime(); row=record()
    async def run():
        a=await judge_batch(rt,[row],'x'); b=await judge_batch(rt,[row],'x')
        await rt.call('different_op','x',{'records':[{'ref':row.ref}],'decision_format':'compact_binary'},COMPACT_DECISION_SCHEMA)
        rt.scope.authorization='auth-v2'; c=await judge_batch(rt,[row],'x'); return a,b,c
    a,b,c=asyncio.run(run())
    assert rt.model.calls==3 and b[0].basis=='reused_model'
    assert a[0].manifest_id==b[0].manifest_id!=c[0].manifest_id


def test_cancel_before_and_during_call(make_runtime):
    rt=make_runtime(); rt.scope.cancelled.set()
    with pytest.raises(asyncio.CancelledError): asyncio.run(judge_batch(rt,[record()],'x'))
    assert rt.model.calls==0
    async def run():
        gate=asyncio.Event()
        async def slow(p,r): gate.set(); await asyncio.sleep(60)
        rt=make_runtime(slow); task=asyncio.create_task(judge_batch(rt,[record()],'x'))
        await gate.wait(); rt.scope.cancelled.set()
        with pytest.raises(asyncio.CancelledError): await task
        assert rt.store.metrics('task')['cancelled_attempts']==1
    asyncio.run(run())


def test_token_measurement_and_arbitrary_direct_calls_do_not_stop_execution(make_runtime):
    rt=make_runtime(lambda p,r:ModelReply(decisions(p,r),Usage(10**9,10**8,10**7)),use_cache=False)
    async def run():
        await judge_batch(rt,[record()],'x'); await judge_batch(rt,[record()],'x')
    asyncio.run(run()); assert rt.model.calls==2 and rt.store.metrics('task')['reported_tpm_receipts_60s']==2_200_000_000


def test_metrics_window_cache_subset_and_missing(make_runtime):
    clock=[100.]; rt=make_runtime(clock=lambda:clock[0],use_cache=False)
    asyncio.run(judge_batch(rt,[record()],'x')); m=rt.store.metrics('task')
    assert m['reported_tpm_receipts_60s']==120 and m['reported_cached_prompt_subset']==40
    clock[0]=161; assert rt.store.metrics('task')['observed_qpm_60s']==0
    rt.model=ScriptedModel(lambda p,r:ModelReply(decisions(p,r)))
    asyncio.run(judge_batch(rt,[record()],'x')); m=rt.store.metrics('task')
    assert m['usage_missing_attempts']==1 and not m['accounting_complete']


def test_host_fault_has_no_hidden_retry(make_runtime):
    def fail(p,r): raise RuntimeError('Host model callback failed')
    rt=make_runtime(fail)
    with pytest.raises(RuntimeError): asyncio.run(judge_batch(rt,[record()],'x'))
    assert rt.model.calls==1 and rt.store.metrics('task')['usage_missing_attempts']==1


def test_inflight_revision_change_rejects_result(make_runtime):
    async def run():
        started=asyncio.Event(); release=asyncio.Event()
        async def slow(p,r): started.set(); await release.wait(); return decisions(p,r)
        rt=make_runtime(slow); task=asyncio.create_task(judge_batch(rt,[record()],'x'))
        await started.wait(); rt.scope.input_revision=2; release.set()
        with pytest.raises(StaleTask): await task
        assert rt.store.metrics('task')['failed_attempts']==1
    asyncio.run(run())


def test_concurrent_requests_count_without_quota(make_runtime):
    rt=make_runtime(use_cache=False)
    async def run(): await asyncio.gather(*(judge_batch(rt,[record(str(i))],'x') for i in range(25)))
    asyncio.run(run()); m=rt.store.metrics('task')
    assert m['llm_adapter_calls']==25 and m['running']==0
