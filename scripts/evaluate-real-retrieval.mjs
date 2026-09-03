import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ModelServiceClient } from '@retrieval-agent/model-service-client'
import { LocalTicketProvider, parseTicketDatasetJsonl } from '@retrieval-agent/provider-local'
import { HybridRankingEngine } from '@retrieval-agent/retrieval-ranking'
import { loadModelDependencyManifest } from './model-dependencies.mjs'

const baseUrlArgument = process.argv.find(argument => argument.startsWith('--base-url='))
const baseUrl = baseUrlArgument?.slice('--base-url='.length) ?? process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012'
const modelManifest = (await loadModelDependencyManifest(process.cwd(), process.env)).roles
const embeddingIdentity = {
  model: modelManifest.embedding.model,
  revision: modelManifest.embedding.revision,
  dimensions: modelManifest.embedding.dimensions,
}
const rerankerIdentity = {
  model: modelManifest.reranker.model,
  revision: modelManifest.reranker.revision,
}
const gateway = new ModelServiceClient({
  baseUrl,
  embeddingModel: embeddingIdentity.model,
  embeddingRevision: embeddingIdentity.revision,
  embeddingDimensions: embeddingIdentity.dimensions,
  rerankerModel: rerankerIdentity.model,
  rerankerRevision: rerankerIdentity.revision,
  defaultDeadlineMs: 180_000,
})
await gateway.ready()

const records = parseTicketDatasetJsonl(await readFile(join(process.cwd(), 'data', 'tickets', 'synthetic', 'legacy-bronze-v1.jsonl'), 'utf8'))
const cases = (await readFile(join(process.cwd(), 'data', 'evals', 'legacy-bronze-v1', 'cases.jsonl'), 'utf8'))
  .split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
if (records.length !== 40 || cases.length !== 162) throw new Error('legacy synthetic corpus or Bronze diagnostic set is incomplete')

const now = new Date()
const principal = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1', purpose: 'ticket_retrieval',
  attributes: { group: ['admin'], region: ['cn'], role: ['administrator'], environment: ['development'] },
  issuedAt: new Date(now.getTime() - 60_000).toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
}
const variants = [
  { name: 'bm25f', mode: 'keyword', ranker: new HybridRankingEngine({ baseUrl }) },
  {
    name: 'qwen_dense', mode: 'dense',
    ranker: new HybridRankingEngine({ baseUrl, embeddingIdentity }),
  },
  {
    name: 'fixed_hybrid', mode: 'hybrid',
    ranker: new HybridRankingEngine({ baseUrl, embeddingIdentity }),
  },
  {
    name: 'fixed_hybrid_qwen_rerank', mode: 'hybrid',
    ranker: new HybridRankingEngine({
      baseUrl, embeddingIdentity, rerankerIdentity, rerankerEnabled: true, rerankTopN: 10,
    }),
  },
]

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0
}

function discountedGain(relevances) {
  return relevances.reduce((sum, relevance, index) => sum + ((2 ** relevance) - 1) / Math.log2(index + 2), 0)
}

const report = []
for (const variant of variants) {
  const provider = new LocalTicketProvider(records, { now: () => now, ranker: variant.ranker, defaultMode: variant.mode })
  const snapshot = await provider.openSnapshot(principal)
  let positiveCases = 0
  let hits = 0
  let reciprocalRank = 0
  let precisionAt10 = 0
  let recallAt10 = 0
  let ndcgAt10 = 0
  let negativeCases = 0
  let correctNoResults = 0
  const latencies = []
  const misses = []
  const falsePositives = []
  for (const item of cases) {
    const spec = provider.resolve({
      target: item.target,
      query: item.query,
      retrievalIntent: item.retrievalIntent,
      filters: item.filters,
      requestedCount: 10,
      mode: variant.mode,
    })
    const started = performance.now()
    const page = await provider.search(principal, snapshot.snapshotId, spec, { topK: 10, maxScan: 50_000, stage: 'baseline' })
    latencies.push(performance.now() - started)
    const relevant = new Set(item.qrels.filter(qrel => qrel.relevance > 0).map(qrel => qrel.ticketId))
    if (relevant.size === 0) {
      negativeCases += 1
      if (page.candidates.length === 0) correctNoResults += 1
      else if (falsePositives.length < 20) {
        falsePositives.push({ caseId: item.caseId, query: item.query, returned: page.candidates.map(candidate => candidate.displayId) })
      }
      continue
    }
    positiveCases += 1
    const relevanceById = new Map(item.qrels.map(qrel => [qrel.ticketId, qrel.relevance]))
    const retrievedRelevances = page.candidates.slice(0, 10).map(candidate => relevanceById.get(candidate.displayId) ?? 0)
    const retrievedRelevant = retrievedRelevances.filter(relevance => relevance > 0).length
    precisionAt10 += retrievedRelevant / 10
    recallAt10 += retrievedRelevant / relevant.size
    const ideal = item.qrels.map(qrel => qrel.relevance).sort((left, right) => right - left).slice(0, 10)
    const idealGain = discountedGain(ideal)
    ndcgAt10 += idealGain === 0 ? 0 : discountedGain(retrievedRelevances) / idealGain
    const rank = page.candidates.findIndex(candidate => relevant.has(candidate.displayId)) + 1
    if (rank > 0) {
      hits += 1
      reciprocalRank += 1 / rank
    } else if (misses.length < 20) {
      misses.push({ caseId: item.caseId, query: item.query, expected: [...relevant], returned: page.candidates.map(candidate => candidate.displayId) })
    }
  }
  report.push({
    variant: variant.name,
    cases: cases.length,
    positiveCases,
    hitRateAt10: hits / positiveCases,
    mrrAt10: reciprocalRank / positiveCases,
    precisionAt10: precisionAt10 / positiveCases,
    recallAt10: recallAt10 / positiveCases,
    ndcgAt10: ndcgAt10 / positiveCases,
    negativeCases,
    noResultAccuracy: correctNoResults / negativeCases,
    latencyMs: {
      mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(...latencies),
    },
    missCount: positiveCases - hits,
    sampleMisses: misses,
    falsePositiveNoResultCount: negativeCases - correctNoResults,
    sampleFalsePositives: falsePositives,
  })
}

console.log(JSON.stringify({
  evidenceLevel: 'legacy_bronze_provider_only_oracle_contract_diagnostic',
  evaluatedPath: 'provider_only',
  oracleContractInjected: ['target', 'retrievalIntent', 'filters'],
  productQualityConclusionAllowed: false,
  notMeasured: [
    'natural_language_query_compilation',
    'knowledge_state_decisions',
    'clarification',
    'iterative_candidate_revision',
    'final_ticket_collection_quality',
    'provider_to_agent_non_degradation',
  ],
  recordCount: records.length,
  caseCount: cases.length,
  topK: 10,
  report,
}, undefined, 2))
