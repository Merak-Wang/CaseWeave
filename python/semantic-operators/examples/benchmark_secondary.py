"""Secondary computation probes; scripted relations, not business evaluation."""
import asyncio
import json
from pathlib import Path
import tempfile
import time
import tracemalloc
import numpy as np
from caseweave_ops import ArtifactStore, Knowledge, ModelReply, Passage, Record, Runtime, Scope
from caseweave_ops.dispatch import invoke_rows, records_from
from caseweave_ops.filter_adapter import FeatureSpool
from caseweave_ops.join import indexed_pairs, cartesian_pairs, sem_join


def row(i, text=None, vectors=()):
    return Record(str(i), 'synthetic', str(i), (Passage('p', 'source', text or f'synthetic {i}'),), vectors, 'synthetic')


async def main():
    report = {'evidence': 'synthetic scripted total order and relation; no real model/database calls', 'topk': [], 'join': []}
    for seed in (0, 7, 19):
        ids = np.random.default_rng(seed).permutation(511)
        for strategy in ('heap', 'quick'):
            pairs = []
            class Comparator:
                identity = 'scripted-order'
                async def generate(self, request):
                    p = json.loads(request['messages'][-1]['content'])
                    a, b = p['left'], p['right']; pairs.append([a['ref'], b['ref']])
                    return ModelReply({'winner': 'left' if int(a['ref']) > int(b['ref']) else 'right',
                        'citations': [{'ref': r['ref'], 'passage_id': 'p', 'quote': r['passages'][0]['text']} for r in (a, b)]})
            store = ArtifactStore()
            runtime = Runtime(Scope('topk', seed, 'synthetic', 'fixture'), Comparator(), store, Knowledge('empty'), use_cache=False)
            start = time.perf_counter()
            out = [v async for v in invoke_rows('sem_topk', runtime, records_from([row(i) for i in ids]), 'synthetic order', {'k': 20, 'strategy': strategy})][0]
            assert out['refs'] == [str(i) for i in range(510, 490, -1)]
            report['topk'].append({'strategy': strategy, 'seed': seed, 'n': 511, 'k': 20, 'adapter_requests': len(pairs),
                'seconds': time.perf_counter()-start, 'comparison_pairs': pairs, 'exact_synthetic_topk': True, 'tokens': None})
            store.close()
    left = [row('l1', 'a'), row('l2', 'b')]
    right = [row('r1', 'a'), row('r2', 'b'), row('r3', 'c')]
    gold = {('l1', 'r1'), ('l2', 'r2'), ('l1', 'r3')}
    for method in ('cartesian', 'blocking'):
        pairs = cartesian_pairs(records_from(left), lambda: records_from(right)) if method == 'cartesian' else indexed_pairs(
            records_from(left), records_from(right), lambda r: [r.passages[0].text])
        candidates = [p async for p in pairs]
        proposed = {(a.ref, b.ref) for a, b in candidates}
        judged = []
        class Relation:
            identity = 'scripted-relation'
            async def generate(self, request):
                p = json.loads(request['messages'][-1]['content'])
                judged.extend(p['pairs'])
                return ModelReply({'rows': [{'pair_id': v['pair_id'],
                    'label': 'accept' if (v['left']['ref'], v['right']['ref']) in gold else 'exclude',
                    'reason': 'scripted relation', 'citations': [{'ref': r['ref'], 'passage_id': 'p', 'quote': r['passages'][0]['text']}
                        for r in (v['left'], v['right'])]} for v in p['pairs']]})
        store = ArtifactStore()
        runtime = Runtime(Scope('join', 0, 'synthetic', 'fixture'), Relation(), store, Knowledge('empty'), use_cache=False)
        output = [v async for v in sem_join(runtime, records_from(candidates), 'synthetic relation')]
        accepted = {(v.left, v.right) for v in output if v.label == 'accept'}
        report['join'].append({'strategy': method, 'candidate_pairs': sorted(proposed), 'candidate_pair_recall': len(proposed & gold)/len(gold),
            'judged_pairs': len(judged), 'judgment_accuracy_within_candidates': sum(((a, b) in accepted) == ((a, b) in gold) for a, b in proposed)/len(proposed),
            'end_to_end_recall': len(accepted & gold)/len(gold), 'adapter_requests': store.metrics('join')['llm_adapter_calls'], 'tokens': None})
        store.close()
    # Measure incremental Python heap for the disk adapter, not total native RSS
    # or the whole algorithm. Long texts are created one row at a time.
    for n in (1000, 10000):
        tracemalloc.start()
        start = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix='caseweave-memory-probe-') as root:
            spool = FeatureSpool(root)
            for i in range(n): spool.add(row(i, str(i) + ':' + 'x' * 16384, ((1., 0.),)))
            spool.db.commit()
            _, peak = tracemalloc.get_traced_memory()
            report.setdefault('spool', []).append({'rows': n, 'text_chars_per_row': 16384, 'python_heap_peak_bytes': peak,
                'seconds': time.perf_counter()-start, 'disk_bytes': sum(p.stat().st_size for p in Path(root).iterdir())})
            spool.close()
        tracemalloc.stop()
    path = Path('.cache/algorithm-evaluation/secondary.json'); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(path)


if __name__ == '__main__': asyncio.run(main())
