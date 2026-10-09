import { expect, it } from 'vitest'
import type { NumericFeatureBlock, TicketCandidate, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import type { RetrievalRanker } from '@retrieval-agent/model-service-client/ranking'
import { LocalTicketProvider } from './provider.js'
import { normalizeFixtureTicket } from './fixture.js'

const projection = 'business-and-canonical-nfkc-whitespace-v1'
type Group = { business_hash?: string; canonical_hash?: string; group_projection: string }
const principal: TrustedPrincipalContext = { tenantId: 'group-synthetic', subjectId: 'reader', entitlementVersion: 'v1',
  purpose: 'ticket_retrieval', attributes: {}, issuedAt: new Date().toISOString() }
const payloads = [
  { group_id: 'business-A', large_model_title: 'Ａlpha  ', large_model_abstract: 'one\t two' },
  { group_id: 'business-A', large_model_title: 'Other', large_model_abstract: 'different' },
  { group_id: 'business-B', large_model_title: 'Alpha', large_model_abstract: 'one two' },
  { group_id: null, ticket_id: 'must-not-fallback', large_model_title: 'Alpha', large_model_abstract: 'one two' },
  { group_id: 'business-C', large_model_title: ' ', large_model_abstract: 'actual abstract' },
]
const records = payloads.map((payload, i) => normalizeFixtureTicket({ ticketId: `physical-${i}`, displayId: `S-${i}`,
  tenantId: 'group-synthetic', sourceVersion: String(i + 1), title: 'adapter fallback', summary: 'adapter fallback',
  allowedSubjectIds: [], requiredAttributes: {}, conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable',
  rawSource: { datasetId: 'synthetic-source', datasetVersion: 'v1', schemaVersion: 'v1', recordId: `physical-${i}`, payload } }))
const ranker: RetrievalRanker = { profileVersion: 'group-synthetic', capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
  async rank(docs, query) { return { hits: docs.map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1,
    channels: [{ channel: 'vector', rank: i + 1, score: 1 }] })), execution: { requestedMode: query.mode, executedMode: query.mode, strategyVersion: 'synthetic', channels: [] },
    scanned: docs.length, keywordEligible: 0, rankedHits: docs.length, warnings: [] } },
  async readFeatureBlock(docs) { return { embedding_id: 'synthetic-base', dimensions: 2,
    dense: Buffer.alloc(docs.length * 8).toString('base64'), available: Buffer.alloc(docs.length, 1).toString('base64') } } }

async function provider() {
  const port = new LocalTicketProvider(records, { ranker, defaultMode: 'dense' }), snapshot = await port.openSnapshot(principal)
  const page = await port.search(principal, snapshot.snapshotId, port.resolve({ target: 'ranked_cases', query: 'synthetic', mode: 'dense' }),
    { stage: 'repair_search', topK: 5, maxScan: 20 })
  return { port, snapshot, page }
}

it('aligns actual source group hashes with requested numeric IDs and preserves both duplicate relations', async () => {
  const { port, snapshot, page } = await provider()
  const block = await port.featureBlock(principal, { snapshotId: snapshot.snapshotId, recallScope: page.recallScope!, ids: [2, 1, 0], limit: 3 })
  const groups = (block as NumericFeatureBlock & { row_groups?: Group[] }).row_groups
  expect(groups).toHaveLength(block.ids.length)
  expect(groups!.map(g => g.group_projection)).toEqual([projection, projection, projection])
  expect(groups![1]!.business_hash).toBe(groups![2]!.business_hash)
  expect(groups![1]!.canonical_hash).not.toBe(groups![2]!.canonical_hash)
  expect(groups![0]!.canonical_hash).toBe(groups![2]!.canonical_hash)
  expect(groups![0]!.business_hash).not.toBe(groups![2]!.business_hash)
  expect(groups!.every(g => /^[0-9a-f]{64}$/.test(g.business_hash!) && /^[0-9a-f]{64}$/.test(g.canonical_hash!))).toBe(true)
})

it('keeps invalid true business IDs and present-but-invalid raw canonical fields missing without ID/text fallback', async () => {
  const { port, snapshot, page } = await provider()
  const block = await port.featureBlock(principal, { snapshotId: snapshot.snapshotId, recallScope: page.recallScope!, ids: [3, 4], limit: 2 })
  const groups = (block as NumericFeatureBlock & { row_groups?: Group[] }).row_groups
  expect(groups).toHaveLength(2)
  expect(groups![0]!.business_hash).toBeUndefined()
  expect(groups![0]!.canonical_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(groups![1]!.business_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(groups![1]!.canonical_hash).toBeUndefined()
})

it('carries exactly the same source hashes through search candidates and on-demand numeric-ID resolution', async () => {
  const { port, snapshot, page } = await provider()
  const rows = await port.resolveFeatureIds(principal, { snapshotId: snapshot.snapshotId, ids: [2, 0] })
  const block = await port.featureBlock(principal, { snapshotId: snapshot.snapshotId, recallScope: page.recallScope!, ids: [2, 0], limit: 2 })
  const groups = (block as NumericFeatureBlock & { row_groups?: Group[] }).row_groups
  expect(rows.map(r => (r as TicketCandidate & { groupHashes?: Group }).groupHashes)).toEqual(groups)
  expect(groups).toHaveLength(2)
  for (const row of rows) expect((page.candidates.find(c => c.displayId === row.displayId) as TicketCandidate & { groupHashes?: Group }).groupHashes)
    .toEqual((row as TicketCandidate & { groupHashes?: Group }).groupHashes)
})

it('does not invent business metadata from a normalized physical ticket ID', async () => {
  const { rawSource: _raw, ...source } = records[0]!
  const row = normalizeFixtureTicket({ ...source, ticketId: 'numeric-123' })
  const port = new LocalTicketProvider([row], { ranker }), snapshot = await port.openSnapshot(principal)
  const block = await port.featureBlock(principal, { snapshotId: snapshot.snapshotId, ids: [0], limit: 1 })
  const groups = (block as NumericFeatureBlock & { row_groups?: Group[] }).row_groups
  expect(groups).toHaveLength(1)
  expect(groups![0]!.business_hash).toBeUndefined()
})
