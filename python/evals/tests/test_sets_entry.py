import asyncio
import json
import httpx
from caseweave_sets.product_client import run_product
from caseweave_sets.efficiency import efficiency
from caseweave_sets.real400_scoring import score_query


def test_public_entry_paginates_confirmed_set_and_records_only_product_usage():
    commands=[];polls=0
    def handler(request):
        nonlocal polls
        path=request.url.path
        if request.method=='POST':
            commands.append(json.loads(request.content));return httpx.Response(200,json={'taskId':'actual-task'})
        if path.endswith('/actual-task'):
            polls+=1
            if polls==1:return httpx.Response(409,json={'code':'INVALID_TRANSITION','message':'state changed','retryable':True})
            return httpx.Response(200,json={'node':{'collectionWindow':{},'result':{'resultRevision':'r1','stoppingReason':'top_k_accepted'}},
                'orchestration':{'counts':{'candidates':101,'confirmed':101},'usage':{'modelRequests':7,'inputTokens':200,'outputTokens':40,'operatorUsage':None}}})
        if path.endswith('/candidates'):
            offset=100 if request.url.params.get('cursor') else 0
            return httpx.Response(200,json={'items':[{'ref':f'c{i}','displayId':f'T-{i}'} for i in range(offset,min(offset+100,101))],
                'judgments':[],'nextCursor':'last' if offset==0 else None})
        if path.endswith('/report'):return httpx.Response(200,json={'confirmedCount':101})
        if path.endswith('/activity'):return httpx.Response(200,json={'items':[],'more':False,'after':0})
        raise AssertionError(path)
    async def run():
        async with httpx.AsyncClient(base_url='http://product',transport=httpx.MockTransport(handler)) as client:
            return await run_product('public query only','http://product',client=client,poll_seconds=0)
    observed=asyncio.run(run())
    assert observed['error'] is None and observed['turns'][0]['outcome']=='completed'
    assert observed['turns'][0]['ids']==[f'T-{i}' for i in range(101)]
    assert observed['product_usage']['modelRequests']==7 and observed['learning'] is None
    assert len(observed['read_retries'])==1 and observed['latency']['first_confirmed_seconds'] is not None
    assert len(commands)==1 and commands[0]['text']=='public query only'
    assert set(commands[0])=={'kind','text','operationId'}


def test_quality_separates_unknown_source_from_known_negatives():
    ref={'query_id':'q','title':'q','relevant_ids':['yes'],'nonrelevant_ids':['no'],'insufficient_ids':['unknown']}
    score=score_query(ref,{'query_id':'q','execution_status':'completed','returned_ids':['yes','unknown']})
    assert score['metrics']['precision']==.5 and score['metrics']['recall']==1
    assert score['fp_known_negative']==0 and score['unsupported_accepts']==1
    assert not score['set_evaluation_pass']


def test_cost_does_not_zero_fill_missing_receipts_or_invent_a_bill():
    rows=[{'task_id':'q1','execution_completed':True,'wall_seconds':10,
           'product_usage':{'modelRequests':3,'inputTokens':100,'outputTokens':20}},
          {'task_id':'q2','execution_completed':False,'wall_seconds':20,
           'product_usage':{'modelRequests':2,'inputTokens':50,'outputTokens':0,'operatorUsage':{'accounting_complete':False}}}]
    result=efficiency(rows,{'currency':'test units','input_per_million':2,'output_per_million':3})
    assert result['totals']['adapter_calls']['sum_observed']==5
    assert result['totals']['input_tokens']=={'sum_observed':100,'missing_tasks':1}
    assert result['tasks'][0]['estimated_flat_rate_cost']==.00026
    assert all(r['actual_billed_cost'] is None for r in result['tasks'])
    assert result['latency_all_attempts']['p50']==15
    assert result['latency_completed']['observed']==1


def test_cleanup_failure_keeps_original_product_failure():
    def handler(request):
        if request.method=='POST' and request.url.path.endswith('/tasks'):
            return httpx.Response(200,json={'taskId':'failed'})
        return httpx.Response(502,text='upstream unavailable')
    async def run():
        async with httpx.AsyncClient(base_url='http://product',transport=httpx.MockTransport(handler)) as client:
            return await run_product('query','http://product',client=client)
    observed=asyncio.run(run())
    assert observed['task_id']=='failed' and observed['turns']==[]
    assert 'GET /api/retrieval-agent/tasks/failed: HTTP 502' in observed['error']


def test_observation_restarts_collection_after_cursor_revision_changes():
    stale=[True]
    def handler(request):
        if request.method=='POST':return httpx.Response(200,json={'taskId':'actual'})
        if request.url.path.endswith('/actual'):
            return httpx.Response(200,json={'node':{'collectionWindow':{},'result':{'resultRevision':'r','stoppingReason':'top_k_accepted'}}})
        if request.url.path.endswith('/candidates'):
            if request.url.params.get('cursor') and stale[0]:
                stale[0]=False
                return httpx.Response(409,json={'code':'INVALID_TRANSITION','retryable':True})
            if request.url.params.get('cursor'):return httpx.Response(200,json={'items':[{'ref':'b','displayId':'B'}]})
            return httpx.Response(200,json={'items':[{'ref':'a','displayId':'old' if stale[0] else 'A'}],'nextCursor':'tail'})
        if request.url.path.endswith('/report'):return httpx.Response(200,json={'confirmedCount':2})
        return httpx.Response(200,json={'items':[],'more':False,'after':0})
    async def run():
        async with httpx.AsyncClient(base_url='http://product',transport=httpx.MockTransport(handler)) as client:
            return await run_product('query','http://product',client=client,poll_seconds=0)
    observed=asyncio.run(run())
    assert observed['error'] is None
    assert observed['set_trace'][0]['returned_ids']==['A','B']
    assert observed['turns'][0]['ids']==['A','B']
