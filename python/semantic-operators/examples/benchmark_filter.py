"""Reproducible computation comparison. Synthetic oracle, NOT business evaluation.

Run from repository root:
  uv run --frozen --inexact --project python/semantic-operators python python/semantic-operators/examples/benchmark_filter.py --output .cache/algorithm-evaluation/filter.json
"""
import argparse
import asyncio
from collections import Counter, defaultdict
from dataclasses import asdict
import json
from pathlib import Path
import time
import numpy as np
import scipy
import sklearn
from caseweave_ops import ArtifactStore, Knowledge, ModelReply, Passage, Record, Runtime, Scope
from caseweave_ops import invoke_rows, records_from
from caseweave_ops.types import digest


def dataset(kind, n, seed):
    rng = np.random.default_rng(seed)
    groups = np.arange(n) % (4 if kind == 'multimodal' else 2)
    y = (groups % 2).astype(int)
    X = np.eye(int(groups.max()) + 1)[groups] + rng.normal(0, .02, (n, int(groups.max()) + 1))
    if kind == 'mixed': y = rng.integers(0, 2, n)
    if kind in {'identical', 'rare', 'unknown'}: X = np.ones((n, 2))
    if kind == 'rare': y[:] = 0; y[-1] = 1
    if kind == 'unknown': y[:] = -1
    if kind == 'rare_identical':
        # 固定审阅反例的数据生成顺序，16384 条中随机放置 32 个正例。
        rng = np.random.default_rng(seed)
        groups = np.arange(n) % 4
        rng.normal(0, .05, (n, 4))
        X = np.ones((n, 4)); y = np.zeros(n, dtype=int)
        y[rng.choice(n, max(1, n // 512), replace=False)] = 1
    rows = [Record(str(i), 'synthetic-v1', digest(['source', i]),
        (Passage('p', 'source.raw_dialogue', f'Synthetic ticket {i}; interpretation supplied only by the scripted oracle.'),),
        (tuple(map(float, x)),), 'synthetic-space') for i, x in enumerate(X)]
    return rows, y, groups


def quality(y, predicted):
    if np.all(y == -1): return {'precision': None, 'recall': None, 'f1': None}
    tp = int(np.count_nonzero((y == 1) & (predicted == 1)))
    positive, accepted = int(np.count_nonzero(y == 1)), int(np.count_nonzero(predicted == 1))
    precision = tp / accepted if accepted else None
    recall = tp / positive if positive else None
    f1 = 2 * tp / (positive + accepted) if positive + accepted else None
    return {'precision': precision, 'recall': recall, 'f1': f1}


async def run_case(kind, n, seed, variant):
    rows, gold, groups = dataset(kind, n, seed)
    teacher = gold.copy()
    if kind == 'biased_teacher': teacher[np.arange(n) % 4 == 3] = 0
    actual = []
    class Oracle:
        identity = 'synthetic-oracle-not-a-business-model'
        async def generate(self, request):
            payload = json.loads(request['messages'][-1]['content'])
            actual.append([r['ref'] for r in payload['records']])
            return ModelReply({'rows': [{'ref': r['ref'], 'label': {-1:'undetermined', 0:'exclude', 1:'accept'}[int(teacher[int(r['ref'])])],
                'citations': [{'ref': r['ref'], 'passage_id': 'p', 'quote': r['passages'][0]['text']}],
                'knowledge_ids': [], 'reason': 'Explicit synthetic oracle; not business evidence.'} for r in payload['records']]})
    store = ArtifactStore()
    rt = Runtime(Scope('benchmark', 1, 'synthetic', 'fixture-owner'), Oracle(), store, Knowledge('empty'), use_cache=False)
    params = {'algorithm': 'baseline' if variant == 'full' else 'cluster',
              'batch_size': 8, 'options': {'seed': seed}}
    if variant == 'checked_1pct_experiment':
        params['options'].update(accept_error=.01, reject_error=.01)
    # 以下三个 proposal 使用相同分区、pilot、seed、容忍值，只改变预测器。
    matched = {'uniform_global_1pct': 'uniform', 'similarity_global_1pct': 'similarity', 'linear_global_1pct': 'linear'}
    if variant in matched:
        params['options'].update(clusters=1, pilot_size=64, proposal=matched[variant], accept_error=.01, reject_error=.01)
    # 对照 similarity_global_1pct 时分别只改变 pilot 或分区数。
    if variant in {'similarity_global_pilot12', 'similarity_four_clusters'}:
        params['options'].update(clusters=4 if variant == 'similarity_four_clusters' else 1,
            pilot_size=12 if variant == 'similarity_global_pilot12' else 64,
            proposal='similarity', accept_error=.01, reject_error=.01)
    allowed = {'full', 'checked', 'checked_1pct_experiment', *matched,
               'similarity_global_pilot12', 'similarity_four_clusters'}
    if variant not in allowed: raise ValueError(f'Unknown variant: {variant}')
    started, first = time.perf_counter(), None
    output = []
    try:
        async for event in invoke_rows('sem_filter', rt, records_from(rows), 'Synthetic fixed predicate', params):
            if first is None: first = time.perf_counter() - started
            output.append(event['value'])
        elapsed = time.perf_counter() - started
        strong = [r for batch in actual for r in batch]
        proxy = [v['ref'] for v in output if v['basis'] == 'proxy']
        assert len(output) == n and len({v['ref'] for v in output}) == n
        assert not set(strong).intersection(proxy) and set(strong) | set(proxy) == {r.ref for r in rows}
        predicted = np.full(n, -2)
        for value in output: predicted[int(value['ref'])] = {'accept':1, 'exclude':0, 'undetermined':-1}[value['label']]
        observations = [json.loads(row[0]) for row in store.db.execute("SELECT data FROM observations WHERE kind='filter_decision'")]
        phases = Counter(v['phase'] for v in observations if v['basis'] in ('model', 'reused_model'))
        phase_requests = defaultdict(set)
        for v in observations:
            if v['basis'] == 'model': phase_requests[v['phase']].add(v['manifest'])
        checks = [json.loads(row[0]) for row in store.db.execute("SELECT data FROM observations WHERE kind='filter_algorithm'")]
        return {'case': kind, 'n': n, 'seed': seed, 'variant': variant, 'configuration': params,
            'quality': quality(gold, predicted), 'quality_against_teacher': quality(teacher, predicted),
            'teacher_quality_against_gold': quality(gold, teacher), 'teacher_disagreement': float(np.mean(predicted != teacher)),
            'false_negative_ids': np.flatnonzero((gold == 1) & (predicted != 1)).tolist(),
            'subgroups': {str(g): quality(gold[groups == g], predicted[groups == g]) for g in np.unique(groups)},
            'actual_strong_record_ids': strong, 'actual_strong_batches': actual, 'proxy_record_ids': proxy,
            'outcomes': dict(Counter(v['label'] for v in output)),
            'phase_records': dict(phases) if phases else {'reference': len(strong)},
            'phase_requests': {k: len(v) for k, v in phase_requests.items()} if phase_requests else {'reference': len(actual)},
            'training_fits': sum(c.get('model_fits', 0) for c in checks),
            'calibration_checks': [c for c in checks if c['phase'] == 'check'],
            'retries': 0, 'supplemental_evidence_calls': 0, 'adapter_requests': len(actual),
            'physical_provider_requests': None, 'tokens': None, 'vendor_qpm_tpm': None,
            'metering': store.metrics('benchmark'), 'first_result_seconds': first, 'total_seconds': elapsed,
            'outside_candidate_recall': 'not_evaluated', 'closed_input': True}
    finally:
        store.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='.cache/algorithm-evaluation/filter.json')
    parser.add_argument('--size', type=int, default=1024)
    parser.add_argument('--seeds', default='0,7,19')
    parser.add_argument('--cases', default='separable,mixed,identical,rare,multimodal,unknown')
    parser.add_argument('--variants', default='full,checked,uniform_global_1pct,similarity_global_1pct,linear_global_1pct,similarity_global_pilot12,similarity_four_clusters')
    args = parser.parse_args()
    report = {'evidence': 'synthetic vectors and deterministic scripted oracle; NOT actual models, databases, or business Gold',
              'environment': {'numpy': np.__version__, 'scipy': scipy.__version__, 'sklearn': sklearn.__version__},
              'timing_limitations': 'single workstation observations; background load not controlled; not vendor latency or p95', 'runs': []}
    path = Path(args.output); path.parent.mkdir(parents=True, exist_ok=True)
    for kind in args.cases.split(','):
        for seed in map(int, args.seeds.split(',')):
            for variant in args.variants.split(','):
                run = await run_case(kind, args.size, seed, variant)
                report['runs'].append(run)
                path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps({k: run[k] for k in ('case','seed','variant','adapter_requests','quality','total_seconds')}, ensure_ascii=False), flush=True)


if __name__ == '__main__': asyncio.run(main())
