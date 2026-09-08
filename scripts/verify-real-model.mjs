import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { ModelServiceClient } from '@retrieval-agent/model-service-client'
import { parseTicketDatasetJsonl, rankingDocuments } from '@retrieval-agent/provider-local'
import { HybridRankingEngine } from '@retrieval-agent/model-service-client/ranking'
import { bundledDefaultTicketPaths } from '@retrieval-agent/bundle/startup'
import { loadModelDependencyManifest } from './model-dependencies.mjs'

// Actual inference/transport smoke. Semantic Agent judgments and Recall use the independent public acceptance driver.
const rerankerEnabled = process.argv.includes('--reranker')
const baseUrl = process.argv.find(a => a.startsWith('--base-url='))?.slice(11)
  ?? process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012'
const models = (await loadModelDependencyManifest(process.cwd(), process.env)).roles
const gateway = new ModelServiceClient({ baseUrl, embeddingModel: models.embedding.model,
  embeddingRevision: models.embedding.revision, embeddingDimensions: models.embedding.dimensions,
  ...(rerankerEnabled ? { rerankerModel: models.reranker.model, rerankerRevision: models.reranker.revision } : {}) })
const records = (await Promise.all(bundledDefaultTicketPaths().map(async p => parseTicketDatasetJsonl(await readFile(p, 'utf8'))))).flat()
if (records.length !== 19_587) throw new Error('Expected 19,587 ESFT development records, received ' + records.length)
const selected = [records.find(r => r.displayId === 'ESFT-SUMMARY-TRAIN-013309'), ...records.slice(0, 7)]
if (selected.some(r => !r)) throw new Error('Pinned smoke source record is missing')
// These are explicitly bounded excerpts; full indexing is exercised separately by db:prepare/db:verify.
const documents = rankingDocuments(selected).map(d => {
  const value = { ...d, body: [...d.body].slice(0, 360).join(''), metadata: '' }
  return { ...value, contentHash: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
})
const query = '跨域主副卡解绑，线上暂不支持办理'
const ready = await gateway.ready()
const vectors = await gateway.embed({ texts: [query, query], inputType: 'query' })
if (vectors.length !== 2 || vectors.some(v => v.length !== 1024 || v.some(n => !Number.isFinite(n)))) throw new Error('Invalid real embedding response')
if (vectors[0].some((v, i) => Math.abs(v - vectors[1][i]) > 1e-5)) throw new Error('Repeated query embeddings disagree')
const ranker = new HybridRankingEngine({ baseUrl,
  embeddingIdentity: { model: models.embedding.model, revision: models.embedding.revision, dimensions: 1024 },
  ...(rerankerEnabled ? { rerankerIdentity: { model: models.reranker.model, revision: models.reranker.revision } } : {}),
  rerankerEnabled, rerankTopN: 4 })
const started = performance.now()
const result = await ranker.rank(documents, { text: query, mode: 'hybrid', fastPath: false, semanticHints: [], excludedTerms: [] }, { maxScan: documents.length })
if (!result.hits.length || result.hits.some(h => !documents.some(d => d.id === h.documentId) || !Number.isFinite(h.score))) throw new Error('Invalid real ranking result')
for (const channel of ['keyword', 'vector', ...(rerankerEnabled ? ['reranker'] : [])]) {
  if (!result.execution.channels.some(c => c.channel === channel)) throw new Error('Missing ' + channel + ' execution')
}
console.log(JSON.stringify({ scope: '8 bounded real ESFT excerpts; actual embedding/ranking/reranker, no semantic Agent assessment',
  productAgentModelMeasured: false, productQualityConclusionAllowed: false, totalSourceRecords: records.length,
  sourceDisplayIds: selected.map(r => r.displayId), modelService: ready, repeatedEmbedding: 'passed',
  elapsedMs: performance.now() - started, profileVersion: ranker.profileVersion, result }, null, 2))
