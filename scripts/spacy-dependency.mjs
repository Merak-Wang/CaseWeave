import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function inside(parent, child) {
  const path = relative(parent, child)
  return path.length > 0 && !path.startsWith('..') && !isAbsolute(path)
}

export async function loadSpacyDependency(projectRoot = process.cwd(), environment = process.env) {
  const manifest = JSON.parse(await readFile(resolve(projectRoot, 'architecture/model-manifest.json'), 'utf8'))
  const value = record(manifest.queryAnalysis)
  if (value?.engine !== 'spacy' || typeof value.engineVersion !== 'string'
    || value.pipeline !== 'zh_core_web_sm' || typeof value.pipelineVersion !== 'string'
    || typeof value.localPath !== 'string' || typeof value.domainLexiconPath !== 'string'
    || typeof value.pathEnvironment !== 'string') {
    throw new Error('model manifest queryAnalysis entry is invalid')
  }
  const declaredPath = resolve(projectRoot, value.localPath)
  const override = environment[value.pathEnvironment]?.trim()
  const modelPath = override === undefined || override.length === 0 ? declaredPath : resolve(projectRoot, override)
  if (override === undefined && !inside(resolve(projectRoot, 'models'), modelPath)) {
    throw new Error('spaCy pipeline localPath must stay under models/')
  }
  const lexiconPath = resolve(projectRoot, value.domainLexiconPath)
  if (!inside(projectRoot, lexiconPath) || !existsSync(lexiconPath)) {
    throw new Error('spaCy domain lexicon must be a versioned repository file')
  }
  return { ...value, modelPath, lexiconPath }
}

async function ready(dependency) {
  try {
    const meta = JSON.parse(await readFile(resolve(dependency.modelPath, 'meta.json'), 'utf8'))
    return meta.version === dependency.pipelineVersion
  } catch {
    return false
  }
}

export async function syncSpacyDependency(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd()
  const environment = options.environment ?? process.env
  const dependency = options.dependency ?? await loadSpacyDependency(projectRoot, environment)
  options.onProgress?.({ phase: 'checking', detail: dependency.modelPath })
  if (await ready(dependency)) {
    options.onProgress?.({ phase: 'reused', detail: dependency.modelPath })
    return { dependency, reused: true }
  }
  const command = environment.RETRIEVAL_AGENT_UV_COMMAND?.trim() || (process.platform === 'win32' ? 'uv.exe' : 'uv')
  options.onProgress?.({ phase: 'materializing', detail: `zh_core_web_sm ${dependency.pipelineVersion}` })
  execFileSync(command, [
    'run', '--frozen', '--project', 'python/model-service', '--group', 'runtime',
    'python', 'python/model-service/scripts/sync_spacy_model.py',
    '--destination', dependency.modelPath,
    '--expected-version', dependency.pipelineVersion,
  ], { cwd: projectRoot, env: environment, stdio: 'inherit' })
  if (!await ready(dependency)) throw new Error('spaCy pipeline synchronization did not produce the pinned model')
  options.onProgress?.({ phase: 'ready', detail: dependency.modelPath })
  return { dependency, reused: false }
}
