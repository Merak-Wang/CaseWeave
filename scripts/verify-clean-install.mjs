import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
const pinnedDshVersion = '0.1.1-rc.2'
const tempRoot = mkdtempSync(join(tmpdir(), 'retrieval-agent-clean-install-'))

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function pnpm(args, cwd) {
  return run(packageManager.command, [...packageManager.prefix, ...args], { cwd })
}

function fileSpec(path) {
  return pathToFileURL(path).href
}

async function verifyWebStartup(dshBin, home, cwd) {
  const port = await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPromise(new Error('cannot allocate a local verification port'))
        return
      }
      server.close(error => error === undefined ? resolvePromise(address.port) : rejectPromise(error))
    })
  })
  await new Promise((resolvePromise, rejectPromise) => {
    let ready = false
    let routeVerified = false
    let routeError
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, [dshBin, '--profile', 'retrieval-agent', '--no-open', '--port', String(port)], {
      cwd,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(`clean DSH Web startup timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (!ready && stdout.includes(`http://127.0.0.1:${port}`)) {
        ready = true
        void fetch(`http://127.0.0.1:${port}/api/retrieval-agent/export`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
          body: JSON.stringify({ sessionId: 'missing-session', retrievalId: 'missing-retrieval', candidateRefs: [] }),
        }).then(async response => {
          const body = await response.text()
          if (response.status !== 409 || !body.includes('SESSION_NOT_ACTIVE')) {
            throw new Error(`Product Host route returned ${response.status}: ${body}`)
          }
          routeVerified = true
          child.kill('SIGTERM')
        }).catch(error => {
          routeError = error
          child.kill('SIGTERM')
        })
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (routeError !== undefined) rejectPromise(routeError)
      else if (ready && routeVerified) resolvePromise(undefined)
      else rejectPromise(new Error(`clean DSH Web exited before readiness (code=${String(code)}, signal=${String(signal)})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

try {
  const packs = join(tempRoot, 'packs')
  const runner = join(tempRoot, 'runner')
  const home = join(tempRoot, 'dsh-home')
  const profile = join(home, 'profiles', 'retrieval-agent')
  await mkdir(packs, { recursive: true })
  await mkdir(runner, { recursive: true })
  await mkdir(profile, { recursive: true })

  const tarballs = new Map()
  for (const entry of contract.packages) {
    const reportText = pnpm(['--filter', entry.name, 'pack', '--json', '--pack-destination', packs], root)
    const report = JSON.parse(reportText.slice(reportText.indexOf('{')))
    tarballs.set(entry.name, resolve(report.filename))
  }

  await writeFile(join(runner, 'package.json'), JSON.stringify({
    name: 'retrieval-agent-clean-dsh-runner',
    private: true,
    packageManager: 'pnpm@10.28.2',
    dependencies: { '@deepseek-ai/dsh': pinnedDshVersion },
  }, undefined, 2), 'utf8')
  pnpm(['install', '--ignore-scripts', '--frozen-lockfile=false'], runner)

  const firstPartyDependencies = Object.fromEntries(
    [...tarballs].map(([name, archive]) => [name, fileSpec(archive)]),
  )
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-retrieval-agent-clean-install',
    private: true,
    packageManager: 'pnpm@10.28.2',
    dependencies: firstPartyDependencies,
    pnpm: { overrides: firstPartyDependencies },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@retrieval-agent/bundle'] } },
  }, undefined, 2), 'utf8')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
  pnpm(['install', '--ignore-scripts', '--frozen-lockfile=false'], profile)

  const installer = join(profile, 'node_modules', '@retrieval-agent', 'bundle', 'lib', 'install-cli.js')
  const uninstaller = join(profile, 'node_modules', '@retrieval-agent', 'bundle', 'lib', 'uninstall-cli.js')
  run(process.execPath, [installer, '--home', home], { cwd: profile })

  const dshBin = join(runner, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const version = run(process.execPath, [dshBin, '--version'], { cwd: root }).trim()
  if (version !== pinnedDshVersion) throw new Error(`unexpected clean DSH version ${version}`)
  const config = run(process.execPath, [dshBin, '--profile', 'retrieval-agent', '--dump-config'], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
  })
  if (!config.includes('@retrieval-agent/ui-ticket-results')) throw new Error('composed DSH config is missing the candidate UI row')
  if (!config.includes('@retrieval-agent/product-host')) throw new Error('composed DSH config is missing the Product Host row')
  if (!/default:\s*['"]?retrieval-agent['"]?/u.test(config)) {
    const relevant = config.split(/\r?\n/u).filter(line => /agent-presets|retrieval-agent/u.test(line)).join('\n')
    throw new Error(`composed DSH config is missing the retrieval-agent default preset; relevant lines:\n${relevant}`)
  }

  const probe = join(profile, 'artifact-probe.mjs')
  await writeFile(probe, `
import { readFile } from 'node:fs/promises'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RetrievalId } from '@retrieval-agent/contracts'
import { foldRetrievalEvents, RetrievalController } from '@retrieval-agent/domain'
import { SessionRetrievalEventJournal } from '@retrieval-agent/agent-plugin'
import { installDshSessionCompatibility } from '@retrieval-agent/dsh-compat'
import { LocalTicketProvider, parseFixtureJsonl } from '@retrieval-agent/provider-local'
import { bundledFixturePath } from '@retrieval-agent/bundle/startup'

installDshSessionCompatibility()
const session = Session.create(SessionId('clean-install-session'))
if (session.id !== 'clean-install-session') throw new Error('DSH Session package did not load')
const now = new Date('2026-08-27T04:00:00.000Z')
const principal = {
  tenantId: 'demo', subjectId: 'demo-user', entitlementVersion: 'fixture-entitlements-v1',
  purpose: 'ticket_retrieval', attributes: { group: ['support'], region: ['cn'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}
const records = parseFixtureJsonl(await readFile(bundledFixturePath(), 'utf8'))
const provider = new LocalTicketProvider(records, { now: () => now })
let serial = 0
const nextId = () => 'clean-' + serial++
const journal = new SessionRetrievalEventJournal(session, { now: () => now, eventId: nextId })
const controller = new RetrievalController(provider, journal, undefined, { now: () => now, id: nextId })
let state = await controller.start(principal, { target: 'ranked_cases', query: '登录' })
state = await controller.search(principal, state)
if (state.candidates.length !== 2) throw new Error('packed vertical slice returned an unexpected candidate count')
if (journal.read(RetrievalId(state.retrievalId)).length === 0) throw new Error('packed event journal is empty')
const replayedSession = Session.create(SessionId('clean-install-replayed'), session.events)
const replayedEvents = new SessionRetrievalEventJournal(replayedSession).read(RetrievalId(state.retrievalId))
const replayedState = foldRetrievalEvents(replayedEvents)
if (replayedState === undefined || JSON.stringify(replayedState) !== JSON.stringify(state)) {
  throw new Error('packed DSH Session replay did not reconstruct the same retrieval state')
}
`, 'utf8')
  run(process.execPath, [probe], { cwd: profile })

  const installedPreset = await readFile(join(home, '.agent-presets', 'retrieval-agent', 'agent.cordis.yml'), 'utf8')
  if (!installedPreset.includes('@retrieval-agent/agent-plugin')) throw new Error('installed preset is incomplete')

  await verifyWebStartup(dshBin, home, root)

  const packageNames = contract.packages.map(entry => entry.name)
  run(process.execPath, [uninstaller, '--home', home], { cwd: profile })
  if (existsSync(join(home, '.agent-presets', 'retrieval-agent'))) throw new Error('preset assets remained after uninstall')
  if (existsSync(join(home, 'retrieval-agent'))) throw new Error('fixture assets remained after uninstall')
  run(process.execPath, [dshBin, 'plugin', '--profile', 'retrieval-agent', 'remove', ...packageNames], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
  })
  const afterRemove = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  if (afterRemove.dsh.profile.bundles.includes('@retrieval-agent/bundle')) throw new Error('bundle remained active after plugin removal')

  console.log(`clean install verified against published @deepseek-ai/dsh ${pinnedDshVersion}: pack, install, compose, Web startup, Host route, fixture search, Session replay, assets, remove`)
} finally {
  const resolvedTemp = resolve(tempRoot)
  const resolvedOsTemp = resolve(tmpdir())
  if (resolvedTemp.startsWith(`${resolvedOsTemp}${sep}`) && basename(resolvedTemp).startsWith('retrieval-agent-clean-install-')) {
    await rm(resolvedTemp, { recursive: true, force: true })
  } else {
    throw new Error(`refusing to clean unexpected temporary directory ${resolvedTemp}; relative=${relative(resolvedOsTemp, resolvedTemp)}`)
  }
}
