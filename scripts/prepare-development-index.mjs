import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseTicketDatasetJsonl, rankingDocuments } from '@retrieval-agent/provider-local'
import { HybridRankingEngine } from '@retrieval-agent/model-service-client/ranking'
import { bundledDefaultTicketPaths, bundledFixtureRoot } from '@retrieval-agent/bundle/startup'
import { loadModelDependencyManifest } from './model-dependencies.mjs'
import { resolveIndexPreparationConfig } from './index-preparation-config.mjs'
import { createStartupProgressReporter } from './startup-progress.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const developmentVectorCacheDir = join(root, '.cache', 'retrieval-agent-vectors')

function enabled(value) {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/** Build the development-admin, unfiltered corpus matrix before Web accepts traffic. */
export async function prepareDevelopmentIndex(options = {}) {
  const environment = options.environment ?? process.env
  const configured = resolveIndexPreparationConfig(environment)
  const manifest = (await loadModelDependencyManifest(root, environment)).roles
  const datasetManifest = JSON.parse(await readFile(join(bundledFixtureRoot(), 'manifest.json'), 'utf8'))
  const profile = datasetManifest.ticketProfiles[datasetManifest.defaultTicketProfile]
  const dataPath = options.dataPath ?? environment.RETRIEVAL_AGENT_DATA_PATH
  const records = (await Promise.all((dataPath ? [resolve(dataPath)] : bundledDefaultTicketPaths())
    .map(async path => parseTicketDatasetJsonl(await readFile(path, 'utf8'))))).flat()
  if (!dataPath && records.length !== profile.recordCount) {
    throw new Error(`development corpus manifest expected ${profile.recordCount} records, got ${records.length}`)
  }

  const baseUrl = options.modelServiceBaseUrl
    ?? environment.RETRIEVAL_AGENT_MODEL_SERVICE_URL
    ?? 'http://127.0.0.1:8012'
  const cacheDir = options.cacheDir ?? developmentVectorCacheDir
  const rerankerEnabled = options.rerankerEnabled
    ?? enabled(environment.RETRIEVAL_AGENT_RERANKER_ENABLED)
  const engine = new HybridRankingEngine({
    baseUrl,
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
    preparePollIntervalMs: options.pollIntervalMs ?? configured.pollIntervalMs,
  })
  const prepared = await engine.prepare(rankingDocuments(records), {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  })
  return { ...prepared, cacheDir, datasetId: dataPath ? environment.RETRIEVAL_AGENT_DATASET_ID ?? 'custom' : datasetManifest.defaultTicketProfile, rerankerEnabled, modelServiceBaseUrl: baseUrl }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const progress = createStartupProgressReporter()
  progress.stage('Vector index', 'checking/resuming development corpus')
  const prepared = await prepareDevelopmentIndex({
    onProgress: value => progress.preparation('Vector index', value),
  })
  progress.complete('Vector index', `${prepared.documentCount} documents ready`)
  progress.close()
  console.log(JSON.stringify({ status: 'ready', ...prepared }))
}
