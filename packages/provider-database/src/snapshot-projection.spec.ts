import { expect, it, vi } from 'vitest'
import type { TicketSnapshot, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import { DatabaseTicketProvider } from './provider.js'
import type { TicketDatabase } from './store.js'
import type { MilvusClient } from './milvus.js'

it('publishes canonical projection and recovers a missing field only from the snapshot pinned index', async () => {
  const principal: TrustedPrincipalContext = { tenantId: 'projection', subjectId: 'reader', entitlementVersion: '1',
    purpose: 'ticket_retrieval', attributes: {}, issuedAt: new Date().toISOString() }
  const source = { id: 'original-source', dataset_id: 'original-dataset', source_watermark: 'original-watermark', fields_json: [] }
  const index = { id: 'original-index', generation: source.id, status: 'ready', watermark: source.source_watermark,
    total_chunks: 128, completed_chunks: 128, identity_json: { documentProjection: 'canonical-title-abstract-v1' } }
  let saved!: TicketSnapshot
  const rows = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('ra_generation_catalog')) return [{ catalog_json: [] }]
    if (sql.includes('ra_provider_snapshot')) {
      expect(params).toEqual([saved.snapshotId, 'original-dataset'])
      return [{ generation: source.id, index_id: index.id, snapshot_json: saved }]
    }
    if (sql.includes('ra_index')) { expect(params).toEqual([index.id]); return [index] }
    if (sql.includes('ra_provider_candidate')) return []
    throw new Error(`unexpected query: ${sql}`)
  })
  const publication = vi.fn(async () => ({ source, index }))
  const db = { rows, publication, generation: vi.fn(async (id: string) => { expect(id).toBe(source.id); return source }),
    pool: { query: vi.fn(async (_sql: string, params: unknown[]) => { saved = JSON.parse(String(params[4])); return [] }) } } as unknown as TicketDatabase
  const provider = new DatabaseTicketProvider(db, {} as MilvusClient, {} as RetrievalModelGateway, 'original-dataset')
  const fresh = await provider.openSnapshot(principal)
  expect(fresh.documentProjection).toBe('canonical-title-abstract-v1')
  expect(saved.documentProjection).toBe('canonical-title-abstract-v1')
  const { documentProjection: _missing, ...legacy } = saved
  saved = legacy
  publication.mockImplementation(async () => ({ source: { ...source, id: 'later-source' }, index: { ...index, id: 'later-index', identity_json: { documentProjection: 'ticket-search-projection-v1' } } }))
  const status = await provider.status(principal, fresh.snapshotId)
  expect(status).toMatchObject({ snapshotValid: true, sourceVersion: source.id, indexVersion: index.id,
    documentProjection: 'canonical-title-abstract-v1' })
  expect(publication).toHaveBeenCalledTimes(1)
  expect(saved.documentProjection).toBeUndefined()
})
