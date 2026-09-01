import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  loadModelDependencyManifest,
  syncModelDependencies,
} from './model-dependencies.mjs'
import { seedModelSettings } from './local-settings.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleName = '@retrieval-agent/bundle'
const webProfile = 'web'

function enabled(value, defaultValue = false) {
  if (value === undefined) return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

export function normalizedRerankerFlag(value) {
  return enabled(value) ? 'true' : 'false'
}

function packageManager() {
  const fallbackPnpmCli = process.platform === 'win32' && process.env.APPDATA !== undefined
    ? join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    : undefined
  const pnpmCli = process.env.npm_execpath?.endsWith('.cjs') === true
    ? process.env.npm_execpath
    : fallbackPnpmCli !== undefined && existsSync(fallbackPnpmCli) ? fallbackPnpmCli : undefined
  return pnpmCli === undefined
    ? { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] }
    : { command: process.execPath, prefix: [pnpmCli] }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function runPnpm(args, cwd, stdio = 'inherit') {
  const manager = packageManager()
  return run(manager.command, [...manager.prefix, ...args], { cwd, stdio })
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export function parseCliArgs(argv) {
  const [first, ...rest] = argv
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help', forwardedArgs: [] }
  }
  if (first === 'setup') return { command: 'setup', forwardedArgs: rest }
  if (first === 'models') return { command: 'models', forwardedArgs: rest }
  if (first === 'web') return { command: 'web', forwardedArgs: rest }
  throw new Error(`unknown command ${first}; expected setup, models or web`)
}

export function parseModelSyncArgs(args) {
  let all = false
  const roles = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--all') {
      if (all) throw new Error('models accepts --all only once')
      all = true
      continue
    }
    if (argument === '--role') {
      const role = args[index + 1]
      if (role === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(role)) {
        throw new Error('models --role requires a model runtime role name')
      }
      if (roles.includes(role)) throw new Error(`models repeats runtime role ${role}`)
      roles.push(role)
      index += 1
      continue
    }
    throw new Error(`unknown models option ${String(argument)}`)
  }
  if (all && roles.length > 0) throw new Error('models cannot combine --all with --role')
  return { all, roles }
}

export function resolveLocalAppPaths(environment = process.env, projectRoot = root) {
  const stateRoot = resolve(projectRoot, environment.RETRIEVAL_AGENT_LOCAL_STATE_DIR ?? '.cache/retrieval-agent-local')
  const dshHome = resolve(projectRoot, environment.RETRIEVAL_AGENT_DSH_HOME ?? join(stateRoot, 'dsh-home'))
  const vectorCacheDir = resolve(projectRoot, environment.RETRIEVAL_AGENT_VECTOR_CACHE_DIR ?? '.cache/retrieval-agent-vectors')
  return {
    root: projectRoot,
    stateRoot,
    runtimeRoot: join(stateRoot, 'runtime'),
    runnerRoot: join(stateRoot, 'runtime', 'dsh-runner'),
    dshHome,
    profileRoot: join(dshHome, 'profiles', webProfile),
    vectorCacheDir,
    bundleRoot: join(projectRoot, 'packages', 'bundle'),
    modelServiceBaseUrl: environment.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012',
  }
}

export function profileSetupAction(manifest, bundleRoot, profileRoot) {
  if (manifest === undefined) return 'initialize'
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)
    || !bundles.includes('@deepseek-ai/dsh-base')
    || !bundles.includes('@deepseek-ai/dsh-web-app')) {
    return 'invalid'
  }
  const dependency = manifest.dependencies?.[bundleName]
  if (!bundles.includes(bundleName) || typeof dependency !== 'string' || !dependency.startsWith('link:')) return 'link'
  const requested = dependency.slice('link:'.length)
  const target = resolve(profileRoot, requested)
  return target === resolve(bundleRoot) ? 'reuse' : 'link'
}

export function modelServiceAction({ ready, manage, baseUrl }) {
  if (ready) return 'reuse'
  const url = new URL(baseUrl)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!manage || url.protocol !== 'http:' || !loopback || (url.pathname !== '' && url.pathname !== '/')) return 'unavailable'
  return 'start'
}

export function helpText() {
  return `Retrieval Agent source launcher

Usage:
  pnpm retrieval-agent setup
  pnpm retrieval-agent models [--all | --role <role>]
  pnpm retrieval-agent web [DSH Web options]

Source checkout:
  pnpm install --frozen-lockfile --ignore-scripts
  pnpm build                 # once, and again only after source changes
  pnpm retrieval-agent web   # reuses built artifacts, profile and vector cache

Aliases:
  pnpm start
  pnpm app:serve
  pnpm models:sync

Options after "web" are forwarded to DSH, for example --no-open or --port 3080.
Requires Node.js, pnpm and uv. The first run installs pinned DSH and synchronizes
active, pinned model dependencies that are not already present under models/.
Use "models --all" to prefetch optional dependencies as well.
Use "models --role reranker" to prefetch one runtime role and its required defaults.
It never runs a product build, pack, clean-install verification or uninstall.
`
}

async function assertBuilt(paths) {
  const contract = await readJson(join(paths.root, 'architecture', 'workspace.json'))
  const missing = []
  for (const entry of contract.packages) {
    const packageRoot = join(paths.root, 'packages', entry.directory)
    const manifest = await readJson(join(packageRoot, 'package.json'))
    const main = manifest.main ?? 'lib/index.js'
    if (!existsSync(join(packageRoot, main))) missing.push(`${entry.name}:${main}`)
    if (manifest.dsh?.client !== undefined && !existsSync(join(packageRoot, 'lib', 'client.js'))) {
      missing.push(`${entry.name}:lib/client.js`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`built artifacts are missing (${missing.join(', ')}). Run "pnpm build" once before starting the app.`)
  }
}

async function pinnedDshVersion(paths) {
  const provenance = await readJson(join(paths.root, 'provenance', 'baseline-manifest.json'))
  const version = provenance.dsh?.declaredVersion
  if (typeof version !== 'string' || version.length === 0) throw new Error('baseline manifest does not declare a DSH version')
  return version
}

async function ensureDshRuntime(paths) {
  const version = await pinnedDshVersion(paths)
  const dshBin = join(paths.runnerRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(dshBin)) {
    const installed = run(process.execPath, [dshBin, '--version'], { cwd: paths.root }).trim()
    if (installed === version) return { dshBin, version, installed: false }
  }

  await mkdir(paths.runnerRoot, { recursive: true })
  await writeFile(join(paths.runnerRoot, 'package.json'), `${JSON.stringify({
    name: 'retrieval-agent-local-dsh-runner',
    private: true,
    packageManager: 'pnpm@10.28.2',
    dependencies: { '@deepseek-ai/dsh': version },
  }, undefined, 2)}\n`, 'utf8')
  console.log(`Installing the pinned DSH ${version} runtime once in ${relative(paths.root, paths.runnerRoot)}...`)
  runPnpm(['install', '--ignore-workspace', '--ignore-scripts', '--frozen-lockfile=false'], paths.runnerRoot)
  if (!existsSync(dshBin)) throw new Error(`DSH installation completed without ${dshBin}`)
  const installed = run(process.execPath, [dshBin, '--version'], { cwd: paths.root }).trim()
  if (installed !== version) throw new Error(`expected DSH ${version}, installed ${installed}`)
  return { dshBin, version, installed: true }
}

async function readProfileManifest(paths) {
  const path = join(paths.profileRoot, 'package.json')
  if (!existsSync(path)) return undefined
  return await readJson(path)
}

async function ensureProfile(paths, dshBin, environment) {
  await mkdir(paths.dshHome, { recursive: true })
  const dshEnvironment = {
    ...environment,
    DSH_HOME: paths.dshHome,
    DSH_TELEMETRY_DISABLED: environment.DSH_TELEMETRY_DISABLED ?? '1',
  }
  let manifest = await readProfileManifest(paths)
  let action = profileSetupAction(manifest, paths.bundleRoot, paths.profileRoot)
  if (action === 'initialize') {
    run(process.execPath, [dshBin, 'web', '--dump-default-config'], {
      cwd: paths.root,
      env: dshEnvironment,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    manifest = await readProfileManifest(paths)
    action = profileSetupAction(manifest, paths.bundleRoot, paths.profileRoot)
  }
  if (action === 'invalid') {
    throw new Error(`the local ${webProfile} profile does not contain the DSH Base + Web bundles: ${paths.profileRoot}`)
  }
  if (action === 'link') {
    console.log('Linking the built Retrieval Agent workspace bundle into the persistent DSH profile...')
    run(process.execPath, [dshBin, 'plugin', '--profile', webProfile, 'add', paths.bundleRoot], {
      cwd: paths.root,
      env: dshEnvironment,
      stdio: 'inherit',
    })
  }
  const config = run(process.execPath, [dshBin, 'web', '--dump-config'], {
    cwd: paths.root,
    env: dshEnvironment,
  })
  for (const required of ['@retrieval-agent/product-host', '@retrieval-agent/ui-ticket-results', '@retrieval-agent/ui-product-shell']) {
    if (!config.includes(required)) throw new Error(`persistent DSH profile is missing ${required}`)
  }
  return { linked: action === 'link', environment: dshEnvironment }
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await filesUnder(path))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

async function assetFingerprint(paths) {
  const roots = [join(paths.bundleRoot, 'presets'), join(paths.bundleRoot, 'fixtures')]
  const files = (await Promise.all(roots.map(filesUnder))).flat().sort()
  const hash = createHash('sha256')
  for (const path of files) {
    hash.update(relative(paths.bundleRoot, path).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(await readFile(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function ensureAssets(paths) {
  const fingerprint = await assetFingerprint(paths)
  const receiptPath = join(paths.dshHome, 'retrieval-agent', 'local-source-install.json')
  const installedPreset = join(paths.dshHome, '.agent-presets', 'retrieval-agent', 'agent.cordis.yml')
  const installedManifest = join(paths.dshHome, 'retrieval-agent', 'data', 'manifest.json')
  if (existsSync(receiptPath) && existsSync(installedPreset) && existsSync(installedManifest)) {
    const receipt = await readJson(receiptPath)
    if (receipt.schemaVersion === 1 && receipt.assetFingerprint === fingerprint) return false
  }
  const installer = join(paths.bundleRoot, 'lib', 'install-cli.js')
  run(process.execPath, [installer, '--home', paths.dshHome, '--force'], { cwd: paths.root })
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, `${JSON.stringify({
    schemaVersion: 1,
    assetFingerprint: fingerprint,
    installedAt: new Date().toISOString(),
    sourceRoot: paths.root,
  }, undefined, 2)}\n`, 'utf8')
  return true
}

export async function setupLocalApp(options = {}) {
  const environment = options.environment ?? process.env
  const paths = resolveLocalAppPaths(environment, options.projectRoot ?? root)
  await assertBuilt(paths)
  const runtime = await ensureDshRuntime(paths)
  const profile = await ensureProfile(paths, runtime.dshBin, environment)
  const assetsUpdated = await ensureAssets(paths)
  const settingsUpdated = await seedModelSettings(paths, environment)
  return { paths, runtime, profile, assetsUpdated, settingsUpdated }
}

async function modelServiceReady(baseUrl) {
  try {
    const response = await fetch(new URL('/health/ready', baseUrl), { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return false
    const body = await response.json()
    return body.ready === true
  } catch {
    return false
  }
}

function spawnModelService(paths, environment, modelPlan) {
  const url = new URL(paths.modelServiceBaseUrl)
  const host = url.hostname === '[::1]' ? '::1' : url.hostname
  const port = url.port.length > 0 ? url.port : '80'
  const args = [
    'run', '--frozen', '--project', 'python/model-service', '--group', 'runtime', 'retrieval-agent-model-service',
    '--manifest', 'architecture/model-manifest.json',
    '--embedding-path', modelPlan.roles.embedding.dependency.targetPath,
    '--host', host,
    '--port', port,
    '--exit-on-stdin-close',
  ]
  if (enabled(environment.RETRIEVAL_AGENT_RERANKER_ENABLED)) {
    args.push('--reranker-path', modelPlan.roles.reranker.dependency.targetPath, '--enable-reranker')
  }
  const device = environment.RETRIEVAL_AGENT_MODEL_DEVICE?.trim()
  if (device !== undefined && device.length > 0) args.push('--device', device)
  const command = environment.RETRIEVAL_AGENT_UV_COMMAND?.trim() || (process.platform === 'win32' ? 'uv.exe' : 'uv')
  console.log(`Starting the local retrieval model service at ${paths.modelServiceBaseUrl}...`)
  return spawn(command, args, {
    cwd: paths.root,
    env: environment,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  })
}

function childExit(child, kind) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => resolvePromise({ kind, code, signal }))
  })
}

async function waitForModelService(paths, child, deadlineMs) {
  const started = performance.now()
  while (performance.now() - started < deadlineMs) {
    if (child !== undefined && child.exitCode !== null) {
      throw new Error(`local model service exited before readiness with code ${child.exitCode}`)
    }
    if (await modelServiceReady(paths.modelServiceBaseUrl)) return
    await wait(500)
  }
  throw new Error(`model service did not become ready within ${deadlineMs} ms: ${paths.modelServiceBaseUrl}`)
}

async function stopChild(child) {
  if (child === undefined || child.exitCode !== null) return
  child.stdin?.end()
  child.kill('SIGTERM')
  const exited = childExit(child, 'stopped')
  await Promise.race([exited, wait(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function ensureModelService(paths, environment) {
  const ready = await modelServiceReady(paths.modelServiceBaseUrl)
  if (ready) return { child: undefined, owned: false }
  const modelPlan = await loadModelDependencyManifest(paths.root, environment)
  const action = modelServiceAction({
    ready,
    manage: enabled(environment.RETRIEVAL_AGENT_MANAGE_MODEL_SERVICE, true),
    baseUrl: paths.modelServiceBaseUrl,
  })
  if (action === 'unavailable') {
    throw new Error(`model service is not ready at ${paths.modelServiceBaseUrl}; only an unavailable loopback HTTP service can be started automatically`)
  }
  await syncModelDependencies({ projectRoot: paths.root, environment, plan: modelPlan })
  const child = spawnModelService(paths, environment, modelPlan)
  try {
    const deadline = Number(environment.RETRIEVAL_AGENT_MODEL_STARTUP_DEADLINE_MS ?? 300_000)
    await waitForModelService(paths, child, Number.isFinite(deadline) && deadline > 0 ? deadline : 300_000)
    return { child, owned: true }
  } catch (error) {
    await stopChild(child)
    throw error
  }
}

async function prepareIndex(paths) {
  const { prepareDevelopmentIndex } = await import('./prepare-development-index.mjs')
  console.log('Preparing or reusing the persistent 2,040-ticket vector index...')
  const prepared = await prepareDevelopmentIndex({
    cacheDir: paths.vectorCacheDir,
    modelServiceBaseUrl: paths.modelServiceBaseUrl,
  })
  console.log(`Retrieval index ready: ${prepared.documentCount} documents, ${Math.round(prepared.elapsedMs)} ms`)
}

export async function runLocalWeb(forwardedArgs = [], options = {}) {
  const environment = options.environment ?? process.env
  const setup = await setupLocalApp({ environment, projectRoot: options.projectRoot ?? root })
  const { paths } = setup
  const model = await ensureModelService(paths, environment)
  try {
    await prepareIndex(paths)
  } catch (error) {
    if (model.owned) await stopChild(model.child)
    throw error
  }

  const childEnvironment = {
    ...environment,
    DSH_HOME: paths.dshHome,
    DSH_TELEMETRY_DISABLED: environment.DSH_TELEMETRY_DISABLED ?? '1',
    RETRIEVAL_AGENT_MODEL_SERVICE_URL: paths.modelServiceBaseUrl,
    RETRIEVAL_AGENT_VECTOR_CACHE_DIR: paths.vectorCacheDir,
    RETRIEVAL_AGENT_RERANKER_ENABLED: normalizedRerankerFlag(environment.RETRIEVAL_AGENT_RERANKER_ENABLED),
  }
  console.log(`Starting Retrieval Agent with persistent state in ${relative(paths.root, paths.dshHome)}...`)
  const dsh = spawn(process.execPath, [setup.runtime.dshBin, 'web', ...forwardedArgs], {
    cwd: paths.root,
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  })
  let stopping = false
  const stop = () => {
    stopping = true
    if (dsh.exitCode === null) dsh.kill('SIGTERM')
    if (model.owned && model.child?.exitCode === null) {
      model.child.stdin?.end()
      model.child.kill('SIGTERM')
    }
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const dshExit = childExit(dsh, 'dsh')
    const first = model.owned
      ? await Promise.race([dshExit, childExit(model.child, 'model')])
      : await dshExit
    if (first.kind === 'model' && !stopping) {
      await stopChild(dsh)
      throw new Error(`managed model service exited while DSH was running (code=${String(first.code)}, signal=${String(first.signal)})`)
    }
    if (first.kind === 'dsh' && first.code !== 0 && !stopping) {
      throw new Error(`DSH Web exited with code ${String(first.code)} and signal ${String(first.signal)}`)
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    if (model.owned) await stopChild(model.child)
    if (dsh.exitCode === null) await stopChild(dsh)
  }
}

export async function runCli(argv, options = {}) {
  const parsed = parseCliArgs(argv)
  if (parsed.command === 'help') {
    process.stdout.write(helpText())
    return
  }
  if (parsed.command === 'setup') {
    if (parsed.forwardedArgs.length > 0) throw new Error('setup does not accept positional arguments')
    const result = await setupLocalApp(options)
    console.log(`Retrieval Agent local profile ready: ${result.paths.dshHome}`)
    return
  }
  if (parsed.command === 'models') {
    const selection = parseModelSyncArgs(parsed.forwardedArgs)
    const environment = options.environment ?? process.env
    const result = await syncModelDependencies({
      projectRoot: options.projectRoot ?? root,
      environment,
      ...selection,
    })
    console.log(`Model dependencies ready: ${[...result.reused, ...result.downloaded].join(', ')}`)
    return
  }
  await runLocalWeb(parsed.forwardedArgs, options)
}
