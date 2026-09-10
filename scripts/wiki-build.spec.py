"""Confidential-source separation through the real offline compiler and reader."""
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


class PublicationTests(unittest.TestCase):
    def test_private_mapping_public_reader_and_immutable_provenance(self):
        with tempfile.TemporaryDirectory(prefix='wiki-compile-test-') as temp:
            base = Path(temp)
            source, private, wiki = [base / name for name in ('source', 'private', 'wiki')]
            for p in (source, private / 'provenance', wiki):
                p.mkdir(parents=True)
            raw = ('synthetic confidential source\n' * 8).encode()
            (source / 'confidential.md').write_bytes(raw)
            sid = 'src-aaaaaaaaaaaaaaaa'
            sh = hashlib.sha256(raw).hexdigest()
            def write(p, data):
                p.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
            write(private / 'source-inventory.json', [{'id': sid, 'path': 'confidential.md', 'sha256': sh, 'disposition': 'review-candidate'}])
            mapping = {'schemaVersion': 1, 'entries': {'demo-entry': [[sid, 1, 3]]}}
            write(private / 'provenance/curation-sources.json', mapping)
            curation = {'schemaVersion': 2, 'releaseId': 'demo-v2', 'baseRelease': None, 'revision': 2,
                'domains': [{'id': 'demo', 'title': '费用辨析', 'entries': [{
                    'slug': 'entry', 'title': '应收与实收', 'keywords': ['应收'],
                    'terms': [['应收', '系统提出的收费安排。']],
                    'facts': ['应收不代表实际收款。'], 'scenarios': ['显示费用但尚无支付结果。'],
                    'checks': ['核对支付结果与费用对象。'], 'counterexamples': ['只有显示金额不足以证明支付。'],
                    'limits': ['仅作检索先验。']}]}]}
            write(wiki / 'curation.json', curation)
            command = ['python', str(SCRIPTS / 'build-retrieval-wiki.py'), '--source', str(source), '--private', str(private), '--wiki', str(wiki)]
            result = subprocess.run(command, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            public = '\n'.join(p.read_text(encoding='utf-8') for p in wiki.rglob('*') if p.is_file())
            for secret in (sid, sh, 'confidential.md', str(source), '来源与使用身份', 'sourceRefs'):
                self.assertNotIn(secret, public)
            record = private / 'provenance/demo-v2/entries/demo-entry.json'
            original_record = record.read_bytes()
            provenance = json.loads(original_record)
            entry_file = wiki / 'releases/demo-v2/entries/demo-entry.json'
            self.assertEqual(provenance['knowledgeSha256'], hashlib.sha256(entry_file.read_bytes()).hexdigest())
            self.assertEqual(provenance['sourceRefs'][0]['sha256'], sh)
            # The public reader needs neither the source nor private directory.
            moved = base / 'private-unavailable'
            private.rename(moved)
            result = subprocess.run(['node', str(SCRIPTS / 'wiki-store.mjs'), 'read', '--wiki', str(wiki), '--id', 'demo-entry'], capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertNotIn(sid.encode(), result.stdout)
            moved.rename(private)
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            old_pointer = (wiki / 'current.json').read_bytes()
            mapping['entries']['demo-entry'][0][2] = 4
            write(private / 'provenance/curation-sources.json', mapping)
            result = subprocess.run(command, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'Private provenance is immutable', result.stderr)
            self.assertEqual(record.read_bytes(), original_record)
            self.assertEqual((wiki / 'current.json').read_bytes(), old_pointer)
            mapping['entries']['demo-entry'][0][2] = 3
            write(private / 'provenance/curation-sources.json', mapping)
            draft = base / 'edit.json'
            subprocess.run(['node', str(SCRIPTS / 'wiki-store.mjs'), 'checkout', '--wiki', str(wiki), '--id', 'demo-entry', '--out', str(draft)], check=True, capture_output=True)
            edited = json.loads(draft.read_text(encoding='utf-8'))
            edited['changes'][0]['entry']['scope'] = '修改后的费用复核范围。'
            edited['changes'][0]['entry']['bodyMarkdown'] += '\n补充范围：核对实际收款证据。\n'
            write(draft, edited)
            subprocess.run(['node', str(SCRIPTS / 'wiki-store.mjs'), 'publish', '--wiki', str(wiki), '--delta', str(draft)], check=True, capture_output=True)
            published_pointer = (wiki / 'current.json').read_bytes()
            audit = ['python', str(SCRIPTS / 'verify-wiki-artifacts.py'), '--wiki', str(wiki)]
            result = subprocess.run(audit, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace') + result.stdout.decode(errors='replace'))
            report = json.loads(result.stdout)
            self.assertEqual(report['releaseId'], 'demo-v2')
            self.assertEqual(report['runtimeReleaseId'], json.loads(published_pointer)['releaseId'])
            self.assertEqual(report['runtimeIntegrity'], 'passed')
            markdown = wiki / 'domains/demo/concepts/demo-entry.md'
            original_markdown = markdown.read_bytes()
            markdown.write_text('unexpected change', encoding='utf-8')
            result = subprocess.run(audit, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('markdown-release-mismatch', result.stdout.decode())
            markdown.write_bytes(original_markdown)
            runtime_entry = wiki / 'releases' / report['runtimeReleaseId'] / 'entries/demo-entry.json'
            original_runtime_entry = runtime_entry.read_bytes()
            runtime_entry.write_text('{}', encoding='utf-8')
            result = subprocess.run(audit, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['runtimeIntegrity'], 'failed')
            runtime_entry.write_bytes(original_runtime_entry)
            result = subprocess.run(command, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'cannot replace a newer publication', result.stderr)
            self.assertEqual((wiki / 'current.json').read_bytes(), published_pointer)

    def test_intake_and_compiler_reject_private_directory_in_git(self):
        with tempfile.TemporaryDirectory(prefix='wiki-git-test-') as temp:
            root = Path(temp)
            (root / '.git').mkdir()
            for name in ('wiki-intake.py', 'build-retrieval-wiki.py'):
                result = subprocess.run(['python', str(SCRIPTS / name), '--source', str(root / 'source'), '--private', str(root / 'private')], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'outside every Git worktree', result.stderr)
                self.assertFalse((root / 'private').exists())


if __name__ == '__main__':
    unittest.main()
