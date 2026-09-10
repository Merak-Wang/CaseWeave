import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
test('source audit rejects force-added internal material and keeps export empty', async () => {
  await mkdir(join(root, '.tmp'), { recursive: true })
  const fixture = await mkdtemp(join(root, '.tmp', 'source-audit-'))
  const git = args => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' })
  await mkdir(join(fixture, 'scripts'))
  await copyFile(join(root, 'scripts/verify-source.mjs'), join(fixture, 'scripts/verify-source.mjs'))
  await copyFile(join(root, '.gitignore'), join(fixture, '.gitignore'))
  await writeFile(join(fixture, 'README.md'), '# Product\n')
  await writeFile(join(fixture, '.env.example'), 'PORT=3080\n')
  git(['init', '--quiet'])
  let audit = spawnSync(process.execPath, ['scripts/verify-source.mjs'], { cwd: fixture, encoding: 'utf8' })
  assert.equal(audit.status, 0, audit.stderr)
  const privatePaths = ['asset/reference.docx', 'AGENTS.md', 'PLAN.md', 'docs/PUBLISHING.md', 'docs/VERIFICATION.md',
    'docs/design/EVOLUTION.md', 'docs/research/notes.md', 'docs/archive/old.md', 'docs/assets/prototype.png']
  for (const path of privatePaths) {
    await mkdir(dirname(join(fixture, path)), { recursive: true })
    await writeFile(join(fixture, path), 'local material\n')
    git(['check-ignore', '--quiet', path])
  }
  // Ignored local originals must not contaminate an ordinary source audit.
  audit = spawnSync(process.execPath, ['scripts/verify-source.mjs'], { cwd: fixture, encoding: 'utf8' })
  assert.equal(audit.status, 0, audit.stderr)
  git(['add', '--force', '--', ...privatePaths])
  audit = spawnSync(process.execPath, ['scripts/verify-source.mjs', '--export=.tmp/rejected-export'], { cwd: fixture, encoding: 'utf8' })
  assert.equal(audit.status, 1, audit.stderr)
  assert.deepEqual(JSON.parse(audit.stdout).problems.map(p => p.path).sort(), privatePaths.sort())
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(join(fixture, '.tmp/rejected-export')), false)
})
