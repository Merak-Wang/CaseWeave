"""产品回执的成本和时延；缺失回执不按零计费。"""
from statistics import mean


def distribution(values):
    values=sorted(v for v in values if v is not None)
    def percentile(p):
        at=(len(values)-1)*p;lo=int(at);hi=min(lo+1,len(values)-1)
        return values[lo]+(values[hi]-values[lo])*(at-lo)
    return {'observed':len(values),'mean':mean(values),'p50':percentile(.5),'p95':percentile(.95),
            'min':values[0],'max':values[-1]} if values else {'observed':0,'mean':None,'p50':None,'p95':None,'min':None,'max':None}


def efficiency(results, rates=None):
    rows=[]
    for result in results:
        usage=result.get('product_usage') or {};operators=usage.get('operatorUsage') or {}
        inputs=usage.get('inputTokens');outputs=usage.get('outputTokens')
        if operators.get('accounting_complete') is False:
            inputs=outputs=None
        cost=None
        if rates is not None and inputs is not None and outputs is not None:
            cost=(inputs*rates['input_per_million']+outputs*rates['output_per_million'])/1e6
        rows.append({'task_id':result['task_id'],'product_task_id':result.get('product_task_id'),'epoch':result.get('epoch'),
            'execution_completed':result['execution_completed'],'wall_seconds':result.get('wall_seconds'),
            'latency':result.get('latency'),'adapter_calls':usage.get('modelRequests'),
            'input_tokens':inputs,'output_tokens':outputs,'operator_cached_input_tokens':operators.get('reported_cached_prompt_subset'),
            'operator_failed_attempts':operators.get('failed_attempts'),'operator_cache_hits':operators.get('cache_hits'),
            'operator_request_seconds_sum':operators.get('sum_request_seconds'),
            'estimated_flat_rate_cost':cost,'actual_billed_cost':None})
    sums={key:{'sum_observed':sum(r[key] for r in rows if r[key] is not None),
               'missing_tasks':sum(r[key] is None for r in rows)}
          for key in ('adapter_calls','input_tokens','output_tokens','estimated_flat_rate_cost')}
    return {'tasks':rows,'totals':sums,'rates':rates,
        'latency_all_attempts':distribution(r['wall_seconds'] for r in rows),
        'latency_completed':distribution(r['wall_seconds'] for r in rows if r['execution_completed']),
        'stage_latency_all_attempts':{key:distribution((r.get('latency') or {}).get(key) for r in rows)
            for key in ('first_candidate_seconds','first_confirmed_seconds','completion_seconds')},
        'note':'Calls are product adapter invocations, not hidden provider retries. Input includes reported cache tokens. '
        'Flat-rate estimates require explicit rates and do not model subscription billing or cache discounts. '
        'Elapsed includes public API polling and result collection. Request-time sums overlap under concurrency. '
        'No bill or per-request service-level latency is inferred from these observations. '
        'Token costs cover observed product LLM requests; local embedding/index hardware costs and optional report-generation delivery jobs are not priced.'}
