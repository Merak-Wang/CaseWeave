"""Inspect runs the real HTTP product. It does not call generate or simulate its decisions."""
import json
from pathlib import Path
from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import Score, mean, scorer
from inspect_ai.solver import solver

from .product_client import run_product
from .scoring import evaluate_task
from .real400_scoring import score_query
ROOT=Path(__file__).resolve().parent


def load_jsonl(path):
    return [json.loads(s) for s in Path(path).read_text(encoding='utf-8').splitlines() if s.strip()]


@solver
def product_solver(base_url: str, timeout_seconds: float | None = None):
    async def solve(state, generate):
        public=state.metadata['public_task']
        observed=await run_product(public['query'],base_url,public['followups'],timeout_seconds=timeout_seconds)
        state.metadata['product_observation']=observed
        # This is the actual product output. No Inspect model is used as a stand-in.
        state.output.completion=json.dumps(observed,ensure_ascii=False)
        state.completed=True
        return state
    return solve


@scorer(metrics=[mean()])
def execution_completed(labels_path: str, benchmark: str = ''):
    data = Path(benchmark)/'data' if benchmark else ROOT/'data'
    real400 = (data/'public/queries.jsonl').exists()
    labels=load_jsonl(labels_path) if labels_path else []
    if any(r.get('needs_task_alignment_review') for r in labels):
        raise ValueError('Migration seeds require task-alignment review before scoring')
    universe=json.loads((data/('private/universe.json' if real400 else 'private/corpus_ids.json')).read_text(encoding='utf-8'))
    references={r['query_id']:r for r in load_jsonl(data/'private/reference_sets.jsonl')} if real400 else {}
    async def score(state,target):
        public, observed=state.metadata['public_task'],state.metadata['product_observation']
        result=evaluate_task(public,observed,labels,universe)
        if real400:
            turn=observed['turns'][-1] if observed['turns'] else {}
            usage=observed.get('product_usage') or {}; learning=observed.get('learning') or {}
            prediction={'query_id':public['task_id'], 'execution_status':'completed' if result['execution_completed'] else 'partial' if turn else 'failed',
                'returned_ids':turn.get('ids',[]),'elapsed_seconds':observed.get('wall_seconds'),
                'fit_count':learning.get('fit_count'),'teacher_record_count':learning.get('teacher_unique_records'),
                'model_requests':usage.get('modelRequests'),'input_tokens':usage.get('inputTokens'),
                'output_tokens':usage.get('outputTokens'),'report_confirmed_count':(turn.get('report') or {}).get('confirmedCount')}
            judgments=turn.get('judgments',[])
            prediction['teacher_judged_ids']=[j['display_id'] for j in judgments if j.get('operatorManifestId') and j.get('basis') != 'proxy']
            prediction['unresolved_ids']=[j['display_id'] for j in judgments if j['verdict']=='undetermined']
            prediction['ml_predictions']={j['display_id']:int(j['verdict']=='accept') for j in judgments if j.get('basis')=='proxy'}
            prediction['ml_trace_scope']='materialized predictions only; unmaterialized negative region remains in learning counts'
            prediction['latency']=observed.get('latency')
            scored=score_query(references[public['task_id']],prediction)
            result['prediction']=prediction; result['benchmark_result']=scored
            result['quality_work_curve']=[{**step,'metrics':score_query(references[public['task_id']],
                {'query_id':public['task_id'],'execution_status':'partial','returned_ids':step['returned_ids']})['metrics']}
                for step in observed.get('set_trace',[])]
            result['quality_work_curve_note']='Offline scoring of observed public sets; reference labels never reach the product. '
            result['quality_work_curve_note']+='Polling checkpoints can miss intervening changes; teacher/fit counters describe the current operator invocation.'
            result['rounds']=[{'round':0,'outcome':turn.get('outcome','failed'),
                'metrics':{**scored['metrics'],'exact_scoring_available':True,
                    'reference_policy':'strict_supported_accepts; source-insufficient confirmations counted separately'},
                'report_count_correct':scored['report_count_matches_result']}]
            result['all_rounds_exact_scoring_available']=True
        return Score(value=float(result['execution_completed']),
            explanation='This score is execution completion, NOT business success. Full set metrics and missing-label status are in metadata.',
            metadata={'set_evaluation':result})
    return score


@task
def caseweave_sets(base_url: str='http://127.0.0.1:3080', tasks: str='', labels_path: str='',
                   timeout_seconds: float | None = None, benchmark: str = ''):
    data=Path(benchmark)/'data' if benchmark else ROOT/'data'
    real400=(data/'public/queries.jsonl').exists()
    public=[{'task_id':r['query_id'],'query':r['query'],'followups':[],'family':r['title']} for r in load_jsonl(data/'public/queries.jsonl')] if real400 else load_jsonl(data/'public/tasks.jsonl')
    if tasks:public=[r for r in public if r['task_id'] in set(tasks.split(','))]
    if not public:raise ValueError('No selected tasks')
    dataset=MemoryDataset([Sample(id=r['task_id'],input=r['query'],
        metadata={'public_task':r,'business_family':r['family']}) for r in public])
    return Task(dataset=dataset,solver=product_solver(base_url,timeout_seconds),
                scorer=execution_completed(labels_path,benchmark))
