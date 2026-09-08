"""Compile reviewed claims, not source documents, into an immutable Wiki release."""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def put(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode('utf-8'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True)
    ap.add_argument('--private', required=True)
    ap.add_argument('--wiki', default=str(Path(__file__).resolve().parent.parent / 'wiki'))
    args = ap.parse_args()
    root, private, out = map(lambda p: Path(p).resolve(), (args.source, args.private, args.wiki))
    if any((parent / '.git').exists() for parent in [private, *private.parents]):
        raise SystemExit('Confidential private directory must be outside every Git worktree')
    for a, b in [(root, out), (private, out), (root, private)]:
        if a == b or a in b.parents or b in a.parents:
            raise SystemExit('Source, private intake and published Wiki must be disjoint')
    inventory = json.loads((private / 'source-inventory.json').read_text(encoding='utf-8'))
    by_id = {r['id']: r for r in inventory}
    curation = json.loads((out / 'curation.json').read_text(encoding='utf-8'))
    if curation['schemaVersion'] != 2:
        raise SystemExit('Curation must use the source-free v2 schema')
    provenance = private / 'provenance'
    source_map = json.loads((provenance / 'curation-sources.json').read_text(encoding='utf-8'))['entries']
    release_id = curation['releaseId']
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,90}', release_id):
        raise SystemExit('Invalid release ID')
    if (out / 'current.json').exists():
        current = json.loads((out / 'current.json').read_text(encoding='utf-8'))
        if current.get('releaseId') != release_id:
            raise SystemExit('Initial import cannot replace a newer publication; publish a file delta')
    entries, domains, decisions, private_records = [], [], {}, []
    for d in curation['domains']:
        refs = []
        for spec in d['entries']:
            eid = d['id'] + '-' + spec['slug']
            if not re.fullmatch(r'[a-z][a-z0-9-]{1,90}', eid):
                raise SystemExit('Invalid entry ID')
            if 'sources' in spec or 'sourceRefs' in spec:
                raise SystemExit('Confidential source refs must be external')
            refs.append(eid)
            citations = []
            for sid, start, end in source_map[eid]:
                rec = by_id[sid]
                source = (root / rec['path']).resolve()
                if root not in source.parents:
                    raise ValueError('Source escapes intake root')
                data = source.read_bytes()
                if sha(data) != rec['sha256']:
                    raise ValueError('Source changed; repeat intake and evidence review')
                if not (1 <= start <= end <= len(data.decode('utf-8-sig').splitlines())):
                    raise ValueError('Invalid evidence line span: ' + sid)
                citations.append({'id': sid, 'sha256': rec['sha256'], 'lines': [start, end], 'tier': 'secondary-wiki'})
                decisions.setdefault(sid, []).append(eid)
            body = '# ' + spec['title'] + '\n\n'
            body += '## 业务知识\n\n### 专有名词与业务对象\n\n'
            body += '\n\n'.join('**' + term + '**：' + meaning for term, meaning in spec['terms']) + '\n\n'
            body += '### 业务关系与判断逻辑\n\n' + '\n\n'.join(spec['facts']) + '\n\n'
            body += '### 典型业务场景\n\n以下为帮助理解的示例，不是真实工单或实际发生记录。\n\n'
            body += '\n\n'.join(str(n) + '. ' + text for n, text in enumerate(spec['scenarios'], 1)) + '\n\n'
            body += '## 工单中应核对的证据\n\n' + '\n'.join('- ' + x for x in spec['checks']) + '\n\n'
            body += '## 适用边界与反例\n\n' + '\n\n'.join('- ' + x for x in spec['counterexamples'] + spec['limits']) + '\n'
            entry = {'schemaVersion': 2, 'id': eid, 'revision': curation['revision'], 'domain': d['id'],
                     'title': spec['title'], 'kind': 'retrieval-prior', 'status': 'active',
                     'authority': 'reviewed-business-prior', 'isTicketEvidence': False,
                     'scope': d['title'] + '相关工单；仅在快查后作为可否定的检索与取证先验。',
                     'keywords': spec['keywords'], 'bodyMarkdown': body, 'evidenceChecklist': spec['checks'],
                     'limitations': spec['counterexamples'] + spec['limits'], 'supersedes': []}
            entries.append(entry)
            private_record = {'schemaVersion': 2, 'releaseId': release_id, 'knowledgeId': eid,
                              'revision': entry['revision'], 'knowledgeSha256': sha(encoded(entry)),
                              'authority': 'imported-secondary-wiki', 'primaryAuthorityVerified': False,
                              'sourceRefs': [{**s, 'path': by_id[s['id']]['path']} for s in citations],
                              'sectionBasis': {'terms': 'Explanatory paraphrases of business objects; not new policy.',
                                               'facts': 'Source-grounded synthesis with explicit conflicts and limitations.',
                                               'scenarios': 'Illustrative constructions, not observed cases.',
                                               'checksAndCounterexamples': 'Retrieval implications and boundary reasoning; not operational instructions.'}}
            private_records.append(private_record)
        domains.append({'id': d['id'], 'title': d['title'], 'knowledgeRefs': refs})
    # Validate every emitted model-visible field before publication. Source prose is never copied.
    if len({e['id'] for e in entries}) != len(entries) or len({d['id'] for d in domains}) != len(domains):
        raise SystemExit('Duplicate identity')
    with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as f:
        tmp = Path(f.name)
        f.write(encoded(entries))
    try:
        module = (Path(__file__).parent / 'wiki-store.mjs').resolve().as_uri()
        code = "import {readFileSync} from 'node:fs'; const {validateEntry}=await import(process.argv[1]); JSON.parse(readFileSync(process.argv[2],'utf8')).forEach(validateEntry)"
        subprocess.run(['node', '--input-type=module', '-e', code, module, str(tmp)], check=True)
    finally:
        tmp.unlink(missing_ok=True)
    release = out / 'releases' / release_id
    entry_refs = [{'id': e['id'], 'sha256': sha(encoded(e))} for e in entries]
    manifest = {'schemaVersion': 2, 'releaseId': release_id, 'baseRelease': curation.get('baseRelease'),
                'kind': 'reviewed-offline-import', 'domains': domains, 'entries': entry_refs,
                'validation': {'schema': 'passed', 'contentGate': 'passed', 'sourceHashesAndLines': 'passed',
                               'agentQuality': 'not-evaluated', 'primarySourceAuthority': 'not-verified'}}
    manifest_bytes = encoded(manifest)
    for record in private_records:
        existing = provenance / release_id / 'entries' / (record['knowledgeId'] + '.json')
        if existing.exists() and existing.read_bytes() != encoded(record):
            raise SystemExit('Private provenance is immutable; choose a new releaseId')
    if release.exists():
        if (release / 'manifest.json').read_bytes() != manifest_bytes:
            raise SystemExit('Release is immutable; choose a new releaseId')
        for e in entries:
            if (release / 'entries' / (e['id'] + '.json')).read_bytes() != encoded(e):
                raise SystemExit('Existing release corrupted; do not overwrite evidence')
    else:
        for e in entries:
            put(release / 'entries' / (e['id'] + '.json'), encoded(e))
        put(release / 'manifest.json', manifest_bytes)
    for record in private_records:
        put(provenance / release_id / 'entries' / (record['knowledgeId'] + '.json'), encoded(record))
    for d in domains:
        expert = {'schemaVersion': 1, 'id': d['id'], 'domain': d['id'], 'description': d['title'],
                  'activationPhase': 'post-fast-query', 'authority': 'reference-data-only',
                  'knowledgeRefs': d['knowledgeRefs'], 'toolGrants': [], 'promptOverride': None,
                  'outputRequirements': ['区分先验与工单证据', '引用实际可见工单片段', '列出歧义及反例', '不修改用户条件']}
        put(out / 'domains' / d['id'] / 'expert.json', encoded(expert))
        index = '# ' + d['title'] + '\n\n' + '\n'.join('- [' + e['title'] + '](concepts/' + e['id'] + '.md)' for e in entries if e['domain'] == d['id']) + '\n'
        put(out / 'domains' / d['id'] / 'index.md', index)
    for e in entries:
        put(out / 'domains' / e['domain'] / 'concepts' / (e['id'] + '.md'), e['bodyMarkdown'])
    # All original-source identities and hashes remain outside the Git workspace.
    sources = [{'id': sid, 'path': by_id[sid]['path'], 'sha256': by_id[sid]['sha256'], 'tier': 'secondary-wiki',
                'authorityVerified': False, 'entries': sorted(set(ids))} for sid, ids in sorted(decisions.items())]
    put(provenance / 'source-catalog.json', encoded({'schemaVersion': 1, 'sources': sources}))
    put(provenance / 'source-location.json', encoded({'root': str(root)}))
    private_index = '# 私有知识来源管理\n\n此目录在项目仓库之外，不参与 Git；不挂载给运行时知识工具。\n\n'
    private_index += '当前追溯版本：' + release_id + '。按知识条目 ID 和 revision 关联；knowledgeSha256 绑定实际发布 JSON。\n\n'
    private_index += '- [来源总表](source-catalog.json)\n- [原库位置](source-location.json)\n- [编辑映射](curation-sources.json)\n\n'
    private_index += '术语为业务对象的解释性改写；场景明确为构造示例，不是真实工单；证据要求和反例为检索推论，不是企业操作指令。\n\n'
    for d in domains:
        private_index += '## ' + d['title'] + '\n\n'
        private_index += '\n'.join('- [' + e['title'] + '](' + release_id + '/entries/' + e['id'] + '.json)' for e in entries if e['domain'] == d['id']) + '\n\n'
    put(provenance / 'README.md', private_index)
    review_ledger = []
    for rec in inventory:
        used = decisions.get(rec['id'], [])
        disposition = 'claims-extracted-source-withheld' if used else ('not-promoted-no-selected-claim' if rec['disposition'] == 'review-candidate' else 'withheld')
        review_ledger.append({**rec, 'finalDisposition': disposition, 'publishedEntries': used})
    put(private / 'disposition-ledger.json', encoded(review_ledger))
    risk_counts = Counter(signal for r in inventory for signal in r.get('riskSignals', []))
    stats = {'sourceFiles': len(inventory), 'reviewCandidateFiles': sum(r['disposition'] == 'review-candidate' for r in inventory),
             'citedSecondaryFiles': len(sources), 'domains': len(domains), 'entries': len(entries),
             'sourceFilesCopied': 0, 'sourceAttachmentsPublished': 0,
             'dispositions': dict(Counter(r['finalDisposition'] for r in review_ledger)), 'riskSignalFileCounts': dict(risk_counts),
             'limitations': ['Not every source attachment was semantically read; all excluded from runtime.',
                             'Risk signals are screening matches, not confirmed secret counts.',
                             'No real Agent retrieval quality evaluation or DSH integration claimed.']}
    put(provenance / release_id / 'import-report.json', encoded(stats))
    put(out / 'release-report.json', encoded({'schemaVersion': 2, 'releaseId': release_id,
        'domains': len(domains), 'entries': len(entries), 'sourceMetadataPublished': False,
        'agentQuality': 'not-evaluated'}))
    put(private / 'build-record.json', encoded({'recordedAt': datetime.now(timezone.utc).isoformat(), 'releaseId': release_id, 'manifestSha256': sha(manifest_bytes), **stats}))
    # Share the online publisher's exclusive lock and recheck current at the actual commit boundary.
    subprocess.run(['node', str(Path(__file__).with_name('wiki-store.mjs')), 'activate-import',
                    '--wiki', str(out), '--release', release_id], check=True, capture_output=True)
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == '__main__':
    main()
