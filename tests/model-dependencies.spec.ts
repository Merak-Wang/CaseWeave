import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

interface Dependency {
  readonly id: string
  readonly active: boolean
  readonly targetPath: string
  readonly source: { readonly repoId: string; readonly revision: string }
  readonly files: readonly { readonly path: string; readonly absolutePath: string }[]
}

interface DependencyPlan {
  readonly dependencies: Record<string, Dependency>
  readonly roles: Record<string, {
    readonly model: string
    readonly revision: string
    readonly dependency: Dependency
  }>
}

interface ModelDependenciesModule {
  readonly parseModelDependencyManifest: (
    manifest: unknown,
    environment: Record<string, string>,
    projectRoot: string,
  ) => DependencyPlan
  readonly syncModelDependencies: (options: {
    readonly projectRoot: string
    readonly environment: Record<string, string>
    readonly plan: DependencyPlan
    readonly all?: boolean
    readonly roles?: readonly string[]
    readonly synchronize?: (dependency: Dependency) => Promise<void>
  }) => Promise<{ readonly downloaded: readonly string[]; readonly reused: readonly string[] }>
  readonly validateModelDependency: (dependency: Dependency) => Promise<{
    readonly ready: boolean
    readonly receiptReused: boolean
  }>
}

const createdDirectories: string[] = []
let models: ModelDependenciesModule

beforeAll(async () => {
  models = await import(pathToFileURL(resolve('scripts/model-dependencies.mjs')).href) as ModelDependenciesModule
})

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function fixtureManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    dependencies: {
      embedding: {
        source: { type: 'huggingface', repoId: 'test/embedding', revision: '1'.repeat(40) },
        localPath: 'models/embedding',
        pathEnvironment: 'EMBEDDING_PATH',
        activation: { type: 'always' },
        files: [
          { path: 'model.safetensors', sha256: checksum('model.safetensors') },
          { path: 'config.json' },
        ],
      },
      reranker: {
        source: { type: 'huggingface', repoId: 'test/reranker', revision: '2'.repeat(40) },
        localPath: 'models/reranker',
        activation: { type: 'environment', variable: 'ENABLE_RERANKER', values: ['true'] },
        files: [{ path: 'model.safetensors', sha256: checksum('model.safetensors') }],
      },
    },
    embedding: { dependency: 'embedding' },
    reranker: { dependency: 'reranker' },
  }
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`test fixture is missing ${label}`)
  return value
}

describe('declarative model dependencies', () => {
  it('uses the versioned manifest as the identity source for runtime roles and the preset', async () => {
    const projectRoot = process.cwd()
    const manifest = JSON.parse(await readFile(join(projectRoot, 'architecture/model-manifest.json'), 'utf8'))
    const plan = models.parseModelDependencyManifest(manifest, {}, projectRoot)
    const embedding = required(plan.roles.embedding, 'embedding role')
    const reranker = required(plan.roles.reranker, 'reranker role')

    expect(embedding.dependency.active).toBe(true)
    expect(reranker.dependency.active).toBe(false)
    expect(embedding.dependency.targetPath).toBe(resolve('models/Qwen3-Embedding-0.6B'))
    expect(reranker.revision).toBe('e61197ed45024b0ed8a2d74b80b4d909f1255473')

    const preset = await readFile('packages/bundle/presets/retrieval-agent/agent.cordis.yml', 'utf8')
    expect(preset).toContain("name: '@retrieval-agent/bundle/agent'")
    expect(preset).not.toContain("name: '@retrieval-agent/agent-plugin'")
    expect(preset).toContain(`embeddingModel: ${embedding.model}`)
    expect(preset).toContain(`embeddingRevision: ${embedding.revision}`)
    expect(preset).toContain(`rerankerModel: ${reranker.model}`)
    expect(preset).toContain(`rerankerRevision: ${reranker.revision}`)
    expect(preset).toContain("rerankerEnabled: !!js process.env.RETRIEVAL_AGENT_RERANKER_ENABLED === 'true'")
  })

  it('activates optional dependencies from the manifest and honors explicit path overrides', () => {
    const projectRoot = resolve('model-dependency-fixture')
    const plan = models.parseModelDependencyManifest(fixtureManifest(), {
      ENABLE_RERANKER: 'TRUE',
      EMBEDDING_PATH: 'external/embedding',
    }, projectRoot)

    const embedding = required(plan.dependencies.embedding, 'embedding dependency')
    const reranker = required(plan.dependencies.reranker, 'reranker dependency')
    expect(embedding.active).toBe(true)
    expect(embedding.targetPath).toBe(resolve(projectRoot, 'external/embedding'))
    expect(reranker.active).toBe(true)
  })

  it('downloads every active missing dependency through one generic synchronization path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'retrieval-agent-model-dependencies-'))
    createdDirectories.push(projectRoot)
    const environment = { ENABLE_RERANKER: 'true' }
    const plan = models.parseModelDependencyManifest(fixtureManifest(), environment, projectRoot)

    const result = await models.syncModelDependencies({
      projectRoot,
      environment,
      plan,
      synchronize: async dependency => {
        for (const file of dependency.files) {
          await mkdir(dirname(file.absolutePath), { recursive: true })
          await writeFile(file.absolutePath, file.path, 'utf8')
        }
      },
    })

    expect(result.downloaded).toEqual(['embedding', 'reranker'])
    expect(result.reused).toEqual([])
  })

  it('validates declared checksums and reuses a local identity receipt', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'retrieval-agent-model-receipt-'))
    createdDirectories.push(projectRoot)
    const plan = models.parseModelDependencyManifest(fixtureManifest(), {}, projectRoot)
    const dependency = required(plan.dependencies.embedding, 'embedding dependency')
    for (const file of dependency.files) {
      await mkdir(dirname(file.absolutePath), { recursive: true })
      await writeFile(file.absolutePath, file.path, 'utf8')
    }

    expect(await models.validateModelDependency(dependency)).toMatchObject({ ready: true, receiptReused: false })
    expect(await models.validateModelDependency(dependency)).toMatchObject({ ready: true, receiptReused: true })

    await writeFile(required(dependency.files[0], 'embedding weight').absolutePath, 'tampered', 'utf8')
    await expect(models.validateModelDependency(dependency)).rejects.toThrow(/invalid SHA-256/u)
  })

  it('can explicitly prefetch inactive optional dependencies', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'retrieval-agent-model-all-'))
    createdDirectories.push(projectRoot)
    const plan = models.parseModelDependencyManifest(fixtureManifest(), {}, projectRoot)

    const result = await models.syncModelDependencies({
      projectRoot,
      environment: {},
      plan,
      all: true,
      synchronize: async dependency => {
        for (const file of dependency.files) {
          await mkdir(dirname(file.absolutePath), { recursive: true })
          await writeFile(file.absolutePath, file.path, 'utf8')
        }
      },
    })

    expect(result.downloaded).toEqual(['embedding', 'reranker'])
  })

  it('can add one inactive runtime role without selecting unrelated future dependencies', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'retrieval-agent-model-role-'))
    createdDirectories.push(projectRoot)
    const plan = models.parseModelDependencyManifest(fixtureManifest(), {}, projectRoot)

    const result = await models.syncModelDependencies({
      projectRoot,
      environment: {},
      plan,
      roles: ['reranker'],
      synchronize: async dependency => {
        for (const file of dependency.files) {
          await mkdir(dirname(file.absolutePath), { recursive: true })
          await writeFile(file.absolutePath, file.path, 'utf8')
        }
      },
    })

    expect(result.downloaded).toEqual(['embedding', 'reranker'])
    await expect(models.syncModelDependencies({
      projectRoot,
      environment: {},
      plan,
      roles: ['future-role'],
    })).rejects.toThrow(/unknown model runtime role/u)
  })

  it('rejects manifest paths that could write outside the ignored models directory', () => {
    const manifest = fixtureManifest()
    const dependencies = manifest.dependencies as Record<string, Record<string, unknown>>
    required(dependencies.embedding, 'embedding declaration').localPath = '../outside-models'

    expect(() => models.parseModelDependencyManifest(manifest, {}, process.cwd())).toThrow(/escape|under models/u)
  })
})
