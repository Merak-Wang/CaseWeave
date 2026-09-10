import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const destination = args.find(a => a.startsWith('--export='))?.slice(9)
if (args.some(a => !a.startsWith('--export='))) throw new Error('Usage: verify-source.mjs [--export=NEW_DIRECTORY]')
const paths = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort()
const files = [], problems = []
const forbidden = /(^|\/)(?:node_modules|models|output|\.cache|\.tmp|\.venv|sessions|\.private|__pycache__)(\/|$)|(^|\/)\.env(?:\..+)?$|(?:^|\/)\.credentials\.yaml$/u
const internal = /^(?:asset\/|(?:AGENTS|PLAN)\.md$|docs\/(?:PUBLISHING\.md$|VERIFICATION\.md$|BASELINE\.md$|CODEX_INSTRUCTIONS\.md$|DSH_CHANGE_CLASSIFICATION\.md$|PROJECT_REVIEW\.md$|design\/EVOLUTION\.md$|(?:research|archive|adr|reviews|assets|replan-[^/]+)\/))/u
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/u
for (const path of paths) {
  const absolute = resolve(root, path)
  const info = await lstat(absolute).catch(e => { if (e.code !== 'ENOENT') throw e })
  if (!info) continue // Preserve the current working tree's intentional deletions.
  if (!info.isFile()) { problems.push({ path, reason: 'source entry is not a regular file' }); continue }
  if (forbidden.test(path) && path !== '.env.example') problems.push({ path, reason: 'private/runtime file selected for Git' })
  if (internal.test(path)) problems.push({ path, reason: 'local reference or internal working record selected for Git' })
  if (info.size > 50 * 1024 * 1024) problems.push({ path, reason: 'file exceeds 50 MiB source limit' })
  const bytes = await readFile(absolute)
  if (!bytes.includes(0) && secret.test(bytes.toString('utf8'))) problems.push({ path, reason: 'credential-shaped value; inspect locally (value withheld)' })
  files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const report = { schemaVersion: 1, scope: 'current Git-selectable working tree, including untracked source; no Git history rewrite', files: files.length,
  bytes: files.reduce((n, f) => n + f.bytes, 0), treeHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), problems }
await mkdir(resolve(root, 'output/github-acceptance'), { recursive: true })
await writeFile(resolve(root, 'output/github-acceptance/source-audit.json'), JSON.stringify({ ...report, inventory: files }, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (problems.length) process.exitCode = 1
else if (destination) {
  const target = resolve(destination), rel = relative(root, target)
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(`.tmp${sep}`))) throw new Error('Export must be outside the source tree or below its ignored .tmp directory')
  // A fresh directory prevents old ignored files from contaminating the acceptance tree.
  await mkdir(target)
  for (const file of files) { const output = resolve(target, file.path); await mkdir(dirname(output), { recursive: true }); await copyFile(resolve(root, file.path), output) }
  console.log(`Exported ${files.length} source files to ${target}; no dependencies, models, data downloads, credentials or sessions were copied.`)
}
