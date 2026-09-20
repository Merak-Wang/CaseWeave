"""Thin HTTP driver of CaseWeave's existing public API. Does not implement an Agent."""
import asyncio
import time
from uuid import uuid4
import httpx


class CollectionChanged(ValueError):
    pass


async def run_product(query: str, base_url: str, followups=(), *, client=None,
                      timeout_seconds: float | None = None, poll_seconds: float = 1) -> dict:
    owned = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=60)
    task_id, turns, activity, usage, learning = None, [], [], None, None
    started = time.perf_counter()
    read_retries = []
    latency = {'first_candidate_seconds': None, 'first_confirmed_seconds': None, 'completion_seconds': None}
    progress = []
    set_trace = []
    trace_key = None

    async def request(method, path, **kwargs):
        while True:
            response = await client.request(method, path, **kwargs)
            if response.status_code in (409, 503) and method == 'GET':
                failure = response.json()
                if failure.get('retryable') or failure.get('code') == 'INVALID_TRANSITION':
                    read_retries.append({'elapsed_seconds': time.perf_counter()-started, **failure})
                    if (kwargs.get('params') or {}).get('cursor') and failure.get('code') == 'INVALID_TRANSITION':
                        raise CollectionChanged()
                    await asyncio.sleep(poll_seconds)
                    continue
            if response.is_error:
                raise ValueError(f'{method} {path}: HTTP {response.status_code}: {response.text}')
            return response.json()

    async def collection(path, view):
        while True:
            items, judgments, cursor = [], [], None
            try:
                while True:
                    params={'view':view,'limit':100}
                    if cursor:params['cursor']=cursor
                    page=await request('GET',path+'/candidates',params=params)
                    items.extend(page['items']);judgments.extend(page.get('judgments',[]))
                    following=page.get('nextCursor')
                    if not following:return items,judgments
                    if following==cursor:raise ValueError('Candidate cursor did not advance')
                    cursor=following
            except CollectionChanged:
                # 活跃集合版本变化时整页重读，不能沿旧游标反复重试或拼接两版结果。
                continue

    async def body():
        nonlocal task_id, usage, learning, trace_key
        receipt = await request('POST', '/api/retrieval-agent/tasks', json={
            'kind':'query','text':query,'operationId':uuid4().hex})
        task_id = receipt['taskId']
        path = f'/api/retrieval-agent/tasks/{task_id}'
        for index, text in enumerate([query, *followups]):
            if index:
                await request('POST',path,json={'kind':'supplement','text':text,'operationId':uuid4().hex})
            previous_revision = (turns[-1].get('result') or {}).get('resultRevision') if turns else None
            while True:
                snapshot = await request('GET',path)
                orchestration = snapshot.get('orchestration') or (snapshot.get('node') or {}).get('orchestration') or {}
                usage = orchestration.get('usage', usage)
                learning = ((usage or {}).get('operatorUsage') or {}).get('learning') or learning
                for key, count in [('first_candidate_seconds','candidates'), ('first_confirmed_seconds','confirmed')]:
                    if latency[key] is None and (orchestration.get('counts') or {}).get(count, 0):
                        latency[key] = time.perf_counter()-started
                step = {'counts': orchestration.get('counts'), 'usage': usage, 'learning': learning}
                if not progress or any(progress[-1].get(k) != v for k,v in step.items()):
                    progress.append({'elapsed_seconds': time.perf_counter()-started, **step})
                node = snapshot.get('node') or {}
                result = node.get('result')
                next_trace_key = (index, (orchestration.get('counts') or {}).get('confirmed'),
                    (learning or {}).get('teacher_unique_records'), (learning or {}).get('fit_count'))
                if node.get('collectionWindow') is not None and next_trace_key != trace_key:
                    current_items,_ = await collection(path,'confirmed')
                    ids = [r['displayId'] for r in current_items]
                    set_trace.append({'round':index,'elapsed_seconds':time.perf_counter()-started,
                        'returned_ids':ids,'adapter_calls':(usage or {}).get('modelRequests'),
                        'teacher_records_current_invocation':(learning or {}).get('teacher_unique_records'),
                        'fit_count_current_invocation':(learning or {}).get('fit_count')})
                    trace_key=next_trace_key
                if snapshot.get('failure') or snapshot.get('question'):
                    break
                if result is not None and result.get('resultRevision') != previous_revision:
                    break
                await asyncio.sleep(poll_seconds)
            if snapshot.get('failure'):
                outcome='failed'
            elif snapshot.get('question'):
                outcome='needs_user_reply'
            else:
                outcome='completed' if result.get('stoppingReason') in {'top_k_accepted','no_result'} else 'incomplete'
            latency['completion_seconds'] = time.perf_counter()-started
            tickets, report, judged = [], None, []
            if result is not None and outcome != 'needs_user_reply':
                if node.get('collectionWindow') is not None:
                    tickets,_ = await collection(path,'confirmed')
                    report=await request('GET',path+'/report',params={'resultRevision':result['resultRevision']})
                    history, judgments = await collection(path,'history')
                    identities={r['ref']:r['displayId'] for r in history}
                    judged=[{'display_id':identities[j['candidateRef']], **j} for j in judgments]
                else:
                    tickets=result.get('tickets',[])
            turns.append({'query':text,'outcome':outcome,'ids':[r['displayId'] for r in tickets],
                'tickets':tickets,'report':report,'result':result,'question':snapshot.get('question'),
                'failure':snapshot.get('failure'),'conversation':snapshot.get('conversation',[]),
                'product_usage':usage,'learning':learning,
                'judgments':judged,
                'elapsed_seconds':time.perf_counter()-started})
            if outcome!='completed':break
        after=0
        while True:
            page=await request('GET',path+'/activity',params={'after':after})
            activity.extend(page['items'])
            following=page['after']
            if not page['more']:break
            if following==after:raise ValueError('Activity cursor did not advance')
            after=following

    error=None
    try:
        async with asyncio.timeout(timeout_seconds):
            await body()
    except (TimeoutError, httpx.HTTPError, OSError, ValueError, KeyError) as exc:
        error=f'{type(exc).__name__}: {exc}'
        # Existing completed rounds remain visible; failures never become successful no_result.
    except asyncio.CancelledError:
        if task_id:
            try:
                await request('POST',f'/api/retrieval-agent/tasks/{task_id}',json={'kind':'cancel','operationId':uuid4().hex})
            except (httpx.HTTPError, ValueError):
                pass
        raise
    finally:
        if error and task_id:
            try:
                await request('POST',f'/api/retrieval-agent/tasks/{task_id}',json={'kind':'cancel','operationId':uuid4().hex})
            except (httpx.HTTPError, ValueError):
                pass
        if owned:await client.aclose()
    return {'task_id':task_id,'turns':turns,'activity':activity,'error':error,
        'wall_seconds':time.perf_counter()-started,
        'product_usage':usage,'learning':learning,
        'latency':latency,'read_retries':read_retries,'progress':progress,'set_trace':set_trace,
        'measurement_note':'Usage comes from public orchestration. Operator token receipts and learning are separate from Inspect usage; absent receipts remain null.'}
