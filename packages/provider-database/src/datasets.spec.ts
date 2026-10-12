import { beforeEach, expect, it, vi } from 'vitest'
import type { TicketDatabase } from './store.js'
import type { MilvusClient } from './milvus.js'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import { DatasetService, type DatasetProgress } from './datasets.js'
const state = vi.hoisted(() => ({ cancelDownload: false, cancelEmbedding: false, embeddingStarted: false, ids: [] as string[], identity: undefined as unknown }))
vi.mock('./mongo-import.js', async original => ({ ...await original<typeof import('./mongo-import.js')>(), downloadMongoDataset: async (_spec: unknown, id: string, tenant: string, counts: Record<string, number>, _progress: unknown, signal: AbortSignal) => {
  state.ids.push(id)
  if (state.cancelDownload) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  signal.throwIfAborted(); counts.read = 1; counts.valid = 1
  return [{ ticketId: 'same-physical-id', tenantId: tenant }]
} }))
vi.mock('./indexing.js', () => ({ buildIndex: async (_db: unknown, _milvus: unknown, model: RetrievalModelGateway, generation: string, identity: unknown,
  options: { signal: AbortSignal; onProgress: (n: number, total: number) => Promise<void> }) => { state.identity = identity; await model.embed({ texts: ['标题摘要'], inputType: 'document', signal: options.signal }); await options.onProgress(1, 1); return `index-${generation}` } }))
const spec = { name: 'synthetic', connection: { uri: 'mongodb://localhost', database: 'fixture', collection: 'tickets' }, time: { start: '2026-09-10T00:00:00+08:00', end: '2026-10-10T00:00:00+08:00' } }
function fixture() {
  const catalog = new Map<string, DatasetProgress>(), publications: Record<string, unknown>[] = []
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    if (sql.startsWith('INSERT INTO ra_dataset')) catalog.set(String(args[0]), JSON.parse(String(args[4])))
    if (sql.startsWith('UPDATE ra_dataset')) catalog.set(String(args[2]), JSON.parse(String(args[1])))
  })
  const db = { migrate: async () => {}, pool: { query }, rows: async (sql: string) => sql.includes('FROM ra_publication') ? publications : sql.includes('stage NOT') ? [] : [...catalog.values()].map(progress_json => ({ progress_json })),
    importRecords: vi.fn(async (id: string) => `generation-${id}`), buildGrams: vi.fn(async () => {}), publish: vi.fn(async () => {}) } as unknown as TicketDatabase
  const model = { ready: async () => ({ ready: true, models: [{ kind: 'embedding', loaded: true, model: 'actual-ready', revision: 'actual-revision', dimensions: 1024, pooling: 'last_token', normalization: 'l2' }] }),
    embed: async (input: { signal?: AbortSignal }) => { state.embeddingStarted = true; if (state.cancelEmbedding) await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true })); input.signal?.throwIfAborted(); return [[1]] }, rerank: async () => [] } as unknown as RetrievalModelGateway
  return { service: new DatasetService({ db, milvus: {} as MilvusClient, model, tenantId: async () => 'authorized-tenant' }), db, catalog, publications }
}
async function terminal(service: DatasetService, id: string) { for (let i = 0; i < 100; i++) { const row = await service.get(id); if (['ready', 'failed', 'cancelled'].includes(row.stage)) return row; await new Promise(resolve => setTimeout(resolve, 2)) } throw new Error('job did not finish') }
beforeEach(() => { state.cancelDownload = false; state.cancelEmbedding = false; state.embeddingStarted = false; state.ids = []; state.identity = undefined })
it('uses the ready embedding identity and publishes independent new datasets only after indexing', async () => {
  const { service, db, catalog } = fixture(), first = await service.start(spec), second = await service.start(spec)
  expect(first.datasetId).not.toBe(second.datasetId)
  const results = await Promise.all([terminal(service, first.id), terminal(service, second.id)])
  expect(results.every(r => r.stage === 'ready')).toBe(true); expect(db.publish).toHaveBeenCalledTimes(2)
  expect(state.identity).toMatchObject({ model: 'actual-ready', revision: 'actual-revision', dimensions: 1024, documentProjection: 'canonical-title-abstract-v1', pooling: 'last_token' })
  expect(catalog.get(first.id)?.counts).toMatchObject({ valid: 1, indexedChunks: 1, embeddedChunks: 1, totalChunks: 1 })
  await service.close()
})
it('cancels download without importing or publishing', async () => {
  state.cancelDownload = true; const { service, db } = fixture(), job = await service.start(spec)
  while (!state.ids.length) await new Promise(resolve => setTimeout(resolve, 1))
  await service.cancel(job.id); expect((await terminal(service, job.id)).stage).toBe('cancelled')
  expect(db.importRecords).not.toHaveBeenCalled(); expect(db.publish).not.toHaveBeenCalled(); await service.close()
})
it('cancels the active embedding through its native signal and does not publish', async () => {
  state.cancelEmbedding = true; const { service, db } = fixture(), job = await service.start(spec)
  while (!state.embeddingStarted) await new Promise(resolve => setTimeout(resolve, 1))
  await service.cancel(job.id)
  expect((await terminal(service, job.id)).stage).toBe('cancelled'); expect(db.importRecords).toHaveBeenCalledTimes(1); expect(db.publish).not.toHaveBeenCalled()
  await service.close()
})
it('published identity wins over stale failed catalog after restart and lists existing publications', async () => {
  const { service, catalog, publications } = fixture()
  catalog.set('new', { id: 'new', datasetId: 'new', name: 'kept name', stage: 'failed', createdAt: new Date().toISOString(), counts: { read: 1, valid: 1, duplicate: 0, skipped: 0, embeddedChunks: 0, indexedChunks: 0, totalChunks: 0 }, error: 'restart' })
  publications.push(...['new', 'existing'].map(dataset_id => ({ dataset_id, generation: `generation-${dataset_id}`, index_id: `index-${dataset_id}`, record_count: 1, created_at: new Date() })))
  const rows = (await service.list()).datasets
  expect(rows.find(r => r.id === 'new')).toMatchObject({ stage: 'ready', name: 'kept name', sourceVersion: 'generation-new' }); expect(rows.find(r => r.id === 'new')?.error).toBeUndefined()
  expect(rows.find(r => r.id === 'existing')?.stage).toBe('ready'); await service.close()
})
