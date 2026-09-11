import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = resolve(root, 'packages')
const contract = JSON.parse(await readFile(join(root, 'architecture', 'workspace.json'), 'utf8'))
const fallbackPnpmCli = process.platform === 'win32' && process.env.APPDATA !== undefined
  ? join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  : undefined
const pnpmCli = process.env.npm_execpath?.endsWith('.cjs') === true
  ? process.env.npm_execpath
  : fallbackPnpmCli !== undefined && existsSync(fallbackPnpmCli) ? fallbackPnpmCli : undefined
const packageManager = pnpmCli !== undefined
  ? { command: process.execPath, prefix: [pnpmCli] }
  : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] }
const failures = []
const manifests = new Map()
const packageByName = new Map(contract.packages.map(entry => [entry.name, entry]))
const prohibitedDependency = /(?:^|[-_/])(evals?|gold|judges?|simulators?|datasets?)(?:$|[-_/])/iu
const prohibitedPackedPath = /(?:^|\/)(?:tests?|evals?|datasets?|gold|judges?|simulators?)(?:\/|$)|\.spec\.[cm]?[jt]sx?$/iu
const pinnedDshVersion = '0.1.5-rc.2'

for (const entry of contract.packages) {
  const manifestPath = join(packagesRoot, entry.directory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifests.set(entry.name, manifest)
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (prohibitedDependency.test(name)) failures.push(`${entry.name}: prohibited production dependency ${name}`)
      if (name.startsWith('@deepseek-ai/dsh-experimental-')) failures.push(`${entry.name}: experimental DSH package is forbidden in the release closure: ${name}`)
      if (name.startsWith('@deepseek-ai/dsh-') && version !== pinnedDshVersion) {
        failures.push(`${entry.name}: ${name} must be pinned exactly to ${pinnedDshVersion}, got ${String(version)}`)
      }
    }
  }
}

const closure = new Set()
const queue = ['@retrieval-agent/bundle']
while (queue.length > 0) {
  const name = queue.shift()
  if (name === undefined || closure.has(name)) continue
  const manifest = manifests.get(name)
  if (manifest === undefined) {
    failures.push(`release closure references unknown first-party package ${name}`)
    continue
  }
  closure.add(name)
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (packageByName.has(dependency)) queue.push(dependency)
  }
}
const releaseEntries = contract.packages.filter(entry => closure.has(entry.name))

const tempRoot = mkdtempSync(join(tmpdir(), 'retrieval-agent-release-'))
try {
  for (const entry of releaseEntries) {
    let packOutput
    try {
      packOutput = execFileSync(packageManager.command, [...packageManager.prefix, '--filter', entry.name, 'pack', '--json', '--pack-destination', tempRoot], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      failures.push(`${entry.name}: pnpm pack failed: ${error.stderr?.toString().trim() ?? error.message}`)
      continue
    }
    let report
    try {
      report = JSON.parse(packOutput.slice(packOutput.indexOf('{')))
    } catch (error) {
      failures.push(`${entry.name}: cannot parse pnpm pack report: ${error.message}`)
      continue
    }
    const paths = report.files.map(file => String(file.path).replace(/\\/gu, '/'))
    for (const path of paths) if (prohibitedPackedPath.test(path)) failures.push(`${entry.name}: prohibited release artifact ${path}`)
    for (const required of ['package.json', 'README.md', 'lib/index.js', 'lib/index.d.ts']) {
      if (!paths.includes(required)) failures.push(`${entry.name}: packed artifact is missing ${required}`)
    }
    const sourceManifest = manifests.get(entry.name)
    if (sourceManifest.dsh?.client !== undefined) {
      const clientExport = sourceManifest.exports?.['./client']?.default
      if (typeof clientExport !== 'string') failures.push(`${entry.name}: dsh.client package must export ./client`)
      else if (!paths.includes(clientExport.replace(/^\.\//u, ''))) failures.push(`${entry.name}: packed artifact is missing DSH client bundle ${clientExport}`)
    }
    const archive = resolve(report.filename)
    if (relative(tempRoot, archive).startsWith(`..${sep}`)) {
      failures.push(`${entry.name}: pack output escaped the temporary directory`)
      continue
    }
    try {
      const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
      for (const section of ['dependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(packedManifest[section] ?? {})) {
          if (packageByName.has(name) && (String(version).startsWith('workspace:') || version !== manifests.get(name).version)) {
            failures.push(`${entry.name}: packed dependency ${name} was not rewritten to ${manifests.get(name).version}`)
          }
        }
      }
    } catch (error) {
      failures.push(`${entry.name}: cannot inspect packed package.json: ${error.message}`)
    }
  }
} finally {
  const resolvedTemp = resolve(tempRoot)
  const resolvedOsTemp = resolve(tmpdir())
  if (resolvedTemp.startsWith(`${resolvedOsTemp}${sep}`) && basename(resolvedTemp).startsWith('retrieval-agent-release-')) {
    await rm(resolvedTemp, { recursive: true, force: true })
  } else {
    failures.push(`refusing to clean unexpected temporary pack directory ${resolvedTemp}`)
  }
}

if (failures.length > 0) {
  console.error(failures.map(failure => `- ${failure}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`release closure verified: ${closure.size} packages, no test/eval/gold artifacts, DSH pinned to ${pinnedDshVersion}`)
}
