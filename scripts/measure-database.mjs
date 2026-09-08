import { mkdir, writeFile } from 'node:fs/promises'
import { TicketDatabase, DatabaseTicketProvider, MilvusClient } from '../packages/provider-database/lib/index.js'
import { ModelServiceClient } from '../packages/model-service-client/lib/index.js'
import { buildFastTicketRequest, SpacyQueryAnalyzer } from '../packages/query-understanding/lib/index.js'
import { RetrievalController, InMemoryRetrievalEventJournal, foldRetrievalEvents } from '../packages/domain/lib/index.js'

const query = process.argv[2] ?? '帮我找副卡和跨域有关工单'
const dataset = process.env.RETRIEVAL_AGENT_DATASET_ID ?? 'esft-development'
const baseUrl = process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012'
const db = new TicketDatabase(process.env.RETRIEVAL_AGENT_MYSQL_URL)
const milvus = new MilvusClient(process.env.RETRIEVAL_AGENT_MILVUS_URL, process.env.RETRIEVAL_AGENT_MILVUS_TOKEN)
const model = new ModelServiceClient({ baseUrl, embeddingModel: 'Qwen/Qwen3-Embedding-0.6B', embeddingRevision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3', embeddingDimensions: 1024, defaultDeadlineMs: 120_000 })
// Same trusted development scope as the shipped browser principal; no task can set this itself.
const principal = { tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1', purpose: 'ticket_retrieval',
  attributes: { group: ['admin'], region: ['cn'], role: ['administrator'], environment: ['development'] }, issuedAt: new Date().toISOString() }
try {
  const publication = await db.publication(dataset)
  if (!publication.index) throw new Error('Publish the real vector generation before measuring both channels')
  const started = performance.now()
  const request = await buildFastTicketRequest(query, { analyzer: new SpacyQueryAnalyzer({ baseUrl }) })
  const parseMs = performance.now() - started
  const timeline = []; const journal = new InMemoryRetrievalEventJournal()
  const provider = new DatabaseTicketProvider(db, milvus, model, dataset, 15)
  const controller = new RetrievalController(provider, journal, undefined, { searchTopK: 5, onState: state => {
    timeline.push({ ms: performance.now() - started, revision: state.revision, candidates: state.candidates.length, channels: state.searchProgress?.channels.map(c => ({ channel: c.channel, status: c.status, count: c.count })) })
  } })
  let state = await controller.start(principal, request)
  const searchCompleteMs = performance.now() - started
  while (state.lastPage?.nextCursor) state = await controller.continueRanking(principal, state)
  const channels = state.searchProgress?.channels
  if (channels?.some(c => c.status !== 'completed')) throw new Error(`A channel did not complete: ${JSON.stringify(channels)}`)
  if (!state.candidates.length) throw new Error('The representative query returned no authorized candidates; inspect identity and source before accepting the measurement')
  const replay = foldRetrievalEvents(journal.read(state.retrievalId))
  if (JSON.stringify(replay) !== JSON.stringify(state)) {
    const { isDeepStrictEqual } = await import('node:util')
    if (!isDeepStrictEqual(replay, state)) throw new Error('Public controller state and replay diverged')
  }
  const report = { at: new Date().toISOString(), query, dataset, records: publication.source.record_count,
    generation: publication.source.id, index: publication.index.id, embedding: publication.index.identity_json,
    parseMs, firstCandidateMs: timeline.find(event => event.candidates > 0)?.ms, searchCompleteMs,
    allPagesMs: performance.now() - started, candidates: state.candidates.length,
    keywordCount: channels?.find(c => c.channel === 'keyword')?.count, vectorCount: channels?.find(c => c.channel === 'vector')?.count,
    timings: state.searchProgress?.timings, timeline: [...timeline], retrievalId: state.retrievalId,
    replayEqual: true, semanticAgentExecuted: false }
  const warmStarted = performance.now(); const eventOffset = timeline.length
  const warmRequest = await buildFastTicketRequest(query, { analyzer: new SpacyQueryAnalyzer({ baseUrl }) })
  const warmParseMs = performance.now() - warmStarted
  const warm = await controller.start(principal, warmRequest)
  report.warm = { parseMs: warmParseMs, firstCandidateMs: timeline.slice(eventOffset).find(event => event.candidates > 0)?.ms - (warmStarted - started),
    searchCompleteMs: performance.now() - warmStarted, channels: warm.searchProgress?.channels, timings: warm.searchProgress?.timings }
  if (warm.searchProgress?.channels.some(c => c.status !== 'completed')) throw new Error('Warm query lane failed')
  await mkdir('output/phase1', { recursive: true })
  await writeFile('output/phase1/public-fast-query.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await db.close() }
