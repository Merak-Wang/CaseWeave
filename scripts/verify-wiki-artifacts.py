"""Audit publishable files without printing confidential source values."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--private')
    ap.add_argument('--output')
    ap.add_argument('--wiki', help='Published Wiki directory; defaults to the repository Wiki')
    args = ap.parse_args()
    repo = Path(__file__).resolve().parent.parent
    wiki = Path(args.wiki).resolve() if args.wiki else repo / 'wiki'
    content = json.loads((wiki / 'curation.json').read_text(encoding='utf-8'))
    # Editable Markdown belongs to the offline curation release. Later file edits
    # and learned entries are immutable runtime JSON, with no Markdown mirror.
    pointer = {'releaseId': content['releaseId']}
    manifest = json.loads((wiki / 'releases' / pointer['releaseId'] / 'manifest.json').read_text(encoding='utf-8'))
    errors, sizes = [], []
    def label(path):
        return path.relative_to(repo).as_posix() if path.is_relative_to(repo) else 'wiki/' + path.relative_to(wiki).as_posix()
    current = json.loads((wiki / 'current.json').read_text(encoding='utf-8'))
    runtime = subprocess.run(['node', str(repo / 'scripts/wiki-store.mjs'), 'verify', '--wiki', str(wiki)], capture_output=True)
    if runtime.returncode != 0:
        errors.append({'file': 'wiki/current.json', 'kind': 'runtime-release-invalid'})
    elif json.loads(runtime.stdout)['releaseId'] != current['releaseId']:
        errors.append({'file': 'wiki/current.json', 'kind': 'runtime-release-fallback'})
    for ref in manifest['entries']:
        path = wiki / 'releases' / pointer['releaseId'] / 'entries' / (ref['id'] + '.json')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != ref['sha256']:
            errors.append({'file': ref['id'], 'kind': 'offline-release-hash-mismatch'})
        e = json.loads(raw)
        md = wiki / 'domains' / e['domain'] / 'concepts' / (e['id'] + '.md')
        if not md.is_file() or md.read_text(encoding='utf-8') != e['bodyMarkdown']:
            errors.append({'file': label(md), 'kind': 'markdown-release-mismatch'})
        for section in ['### 专有名词与业务对象', '### 业务关系与判断逻辑', '### 典型业务场景', '## 工单中应核对的证据', '## 适用边界与反例']:
            if section not in e['bodyMarkdown']:
                errors.append({'file': ref['id'], 'kind': 'missing-section'})
        sizes.append(len(e['bodyMarkdown']))
    link_count = 0
    for md in [*wiki.rglob('*.md'), repo / 'docs/README.md', repo / 'docs/design/KNOWLEDGE.md']:
        for target in re.findall(r'\]\(([^)]+)\)', md.read_text(encoding='utf-8')):
            if '://' in target or target.startswith('#'):
                continue
            link_count += 1
            if not (md.parent / target.split('#')[0]).exists():
                errors.append({'file': label(md), 'kind': 'broken-link'})
    candidates = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=repo).decode().split('\0')
    count = 0
    confidential_ids, confidential_hashes, roots = set(), set(), []
    if args.private:
        private = Path(args.private).resolve()
        inventory = json.loads((private / 'source-inventory.json').read_text(encoding='utf-8'))
        confidential_ids = {r['id'] for r in inventory}
        confidential_hashes = {r['sha256'] for r in inventory}
        roots = [str(private), json.loads((private / 'provenance/source-location.json').read_text(encoding='utf-8'))['root']]
        for ref in manifest['entries']:
            record = json.loads((private / 'provenance' / pointer['releaseId'] / 'entries' / (ref['id'] + '.json')).read_text(encoding='utf-8'))
            if record['knowledgeSha256'] != ref['sha256']:
                errors.append({'file': ref['id'], 'kind': 'private-public-binding-mismatch'})
    for name in sorted(set(candidates)):
        if not name:
            continue
        path = repo / name
        if not path.is_file() or path.suffix.lower() not in {'.md', '.json', '.py', '.mjs', '.ts', '.tsx', '.txt', '.tap', '.yml', '.yaml'}:
            continue
        count += 1
        text = path.read_text(encoding='utf-8', errors='replace')
        if name.startswith('wiki/') and re.search(r'src-[a-f0-9]{16}|来源与使用身份', text):
            errors.append({'file': name, 'kind': 'source-identity-in-wiki'})
        if confidential_ids.intersection(re.findall(r'src-[a-f0-9]{16}', text)):
            errors.append({'file': name, 'kind': 'confidential-source-id'})
        if confidential_hashes.intersection(re.findall(r'\b[a-f0-9]{64}\b', text)):
            errors.append({'file': name, 'kind': 'confidential-source-hash'})
        normal = text.replace('\\\\', '\\').replace('\\', '/').casefold()
        if any(r.replace('\\', '/').casefold() in normal for r in roots):
            errors.append({'file': name, 'kind': 'confidential-location'})
    specs = [e for d in content['domains'] for e in d['entries']]
    report = {'releaseId': pointer['releaseId'], 'runtimeReleaseId': current['releaseId'],
              'runtimeIntegrity': 'passed' if not any(e['kind'].startswith('runtime-') for e in errors) else 'failed',
              'domains': len(manifest['domains']), 'entries': len(sizes),
              'termDefinitions': sum(len(e['terms']) for e in specs), 'illustrativeScenarios': sum(len(e['scenarios']) for e in specs),
              'markdownCharacters': {'min': min(sizes), 'max': max(sizes), 'total': sum(sizes)},
              'relativeLinksChecked': link_count, 'gitEligibleTextFilesScanned': count,
              'privateSourceLeakCheck': 'performed' if args.private else 'not-performed',
              'privateBindingsChecked': len(sizes) if args.private else 0, 'errors': errors}
    if args.output:
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    raise SystemExit(1 if errors else 0)


if __name__ == '__main__':
    main()
