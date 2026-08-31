import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModelServiceClient, ModelServiceClientError } from '@retrieval-agent/model-service-client'
import { parseTicketDatasetJsonl, rankingDocuments } from '@retrieval-agent/provider-local'
import { HybridRankingEngine } from '@retrieval-agent/retrieval-ranking'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(root, 'packages', 'bundle', 'fixtures')
export const developmentVectorCacheDir = join(root, '.cache', 'retrieval-agent-vectors')

function enabled(value) {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function retryableStartupFailure(error) {
  return error instanceof ModelServiceClientError
    && error.retryable
    && ['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'BACKPRESSURE', 'HTTP_ERROR'].includes(error.code)
}

async function prepareWithReadinessRetry(engine, documents, options) {
  const started = performance.now()
  const totalDeadlineMs = options.startupDeadlineMs ?? 300_000
  let delayMs = options.initialRetryDelayMs ?? 500
  while (true) {
    try {
      return await engine.prepare(documents, options.signal === undefined ? {} : { signal: options.signal })
    } catch (error) {
      const elapsedMs = performance.now() - started
      if (!retryableStartupFailure(error) || elapsedMs + delayMs >= totalDeadlineMs) throw error
      await wait(delayMs, undefined, options.signal === undefined ? {} : { signal: options.signal })
      delayMs = Math.min(delayMs * 2, 5_000)
    }
  }
}

/** Build the development-admin, unfiltered corpus matrix before Web accepts traffic. */
export async function prepareDevelopmentIndex(options = {}) {
  const manifest = JSON.parse(await readFile(join(root, 'architecture', 'model-manifest.json'), 'utf8'))
  const datasetManifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'))
  const records = (await Promise.all([
    'tickets.jsonl',
    'public/fcc-1000-seed-20260825.jsonl',
    'public/bitext-1000-seed-20260825.jsonl',
  ].map(async path => parseTicketDatasetJsonl(await readFile(join(fixtureRoot, path), 'utf8'))))).flat()
  if (records.length !== datasetManifest.recordCount) {
    throw new Error(`development corpus manifest expected ${datasetManifest.recordCount} records, got ${records.length}`)
  }

  const baseUrl = options.modelServiceBaseUrl
    ?? process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL
    ?? 'http://127.0.0.1:8012'
  const cacheDir = options.cacheDir ?? developmentVectorCacheDir
  const rerankerEnabled = options.rerankerEnabled
    ?? enabled(process.env.RETRIEVAL_AGENT_RERANKER_ENABLED)
  const gateway = new ModelServiceClient({
    baseUrl,
    embeddingModel: manifest.embedding.model,
    embeddingRevision: manifest.embedding.revision,
    embeddingDimensions: manifest.embedding.dimensions,
    ...(rerankerEnabled ? {
      rerankerModel: manifest.reranker.model,
      rerankerRevision: manifest.reranker.revision,
    } : {}),
    defaultDeadlineMs: options.deadlineMs ?? 120_000,
  })
  const engine = new HybridRankingEngine({
    gateway,
    cacheDir,
    embeddingIdentity: {
      model: manifest.embedding.model,
      revision: manifest.embedding.revision,
      dimensions: manifest.embedding.dimensions,
    },
    embeddingInstruction: manifest.embedding.queryInstruction,
    ...(rerankerEnabled ? {
      rerankerIdentity: {
        model: manifest.reranker.model,
        revision: manifest.reranker.revision,
      },
      rerankerEnabled: true,
    } : {}),
    modelDeadlineMs: options.deadlineMs ?? 120_000,
  })
  const prepared = await prepareWithReadinessRetry(engine, rankingDocuments(records), options)
  return { ...prepared, cacheDir, datasetId: datasetManifest.datasetId, rerankerEnabled, modelServiceBaseUrl: baseUrl }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const prepared = await prepareDevelopmentIndex()
  console.log(JSON.stringify({ status: 'ready', ...prepared }))
}
