import { afterEach, expect, it, vi } from 'vitest'
import type { TicketSnapshot, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import { EMBEDDING_INSTRUCTION } from '@retrieval-agent/model-service-client/ranking'
import { ticketGroupHashes, stableJson, sha256 } from '@retrieval-agent/provider-local'
import { DatabaseTicketProvider } from './provider.js'
import { DatabaseQueryStore } from './query-store.js'
import type { TicketDatabase, EmbeddingIdentity } from './store.js'
import type { MilvusClient } from './milvus.js'
import { effectiveQueryInstruction, queryEmbeddingIdentity } from './embedding-policy.js'

afterEach(() => vi.restoreAllMocks())
const user: TrustedPrincipalContext = { tenantId: 'group-synthetic', subjectId: 'reader', entitlementVersion: 'v1',
  purpose: 'ticket_retrieval', attributes: {}, issuedAt: new Date().toISOString() }
const identity: EmbeddingIdentity = { model: 'synthetic', revision: 'v1', dimensions: 2, normalization: 'l2', metric: 'COSINE',
  chunkChars: 360, chunkVersion: 'field-codepoints-v3' }
const groupingRows = [0, 1].map(i => ({ ticket_id: `physical-${i}`, group_source: { tenantId: user.tenantId,
  title: 'adapter fallback', summary: 'adapter fallback', rawSource: { datasetId: 'synthetic-source',
    payload: { group_id: `business-${i}`, ticket_id: null, large_model_title: i ? 'Alpha' : 'Ａlpha', large_model_abstract: i ? 'one two' : 'one\t two' } } },
  raw_presence: { group_id: 1, ticket_id: 0, large_model_title: 1, large_model_abstract: 1 } }))

function fakeDatabase(published: EmbeddingIdentity = identity) {
  const sql: string[] = [], cache = new Map<string, number[]>(), saved = new Map<string, TicketSnapshot>()
  const source = { id: 'generation', dataset_id: 'synthetic-source', status: 'ready', record_count: 2,
    fields_json: [], grams_ready: 0, source_watermark: 'synthetic-watermark' }
  const index = { id: 'index', generation: source.id, collection_name: 'unused', identity_json: published, status: 'ready',
    total_chunks: 2, completed_chunks: 2, watermark: source.source_watermark }
  const rows = vi.fn(async (statement: string, params: unknown[] = []) => {
    sql.push(statement)
    if (statement.startsWith('SELECT generation,index_id,snapshot_json')) return [{ generation: source.id, index_id: index.id, snapshot_json: saved.get(String(params[0])) }]
    if (statement.startsWith('SELECT * FROM ra_index')) return [index]
    if (statement.startsWith('SELECT f.ordinal,f.ticket_id,f.vector_blob')) return [0, 1].map(i => {
      const vector_blob = Buffer.alloc(8); vector_blob.writeFloatLE(1, 0)
      return { ordinal: i, ticket_id: `physical-${i}`, vector_blob }
    })
    if (statement.startsWith('SELECT COUNT(*) n FROM ra_numeric_feature')) return [{ n: 2 }]
    if (statement.startsWith('SELECT ticket_id,JSON_OBJECT')) return groupingRows.filter(r => (params[1] as string[]).includes(r.ticket_id))
    if (statement.startsWith('SELECT vector_json FROM ra_embedding_cache')) {
      const vector = cache.get(`${params[0]}:${params[1]}`); return vector ? [{ vector_json: vector }] : []
    }
    if (statement.includes('COUNT(DISTINCT q.gram)')) return []
    throw new Error(`Unexpected synthetic SQL kind: ${statement.slice(0, 45)}`)
  })
  const pool = { query: vi.fn(async (statement: string, params: unknown[] = []) => {
    sql.push(statement)
    if (statement.startsWith('INSERT INTO ra_provider_snapshot')) saved.set(String(params[0]), JSON.parse(String(params[4])))
    else if (statement.startsWith('INSERT IGNORE INTO ra_embedding_cache')) cache.set(`${params[0]}:${params[1]}`, JSON.parse(String(params[2])))
    else throw new Error(`Unexpected synthetic mutation kind: ${statement.slice(0, 45)}`)
    return [{ affectedRows: 1 }]
  }) }
  const db = { rows, pool, publication: async () => ({ source, index }), generation: async () => source } as unknown as TicketDatabase
  // Only SQL/authorization boundaries are doubled. Actual Provider and groupHashes consumer execute.
  vi.spyOn(DatabaseQueryStore.prototype, 'catalog').mockResolvedValue([])
  vi.spyOn(DatabaseQueryStore.prototype, 'scope').mockResolvedValue({ from: 'ra_ticket_access t', where: '1', params: [] })
  const embed = vi.fn<RetrievalModelGateway['embed']>().mockResolvedValue([[1, 0]])
  const ready = vi.fn<RetrievalModelGateway['ready']>().mockResolvedValue({ protocolVersion: 'retrieval-agent.models.v1', serviceVersion: 'synthetic',
    ready: true, device: 'cpu', limits: { maxBatchSize: 8, maxTotalTokens: 1024, maxRerankCandidates: 8 },
    models: [{ model: published.model, revision: published.revision, dimensions: 2, kind: 'embedding', loaded: true,
      dtype: 'float32', device: 'cpu', maxTokens: 512, pooling: 'last_token', normalization: 'l2' }] })
  const model = { embed, ready } as unknown as RetrievalModelGateway
  const create = () => new DatabaseTicketProvider(db, {} as MilvusClient, model, 'synthetic-source', 15,
    published.documentProjection ? { documentProjection: published.documentProjection } : {})
  return { db, sql, cache, create, embed, ready }
}

it('executes the real DB featureBlock group consumer aligned to requested ordinals using bounded field-only SQL', async () => {
  const fake = fakeDatabase(), provider = fake.create(), snapshot = await provider.openSnapshot(user)
  const block = await provider.featureBlock(user, { snapshotId: snapshot.snapshotId, ids: [1, 0], limit: 2 })
  expect(block.ids).toEqual([1, 0])
  expect(block.row_groups).toEqual([ticketGroupHashes(groupingRows[1]!.group_source), ticketGroupHashes(groupingRows[0]!.group_source)])
  expect(block.row_groups![0]!.canonical_hash).toBe(block.row_groups![1]!.canonical_hash)
  expect(block.row_groups![0]!.business_hash).not.toBe(block.row_groups![1]!.business_hash)
  expect(fake.sql.some(s => s.includes('JSON_CONTAINS_PATH'))).toBe(true)
  expect(fake.sql.some(s => s.includes('record_json AS record'))).toBe(false)
  expect(fake.embed).not.toHaveBeenCalled()
})

it('pins the actual legacy query instruction and refuses the old mutable-default cache namespace', async () => {
  const fake = fakeDatabase(), old = { ...queryEmbeddingIdentity(identity), instruction: 'manifest-default-v1' }
  const textHash = sha256('synthetic original query')
  fake.cache.set(`${sha256(stableJson(old))}:${textHash}`, [-1, 0])
  const provider = fake.create(), snapshot = await provider.openSnapshot(user)
  expect(snapshot.retrievalProfileVersion).toContain('v4-pinned-query')
  await provider.featureBlock(user, { snapshotId: snapshot.snapshotId, ids: [0], limit: 1, rankingQuery: 'synthetic original query' })
  expect(fake.embed).toHaveBeenCalledTimes(1)
  expect(fake.embed.mock.calls[0]![0]).toMatchObject({ inputType: 'query', instruction: EMBEDDING_INSTRUCTION, requireCompleteInput: true })
  expect(fake.cache.has(`${sha256(stableJson(queryEmbeddingIdentity(identity)))}:${textHash}`)).toBe(true)
  const second = fake.create()
  await second.featureBlock(user, { snapshotId: snapshot.snapshotId, ids: [0], limit: 1, rankingQuery: 'synthetic original query' })
  expect(fake.embed).toHaveBeenCalledTimes(1)
})

it('retains canonical publication instructions and changes query-cache identity with the actual pinned task', async () => {
  const canonical: EmbeddingIdentity = { ...identity, documentProjection: 'canonical-title-abstract-v1',
    chunkVersion: 'canonical-title-abstract-codepoints-v1', pooling: 'last_token', queryInstruction: 'Synthetic pinned task.' }
  const fake = fakeDatabase(canonical), provider = fake.create(), snapshot = await provider.openSnapshot(user)
  await provider.featureBlock(user, { snapshotId: snapshot.snapshotId, ids: [0], limit: 1, rankingQuery: 'synthetic original query' })
  expect(fake.embed.mock.calls[0]![0]).toMatchObject({ instruction: canonical.queryInstruction })
  expect(effectiveQueryInstruction(canonical)).toBe(canonical.queryInstruction)
  expect(queryEmbeddingIdentity({ ...canonical, queryInstruction: 'Different synthetic task.' })).not.toEqual(queryEmbeddingIdentity(canonical))
})
