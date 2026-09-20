"""从已有规范化数据抽取闭集；不改生产数据，也不将标签交给产品。"""
import argparse
import hashlib
import json
from pathlib import Path


def prepare_pool(normalized: Path, cases_path: Path, output: Path):
    cases = [json.loads(line) for line in cases_path.read_text(encoding='utf-8').splitlines() if line.strip()]
    wanted = set().union(*(set(c['judged_universe']) for c in cases))
    groups = {}
    for case in cases:
        groups.setdefault(case['group_id'], set()).add(case['split'])
        if not set(case['expected_ids']) <= set(case['judged_universe']):
            raise ValueError('Expected IDs outside the judged universe')
    if any(len(splits) > 1 for splits in groups.values()):
        raise ValueError('A source dependency group crosses dataset splits')
    lines = [line for line in normalized.read_text(encoding='utf-8').splitlines() if line.strip()]
    selected = [line for line in lines if json.loads(line)['ticket_id'] in wanted]
    if {json.loads(line)['ticket_id'] for line in selected} != wanted or len(selected) != len(wanted):
        raise ValueError('Normalized data must contain each pool ticket exactly once')
    if output.resolve() == normalized.resolve():
        raise ValueError('Pool output must be separate from source data')
    output.parent.mkdir(parents=True, exist_ok=True)
    content = '\n'.join(selected) + '\n'
    output.write_text(content, encoding='utf-8')
    manifest = {'records': len(selected), 'cases': len(cases), 'groups': len(groups),
        'ticket_ids': sorted(wanted), 'source': str(normalized.resolve()),
        'source_sha256': hashlib.sha256(normalized.read_bytes()).hexdigest(),
        'cases_sha256': hashlib.sha256(cases_path.read_bytes()).hexdigest(),
        'pool_sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'label_status': sorted({c['label_status'] for c in cases}),
        'quality_scope': 'pilot labels; complete only for this isolated pool'}
    output.with_suffix('.manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--normalized', type=Path, default=Path('data/evals/esft-summary-v1/tickets.jsonl'))
    parser.add_argument('--cases', type=Path, default=Path('python/evals/data/esft-pilot/cases.jsonl'))
    parser.add_argument('--output', type=Path, default=Path('.cache/evals/esft-pilot/tickets.jsonl'))
    args = parser.parse_args()
    print(json.dumps(prepare_pool(args.normalized, args.cases, args.output), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
