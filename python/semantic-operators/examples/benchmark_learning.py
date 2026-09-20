"""数值路径实验：memmap + 显式脚本 teacher，不是业务 Gold、真实 LLM 或 40M I/O 验收。"""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import tempfile
from time import perf_counter
import numpy as np
import sklearn
from caseweave_ops import ArtifactStore, Knowledge, ModelReply, Passage, Record, Runtime, Scope
from caseweave_ops import invoke_rows, records_from


async def experiment(size, dimensions, kind):
    with tempfile.TemporaryDirectory(prefix='caseweave-numeric-') as folder:
        X = np.memmap(Path(folder)/'features.f32', mode='w+', dtype='<f4', shape=(size, dimensions))
        predicted = np.memmap(Path(folder)/'labels.i1', mode='w+', dtype='i1', shape=(size,)); predicted[:] = -1
        rng = np.random.default_rng(16)
        labels = rng.integers(0, 2, size, dtype=np.int8)
        for start in range(0, size, 2048):
            end = min(start+2048, size)
            batch = rng.normal(0, .01 if kind == 'separable' else 1, (end-start, dimensions))
            if kind == 'separable': batch[np.arange(end-start), labels[start:end]] += 1
            batch /= np.linalg.norm(batch, axis=1, keepdims=True)
            X[start:end] = batch
        X.flush()
        reads, updates, requests = [], [], 0
        def block(ids, cursor=None):
            return {'ids': list(map(int, ids)), 'dense': base64.b64encode(X[ids].tobytes()).decode(),
                    'available': base64.b64encode(bytes([1]*len(ids))).decode(), 'dimensions': dimensions,
                    'feature_id': 'synthetic-memmap', 'next_cursor': cursor}
        async def resource(method, p):
            if method == 'features.scan':
                start = int(p['cursor'] or 0); end = min(start+p['page_size'], size)
                return block(np.arange(start, end), str(end) if end < size else None)
            if method == 'features.take': return block(p['ids'])
            if method == 'features.seeds': return {'ids': []}
            if method == 'rows.read':
                reads.extend(p['ids'])
                return {'rows': [Record(str(i), 'synthetic-v1', str(i),
                    (Passage('p', 'summary', 'Synthetic reference record', origin='source'),)).model_payload() for i in p['ids']]}
            if method == 'learning.update': updates.append(p.copy())
            elif method == 'predictions.write': predicted[p['ids']] = p['labels']
            elif method not in ('predictions.begin', 'predictions.finish'): raise ValueError(method)
            return {}
        class Teacher:
            identity = 'explicit-script-teacher-not-LLM'
            async def generate(self, request):
                nonlocal requests
                requests += 1
                payload = json.loads(request['messages'][-1]['content'])
                return ModelReply({'rows': [{'ref': r['ref'], 'label': 'accept' if labels[int(r['ref'])] else 'exclude',
                    'reason': 'Synthetic script label', 'knowledge_ids': [], 'citations': [{'ref': r['ref'],
                    'passage_id': 'p', 'quote': r['passages'][0]['text']}]} for r in payload['records']]})
        store = ArtifactStore(':memory:')
        runtime = Runtime(Scope('numeric-experiment', 1, 'synthetic', 'local'), Teacher(), store, Knowledge('empty'))
        runtime.resources = resource
        start = perf_counter()
        async for _ in invoke_rows('sem_filter', runtime, records_from([]), 'Synthetic fixed predicate'): pass
        elapsed = perf_counter()-start
        tp = int(np.count_nonzero((predicted == 1) & (labels == 1)))
        returned, positives = int(np.count_nonzero(predicted == 1)), int(np.count_nonzero(labels == 1))
        summary = {k: v for k, v in updates[-1].items() if k not in ('_usage', 'training_ids', 'selection_ids', 'audit_ids')}
        store.close()
        result = {'case': kind, 'rows': size, 'dimensions': dimensions, 'elapsed_seconds': elapsed,
                  'source_rows_read': len(set(reads)), 'script_teacher_requests': requests,
                  'actual_llm_calls': None, 'business_quality': None, 'mysql_io': None, '40M_cold_warm_io': None,
                  'synthetic_precision': tp/returned if returned else None, 'synthetic_recall': tp/positives if positives else None,
                  'learning': summary}
        del X, predicted
        return result


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--size', type=int, default=100000)
    parser.add_argument('--dimensions', type=int, default=32)
    parser.add_argument('--output', default='.cache/algorithm-evaluation/learned.json')
    args = parser.parse_args()
    report = {'evidence': __doc__, 'numpy': np.__version__, 'sklearn': sklearn.__version__, 'runs': []}
    for kind in ('separable', 'no_signal'):
        run = await experiment(args.size, args.dimensions, kind); report['runs'].append(run)
        print(json.dumps({k: run[k] for k in ('case', 'rows', 'elapsed_seconds', 'source_rows_read', 'synthetic_precision', 'synthetic_recall')}, ensure_ascii=False), flush=True)
    path = Path(args.output); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__': asyncio.run(main())
