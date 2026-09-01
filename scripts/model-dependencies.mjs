import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

const dependencyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const environmentNamePattern = /^[A-Z][A-Z0-9_]*$/u
const revisionPattern = /^[0-9a-f]{40}$/u
const sha256Pattern = /^[0-9a-f]{64}$/u
const receiptName = '.retrieval-agent-dependency.json'

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function enabled(value, defaultValue = false) {
  if (value === undefined) return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function assertRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`)
  }
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '..' || part === '.' || part.length === 0)) {
    throw new Error(`${label} must not escape its declared directory`)
  }
  return normalized
}

function inside(parent, child) {
  const path = relative(parent, child)
  return path.length > 0 && !path.startsWith('..') && !isAbsolute(path)
}

function active(activation, environment, label) {
  if (activation?.type === 'always') return true
  if (activation?.type !== 'environment'
    || typeof activation.variable !== 'string'
    || !environmentNamePattern.test(activation.variable)
    || !Array.isArray(activation.values)
    || activation.values.length === 0
    || !activation.values.every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error(`${label}.activation is invalid`)
  }
  const value = environment[activation.variable]
  return value !== undefined && activation.values.map(item => item.toLowerCase()).includes(value.trim().toLowerCase())
}

export function parseModelDependencyManifest(manifest, environment = process.env, projectRoot = process.cwd()) {
  if (record(manifest) === undefined || manifest.schemaVersion !== 2) {
    throw new Error('model dependency manifest must use schemaVersion 2')
  }
  const declared = record(manifest.dependencies)
  if (declared === undefined || Object.keys(declared).length === 0) {
    throw new Error('model dependency manifest declares no dependencies')
  }
  const modelsRoot = resolve(projectRoot, 'models')
  const dependencies = Object.create(null)
  for (const [id, raw] of Object.entries(declared)) {
    const label = `model dependency ${id}`
    const value = record(raw)
    const source = record(value?.source)
    if (!dependencyIdPattern.test(id) || value === undefined || source?.type !== 'huggingface'
      || typeof source.repoId !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(source.repoId)
      || typeof source.revision !== 'string' || !revisionPattern.test(source.revision)) {
      throw new Error(`${label} must pin a Hugging Face repo and immutable 40-character revision`)
    }
    const localPath = assertRelativePath(value.localPath, `${label}.localPath`)
    const declaredTarget = resolve(projectRoot, localPath)
    if (!inside(modelsRoot, declaredTarget)) throw new Error(`${label}.localPath must stay under models/`)
    const pathEnvironment = value.pathEnvironment
    if (pathEnvironment !== undefined
      && (typeof pathEnvironment !== 'string' || !environmentNamePattern.test(pathEnvironment))) {
      throw new Error(`${label}.pathEnvironment is invalid`)
    }
    const override = pathEnvironment === undefined ? undefined : environment[pathEnvironment]?.trim()
    const targetPath = override === undefined || override.length === 0 ? declaredTarget : resolve(projectRoot, override)
    if (!Array.isArray(value.files) || value.files.length === 0) throw new Error(`${label}.files is empty`)
    const seen = new Set()
    const files = value.files.map((rawFile, index) => {
      const file = record(rawFile)
      const path = assertRelativePath(file?.path, `${label}.files[${index}].path`)
      if (seen.has(path)) throw new Error(`${label} repeats required file ${path}`)
      seen.add(path)
      if (file.sha256 !== undefined
        && (typeof file.sha256 !== 'string' || !sha256Pattern.test(file.sha256))) {
        throw new Error(`${label}.files[${index}].sha256 is invalid`)
      }
      return { path, sha256: file.sha256, absolutePath: resolve(targetPath, path) }
    })
    dependencies[id] = {
      id,
      source: { type: 'huggingface', repoId: source.repoId, revision: source.revision },
      targetPath,
      pathEnvironment,
      files,
      active: active(record(value.activation), environment, label),
    }
  }

  const roles = {}
  for (const role of ['embedding', 'reranker']) {
    const runtime = record(manifest[role])
    const dependencyId = runtime?.dependency
    if (typeof dependencyId !== 'string' || dependencies[dependencyId] === undefined) {
      throw new Error(`model runtime role ${role} references an unknown dependency`)
    }
    roles[role] = {
      ...runtime,
      model: dependencies[dependencyId].source.repoId,
      revision: dependencies[dependencyId].source.revision,
      dependency: dependencies[dependencyId],
    }
  }
  return { schemaVersion: 2, dependencies, roles, source: manifest }
}

export async function loadModelDependencyManifest(projectRoot = process.cwd(), environment = process.env) {
  const path = join(projectRoot, 'architecture', 'model-manifest.json')
  return parseModelDependencyManifest(JSON.parse(await readFile(path, 'utf8')), environment, projectRoot)
}

export function missingModelDependencyFiles(dependency) {
  return dependency.files.filter(file => !existsSync(file.absolutePath))
}

function receiptPath(dependency) {
  return join(dependency.targetPath, receiptName)
}

async function readReceipt(dependency) {
  try {
    return record(JSON.parse(await readFile(receiptPath(dependency), 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

function receiptMatchesDependency(receipt, dependency) {
  return receipt?.schemaVersion === 1
    && receipt.dependency === dependency.id
    && receipt.repoId === dependency.source.repoId
    && receipt.revision === dependency.source.revision
    && record(receipt.files) !== undefined
}

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

export async function validateModelDependency(dependency) {
  const missing = missingModelDependencyFiles(dependency)
  if (missing.length > 0) {
    return { ready: false, missing, receiptReused: false }
  }

  const previous = await readReceipt(dependency)
  const canReuseReceipt = receiptMatchesDependency(previous, dependency)
  const files = {}
  let receiptReused = canReuseReceipt
  for (const file of dependency.files) {
    const metadata = await stat(file.absolutePath)
    const cached = canReuseReceipt ? record(previous.files[file.path]) : undefined
    const cachedIdentityMatches = cached?.sha256 === file.sha256
      && cached?.size === metadata.size
      && cached?.mtimeMs === metadata.mtimeMs
    if (file.sha256 !== undefined && !cachedIdentityMatches) {
      const actual = await sha256(file.absolutePath)
      if (actual !== file.sha256) {
        throw new Error(`${dependency.id} has an invalid SHA-256 for ${file.path}; remove the invalid file and synchronize the pinned dependency again`)
      }
      receiptReused = false
    } else if (!cachedIdentityMatches) {
      receiptReused = false
    }
    files[file.path] = {
      sha256: file.sha256,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    }
  }

  if (!receiptReused) {
    await mkdir(dependency.targetPath, { recursive: true })
    await writeFile(receiptPath(dependency), `${JSON.stringify({
      schemaVersion: 1,
      dependency: dependency.id,
      repoId: dependency.source.repoId,
      revision: dependency.source.revision,
      files,
    }, null, 2)}\n`, 'utf8')
  }
  return { ready: true, missing: [], receiptReused }
}

function uvCommand(environment) {
  return environment.RETRIEVAL_AGENT_UV_COMMAND?.trim() || (process.platform === 'win32' ? 'uv.exe' : 'uv')
}

function syncOne(dependency, projectRoot, environment) {
  const args = [
    'run', '--frozen', '--project', 'python/model-service', '--group', 'runtime',
    'python', 'python/model-service/scripts/download_model.py',
    '--repo-id', dependency.source.repoId,
    '--revision', dependency.source.revision,
    '--destination', dependency.targetPath,
  ]
  for (const file of dependency.files) {
    args.push('--file', file.sha256 === undefined ? file.path : `${file.path}=${file.sha256}`)
  }
  execFileSync(uvCommand(environment), args, {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
  })
}

export async function syncModelDependencies(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd()
  const environment = options.environment ?? process.env
  const plan = options.plan ?? await loadModelDependencyManifest(projectRoot, environment)
  const requested = new Set()
  for (const role of options.roles ?? []) {
    const runtime = plan.roles[role]
    if (runtime === undefined) throw new Error(`unknown model runtime role ${role}`)
    requested.add(runtime.dependency.id)
  }
  const activeDependencies = Object.values(plan.dependencies).filter(dependency => (
    options.all === true || dependency.active || requested.has(dependency.id)
  ))
  const downloaded = []
  const reused = []
  for (const dependency of activeDependencies) {
    const initial = await validateModelDependency(dependency)
    if (initial.ready) {
      reused.push(dependency.id)
      continue
    }
    if (!enabled(environment.RETRIEVAL_AGENT_AUTO_DOWNLOAD_MODEL, true)) {
      throw new Error(`${dependency.id} is missing ${initial.missing.map(file => file.path).join(', ')} under ${dependency.targetPath}; enable automatic model downloads or provide the pinned files`)
    }
    console.log(`Synchronizing model dependency ${dependency.id} from ${dependency.source.repoId}@${dependency.source.revision}...`)
    const synchronize = options.synchronize ?? syncOne
    await synchronize(dependency, projectRoot, environment)
    const completed = await validateModelDependency(dependency)
    if (!completed.ready) {
      throw new Error(`${dependency.id} synchronization completed without ${completed.missing.map(file => file.path).join(', ')}`)
    }
    downloaded.push(dependency.id)
  }
  return { plan, downloaded, reused }
}
