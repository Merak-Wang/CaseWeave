"""Offline inventory and conservative review projection; never publishes source text.

Private output must be outside the runtime wiki. No source scripts are executed.
"""
import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def project(text):
    """Review aid only, not a claim that arbitrary text has been anonymised."""
    lines = []
    fenced = False
    front = text.startswith('---')
    for n, line in enumerate(text.splitlines(), 1):
        if line.strip() == '---' and (n == 1 or front):
            if n != 1:
                front = False
            continue
        if front:
            continue
        if re.match(r'^\s*(```|~~~)', line):
            fenced = not fenced
            continue
        if fenced or not line.strip():
            continue
        # Entire operational/credential/contact lines are withheld, not just passwords.
        if re.search(r'(?i)(https?://|jdbc:|curl\b|select\b|update\b|insert\b|delete\b|alter\b|drop\b|grant\b|password|passwd|secret|token|authorization|cookie|api.?key|ssh\b|密码|口令|密钥|联系人|联系电话|登录地址|连接地址|工号\s*[:：]|身份证号\s*[:：]|证件号码\s*[:：]|客户姓名|客户名称\s*[:：]|姓名\s*[:：]|忽略.{0,10}指令|ignore.{0,20}instructions)', line):
            continue
        if re.search(r'(?i)(tf_[a-z_]+|td_[a-z_]+|ti_[a-z_]+|[A-Za-z]:[\\/]|\b\d{1,3}(?:\.\d{1,3}){3}\b|[\w.+-]+@[\w.-]+)', line):
            continue
        if re.search(r'\d[\d -]{6,}\d|[A-Za-z0-9_-]{24,}', line):
            continue
        line = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', line)
        line = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', line)
        line = re.sub(r'\[\[([^\]|]+)\|([^\]]+)\]\]', r'\2', line)
        line = re.sub(r'\[\[([^\]]+)\]\]', r'\1', line)
        lines.append({'line': n, 'text': line})
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True)
    ap.add_argument('--private', required=True)
    args = ap.parse_args()
    root, private = Path(args.source).resolve(), Path(args.private).resolve()
    if any((parent / '.git').exists() for parent in [private, *private.parents]):
        raise SystemExit('Confidential private directory must be outside every Git worktree')
    if root == private or root in private.parents:
        raise SystemExit('Private intake must be separate from source')
    private.mkdir(parents=True, exist_ok=True)
    records, review = [], []
    for path in sorted(root.rglob('*')):
        if not path.is_file() or '.git' in path.parts:
            continue
        rel = path.relative_to(root)
        data = path.read_bytes()
        sid = 'src-' + digest(rel.as_posix().encode())[:16]
        excluded = any(part.startswith('.') or part in {'source', 'sources', 'raw', '_archive', 'schema', 'skills'} for part in rel.parts)
        candidate = (not excluded and path.suffix.lower() == '.md' and
                     any(p in {'concept', 'concepts', 'synthesis', 'syntheses', 'comparison', 'comparisons', 'architecture', 'architectures', 'queries'} for p in rel.parts) and
                     path.name not in {'SKILL.md', 'README.md', 'index.md'})
        rec = {'id': sid, 'path': rel.as_posix(), 'sha256': digest(data), 'bytes': len(data),
               'group': rel.parts[0], 'disposition': 'review-candidate' if candidate else 'withheld-from-runtime',
               'reason': 'business-prose-review' if candidate else 'raw-attachment-history-instruction-schema-or-navigation'}
        if path.suffix.lower() in {'.md', '.txt', '.json', '.py', '.js', '.sh', '.bat'}:
            raw = data.decode('utf-8-sig', errors='replace')
            rec['riskSignals'] = [name for name, pat in {
                'contact-or-long-identifier': r'\d{8,}|[\w.+-]+@[\w.-]+',
                'endpoint': r'https?://|\b\d{1,3}(?:\.\d{1,3}){3}\b',
                'credential-language': r'(?i)password|passwd|secret|token|authorization|密码|密钥',
                'executable-or-database': r'(?i)```|\b(select|update|delete|insert|curl|grant)\b',
            }.items() if re.search(pat, raw)]
            if candidate:
                review.append({'id': sid, 'group': rel.parts[0], 'kind': rel.parts[-2],
                               'title': project('# ' + path.stem), 'lines': project(raw)})
        records.append(rec)
    (private / 'source-inventory.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
    (private / 'review-projection.json').write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding='utf-8')
    summary = {'files': len(records), 'reviewCandidates': len(review),
               'extensions': dict(Counter(Path(r['path']).suffix for r in records)),
               'groups': dict(Counter(r['group'] for r in review)),
               'riskSignals': dict(Counter(s for r in records for s in r.get('riskSignals', [])))}
    (private / 'inventory-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
