import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function containerConfig(environment = process.env, projectRoot = root) {
  const device = environment.RETRIEVAL_AGENT_MODEL_CONTAINER_DEVICE ?? 'cpu'
  if (!['cpu', 'gpu'].includes(device)) throw new Error('MODEL_CONTAINER_DEVICE must be cpu or gpu')
  const url = new URL(environment.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? `http://127.0.0.1:${environment.RETRIEVAL_AGENT_MODEL_PORT ?? '8012'}`)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Container mode requires a loopback HTTP MODEL_SERVICE_URL without path or credentials')
  }
  const port = url.port || '80'
  if (environment.RETRIEVAL_AGENT_MODEL_PORT && environment.RETRIEVAL_AGENT_MODEL_PORT !== port) {
    throw new Error('MODEL_PORT and MODEL_SERVICE_URL port disagree')
  }
  const timeoutMs = Number(environment.RETRIEVAL_AGENT_MODEL_START_TIMEOUT_MS ?? 600_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('MODEL_START_TIMEOUT_MS must be at least 1000')
  const files = ['config/database/compose.yml', 'config/model-service/compose.yml',
    ...(device === 'gpu' ? ['config/model-service/compose.gpu.yml'] : [])]
  return { device, url: url.origin, timeoutMs,
    image: environment.RETRIEVAL_AGENT_MODEL_IMAGE ?? 'retrieval-agent-model-service:0.1.0-cu128',
    args: ['compose', ...files.flatMap(file => ['-f', resolve(projectRoot, file)])],
    environment: { ...environment, RETRIEVAL_AGENT_MODEL_PORT: port } }
}

export function assertExternalEtcd(container) {
  if (container?.Config?.Env?.some(value => /^ETCD_USE_EMBED=true$/i.test(value))) {
    throw new Error('Existing Milvus still owns embedded etcd. Run docker compose -f config/database/compose.yml stop milvus, then pnpm db:up before --with-database. Existing data volumes are retained.')
  }
}

function docker(args, environment, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn('docker', args, { cwd: root, env: environment, windowsHide: true,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] })
    let output = ''; let errors = ''
    child.stdout?.on('data', chunk => { output += chunk })
    child.stderr?.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? accept(output.trim()) : reject(new Error(`docker ${args.slice(0, 2).join(' ')} failed (${code}) ${errors.trim()}`)))
  })
}

async function containerState(config) {
  const id = await docker([...config.args, 'ps', '-a', '-q', 'model-service'], config.environment, true)
  if (!id) return undefined
  return JSON.parse(await docker(['inspect', id], config.environment, true))[0]
}

export async function ensureContainerService(environment = process.env, projectRoot = root, onProgress = console.log) {
  const config = containerConfig(environment, projectRoot)
  // --no-build / --pull never make preparation an explicit operation. Docker owns the service.
  await docker([...config.args, 'up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'model-service'], config.environment)
  const started = Date.now()
  let lastMessage = ''
  while (Date.now() - started < config.timeoutMs) {
    const container = await containerState(config)
    const state = container?.State
    const phase = state?.Health?.Status ?? state?.Status ?? 'missing'
    if (phase !== lastMessage) { onProgress(`Model container: ${phase} (${config.device}, ${config.url})`); lastMessage = phase }
    if (!state || state.Status === 'exited' || state.Status === 'dead' || state.Status === 'restarting' || phase === 'unhealthy') {
      await docker([...config.args, 'logs', '--tail', '40', 'model-service'], config.environment)
      throw new Error(`Model container failed (${phase}); run pnpm model:container prepare --import=PATH or --download, then up. Host Python fallback is disabled.`)
    }
    if (phase === 'healthy') {
      const response = await fetch(`${config.url}/health/ready`, { signal: AbortSignal.timeout(5_000) })
      const body = await response.json()
      if (!response.ok || body.ready !== true || (config.device === 'gpu' ? !body.device?.startsWith('cuda') : body.device !== 'cpu')) {
        throw new Error('Container health or requested device does not match the HTTP model service')
      }
      return { child: undefined, owned: false }
    }
    await delay(1_000)
  }
  await docker([...config.args, 'logs', '--tail', '40', 'model-service'], config.environment)
  throw new Error('Model container readiness deadline exceeded; inspect model:container logs/status. Host Python fallback is disabled.')
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const [command = 'help', ...options] = argv
  const env = { ...environment }
  let importRoot; let download = false; let database = false
  for (const option of options) {
    if (option.startsWith('--device=')) env.RETRIEVAL_AGENT_MODEL_CONTAINER_DEVICE = option.slice(9)
    else if (option.startsWith('--import=')) importRoot = resolve(option.slice(9))
    else if (option === '--download') download = true
    else if (option === '--with-database') database = true
    else throw new Error(`Unknown model:container option ${option}`)
  }
  if (command === 'help' || command === '--help') {
    console.log('model:container build | prepare [--import=PATH] [--download] | up [--with-database] [--device=cpu|gpu] | stop | restart | status | logs | check\nBuild and prepare are explicit. stop only stops model-service and preserves all volumes. CPU is the default; GPU must be selected explicitly.'); return
  }
  const config = containerConfig(env)
  if (command === 'build') await docker([...config.args, 'build', 'model-service'], config.environment)
  else if (command === 'prepare') {
    if (importRoot && !existsSync(importRoot)) throw new Error(`Model import directory is missing: ${importRoot}`)
    await docker(['image', 'inspect', config.image], config.environment, true)
    await docker([...config.args, 'run', '--rm', '--no-deps', '--pull', 'never',
      ...(importRoot ? ['--volume', `${importRoot}:/import:ro`] : []), 'model-prepare', 'prepare',
      ...(importRoot ? ['--import-root', '/import'] : []), ...(download ? ['--download'] : [])], config.environment)
  } else if (command === 'up' || command === 'restart') {
    if (database) {
      const id = await docker([...config.args, 'ps', '-a', '-q', 'milvus'], config.environment, true)
      if (id) assertExternalEtcd(JSON.parse(await docker(['inspect', id], config.environment, true))[0])
      await docker([...config.args, 'up', '-d', '--no-recreate', 'mysql', 'milvus'], config.environment)
    }
    if (command === 'restart') await docker([...config.args, 'restart', 'model-service'], config.environment)
    await ensureContainerService(env)
  } else if (command === 'stop') await docker([...config.args, 'stop', 'model-service'], config.environment)
  else if (command === 'status') await docker([...config.args, 'ps', '-a'], config.environment)
  else if (command === 'logs') await docker([...config.args, 'logs', '--tail', '100', 'model-service'], config.environment)
  else if (command === 'check') {
    await docker(['image', 'inspect', config.image], config.environment, true)
    await docker([...config.args, 'run', '--rm', '--no-deps', '--pull', 'never', 'model-prepare', 'check'], config.environment)
  }
  else throw new Error(`Unknown model:container command ${command}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
