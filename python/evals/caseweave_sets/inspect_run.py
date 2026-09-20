"""Single-command Inspect evaluation plus set-metric aggregation from its real logs."""
import argparse,json,hashlib,subprocess,sys
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from inspect_ai import eval as inspect_eval
from .inspect_caseweave import caseweave_sets, load_jsonl, ROOT
from .scoring import summarize, score_collection
from .real400_scoring import evaluate as evaluate_real400
from .efficiency import efficiency

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--target',default='http://127.0.0.1:3080');p.add_argument('--tasks',default=None)
    p.add_argument('--benchmark',default='',help='Unpacked benchmark root; private references remain in this evaluator')
    p.add_argument('--all',action='store_true',help='Run all 100 tasks after the first six')
    p.add_argument('--labels',default='',help='Reviewed reference JSONL; omitted means all labels unknown')
    p.add_argument('--out',default='.cache/evals/caseweave-sets');p.add_argument('--concurrency',type=int,default=1)
    p.add_argument('--epochs',type=int,default=1);p.add_argument('--timeout',type=float)
    p.add_argument('--rates',default='',help='Optional JSON: currency, input_per_million, output_per_million; estimate only')
    # Inspect requires a model identity even for an externally driven Solver.
    # This placeholder is NEVER generated from. Actual model remains the running DSH model.
    p.add_argument('--inspect-model',default='mockllm/model')
    args=p.parse_args();out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],text=True).splitlines()
    code=hashlib.sha256()
    for name in sorted(set(files)):
        path=Path(name)
        if path.is_file() and name.startswith(('packages/','python/','scripts/','config/')) and path.suffix in ('.ts','.tsx','.py','.mjs','.yml','.toml'):
            code.update(name.encode());code.update(path.read_bytes())
    manifest={'started_at':datetime.now(timezone.utc).isoformat(),'command':sys.argv,
              'git_head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
              'workspace_source_sha256':code.hexdigest(),'python':sys.version,'inspect_ai':version('inspect-ai'),
              'scope':'source hash at launch; product process/build and external provider conditions must also be fixed for comparisons'}
    (out/'run_manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    data=Path(args.benchmark)/'data' if args.benchmark else ROOT/'data'
    real400=(data/'public/queries.jsonl').exists()
    manifest['data_files']={str(p.relative_to(data)):hashlib.sha256(p.read_bytes()).hexdigest() for p in data.rglob('*') if p.is_file()}
    (out/'run_manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    chosen='' if args.all else args.tasks if args.tasks is not None else '' if real400 else 'CWSET-001,CWSET-002,CWSET-003,CWSET-007,CWSET-021,CWSET-066'
    public=([{'task_id':r['query_id'],'followups':[]} for r in load_jsonl(data/'public/queries.jsonl')] if real400 else load_jsonl(data/'public/tasks.jsonl'))
    public=[r for r in public if not chosen or r['task_id'] in chosen.split(',')]
    labels=load_jsonl(args.labels) if args.labels else []
    universe=json.loads((data/('private/universe.json' if real400 else 'private/corpus_ids.json')).read_text(encoding='utf-8'))
    if real400:
        labels=[{**r,'task_id':r['query_id'],'source':'assistant_reviewed_not_human_adjudicated',
            'label':{0:'irrelevant',1:'relevant',2:'insufficient'}[r['label']]} for r in load_jsonl(data/'private/qrels.jsonl')]
    coverage=[{'task_id':r['task_id'],'round':turn,**score_collection(universe,
        [v for v in labels if v['task_id']==r['task_id'] and v.get('round',0)==turn], [])}
        for r in public for turn in range(1+len(r['followups']))]
    (out/'data_coverage.json').write_text(json.dumps(coverage,ensure_ascii=False,indent=2),encoding='utf-8')
    logs=inspect_eval(caseweave_sets(args.target,chosen,args.labels,args.timeout,args.benchmark),
        model=args.inspect_model,max_samples=args.concurrency,epochs=args.epochs,log_dir=str(out))
    results=[]
    for log in logs:
        for sample in log.samples or []:
            scored=False
            for score in (sample.scores or {}).values():
                if score.metadata and 'set_evaluation' in score.metadata:
                    value=dict(score.metadata['set_evaluation']);value['epoch']=sample.epoch
                    results.append(value)
                    scored=True
            if not scored:
                results.append({'task_id':str(sample.id),'epoch':sample.epoch,'execution_completed':False,
                    'rounds':[],'all_rounds_exact_scoring_available':False,
                    'error':sample.error.message if sample.error else 'Inspect sample produced no set score',
                    'prediction':{'query_id':str(sample.id),'execution_status':'failed','returned_ids':[]}})
    report=summarize(results)
    if real400:
        refs=[r for r in load_jsonl(data/'private/reference_sets.jsonl') if not chosen or r['query_id'] in chosen.split(',')]
        epochs=sorted({r['epoch'] for r in results})
        evaluations=[]
        for epoch in epochs:
            predictions=[r['prediction'] for r in results if r['epoch']==epoch]
            name='predictions.jsonl' if len(epochs)==1 else f'predictions-epoch-{epoch}.jsonl'
            (out/name).write_text(''.join(json.dumps(p,ensure_ascii=False)+'\n' for p in predictions),encoding='utf-8')
            evaluations.append({'epoch':epoch,**evaluate_real400(refs,predictions)})
        (out/'real400_scores.json').write_text(json.dumps(evaluations[0] if len(evaluations)==1 else {'epochs':evaluations},ensure_ascii=False,indent=2),encoding='utf-8')
    report['inspect_log_status']=[str(log.status) for log in logs]
    report['note']+=' Repeated epochs are repeated runs, not independent business tasks. Inspect placeholder has no generation; DSH handles every real task.'
    (out/'set_scores.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'set_summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    failures=[r for r in results if not r.get('execution_completed') or r.get('benchmark_result',{}).get('set_evaluation_pass') is False
              or any(t.get('report_count_correct') is False for t in r.get('rounds',[]))]
    (out/'failures.json').write_text(json.dumps(failures,ensure_ascii=False,indent=2),encoding='utf-8')
    rates=json.loads(Path(args.rates).read_text(encoding='utf-8')) if args.rates else None
    (out/'efficiency.json').write_text(json.dumps(efficiency(results,rates),ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    if not results or failures or any(str(log.status)!='success' for log in logs):raise SystemExit(1)
