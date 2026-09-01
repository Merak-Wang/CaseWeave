import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createTicketResultCollection } from '@retrieval-agent/ticket-collection'
import { InMemoryRetrievalEventJournal, RetrievalController } from '@retrieval-agent/domain'
import { ModelServiceClient } from '@retrieval-agent/model-service-client'
import { LocalTicketProvider, parseTicketDatasetJsonl, rankingDocuments } from '@retrieval-agent/provider-local'
import { HybridRankingEngine } from '@retrieval-agent/retrieval-ranking'
import { bundledFixtureRoot } from '@retrieval-agent/bundle/startup'
import { loadModelDependencyManifest } from './model-dependencies.mjs'

const rerankerEnabled = process.argv.includes('--reranker')
const baseUrlArgument = process.argv.find(argument => argument.startsWith('--base-url='))
const baseUrl = baseUrlArgument?.slice('--base-url='.length) ?? process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012'
const modelManifest = (await loadModelDependencyManifest(process.cwd(), process.env)).roles
const embeddingModel = modelManifest.embedding.model
const embeddingRevision = modelManifest.embedding.revision
const rerankerModel = modelManifest.reranker.model
const rerankerRevision = modelManifest.reranker.revision

const fixtureRoot = bundledFixtureRoot()
const records = (await Promise.all([
  'tickets.jsonl',
  'public/fcc-1000-seed-20260825.jsonl',
  'public/bitext-1000-seed-20260825.jsonl',
].map(async path => parseTicketDatasetJsonl(await readFile(join(fixtureRoot, path), 'utf8'))))).flat()
if (records.length !== 2_040) throw new Error(`expected 2,040 development records, received ${records.length}`)

const gateway = new ModelServiceClient({
  baseUrl,
  embeddingModel,
  embeddingRevision,
  embeddingDimensions: modelManifest.embedding.dimensions,
  ...(rerankerEnabled ? { rerankerModel, rerankerRevision } : {}),
  defaultDeadlineMs: 180_000,
})
const ready = await gateway.ready()
const ranker = new HybridRankingEngine({
  baseUrl,
  embeddingIdentity: { model: embeddingModel, revision: embeddingRevision, dimensions: modelManifest.embedding.dimensions },
  ...(rerankerEnabled ? { rerankerIdentity: { model: rerankerModel, revision: rerankerRevision } } : {}),
  modelDeadlineMs: 180_000,
  rerankerEnabled,
  rerankTopN: 8,
})
const prepared = await ranker.prepare(rankingDocuments(records))
const now = new Date()
const principal = {
  tenantId: 'demo',
  subjectId: 'development-admin',
  entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval',
  attributes: { group: ['admin'], region: ['cn'], role: ['administrator'], environment: ['development'] },
  issuedAt: new Date(now.getTime() - 60_000).toISOString(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
}
const provider = new LocalTicketProvider(records, { now: () => now, ranker, defaultMode: 'hybrid' })

let serial = 0
const checks = []
for (const query of [
  '主副卡解绑后仍共享流量',
  '主副卡解绑后仍共享流量 补充背景 宽带',
]) {
  const journal = new InMemoryRetrievalEventJournal({ now: () => now, eventId: () => `real-model-event-${serial++}` })
  const controller = new RetrievalController(provider, journal, undefined, {
    now: () => now,
    id: () => `real-model-domain-${serial++}`,
    searchTopK: 8,
  })
  const started = performance.now()
  let state = await controller.start(principal, {
    target: 'ranked_cases', query, requestedCount: 8, countPolicy: 'adaptive',
  })
  const trace = state.lastPage?.trace
  if (trace?.stage !== 'initial_hybrid' || trace.executedMode !== 'hybrid') throw new Error('initial search did not execute Hybrid')
  for (const channel of ['keyword', 'vector']) {
    if (!trace.channels.some(item => item.channel === channel)) throw new Error(`initial search missed ${channel} channel`)
  }
  if (rerankerEnabled && !trace.channels.some(item => item.channel === 'reranker')) throw new Error('reranker was enabled but not applied')
  const expected = state.candidates.find(candidate => candidate.displayId === 'TKT-0029')
  if (expected === undefined) throw new Error(`expected TKT-0029 in top 8 for query: ${query}`)
  // This script validates the real Embedding/Reranker data plane, not Agent
  // judgment quality. Use an explicit deterministic smoke assessment so the
  // diagnostic cannot silently reintroduce the removed "count == sufficient"
  // product rule.
  state = await controller.assess(state, {
    decision: 'accept_current_top_k',
    selectedCandidateRefs: [expected.ref],
    excludedCandidateRefs: [],
    gaps: [],
    nextAction: 'accept_current_top_k',
    evaluator: 'model',
  })
  state = controller.freeze(state, state.selectedCandidateRefs)
  if (state.phase !== 'stopped' || state.termination !== 'top_k_accepted') {
    throw new Error('deterministic smoke assessment did not produce a structured collection')
  }
  const collection = createTicketResultCollection(state)
  if (collection.type !== 'ticket_collection' || collection.tickets[0]?.displayId !== 'TKT-0029') {
    throw new Error('terminal value is not the expected structured ticket collection')
  }
  checks.push({
    query,
    elapsedMs: Math.round(performance.now() - started),
    topIds: state.candidates.map(candidate => candidate.displayId),
    expectedRank: expected.rank,
    channelElapsedMs: Object.fromEntries(trace.channels.map(channel => [channel.channel, Math.round(channel.elapsedMs)])),
    warnings: state.lastPage?.warnings ?? [],
    terminalType: collection.type,
    terminalTicketIds: collection.tickets.map(ticket => ticket.displayId),
  })
}

console.log(JSON.stringify({
  recordCount: records.length,
  modelService: {
    protocolVersion: ready.protocolVersion,
    serviceVersion: ready.serviceVersion,
    device: ready.device,
    models: ready.models.map(model => ({
      kind: model.kind, model: model.model, revision: model.revision, dtype: model.dtype,
      dimensions: model.dimensions, loaded: model.loaded,
    })),
  },
  retrievalProfileVersion: ranker.profileVersion,
  preparation: prepared,
  rerankerEnabled,
  evidenceLevel: 'real_model_provider_data_plane_smoke',
  evaluatedPath: 'provider_and_ranking_with_deterministic_smoke_assessment',
  productAgentModelMeasured: false,
  productQualityConclusionAllowed: false,
  checks,
}, undefined, 2))
