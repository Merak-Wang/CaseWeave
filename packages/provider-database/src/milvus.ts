import type { TicketChunk } from './projection.js'
import type { EmbeddingIdentity } from './store.js'

export interface MilvusHit { id: string; ticket_id: string; content_hash: string; source_version: string; field: string; part: number; start: number; end: number; text_hash: string; distance: number }
export class MilvusClient {
  constructor(readonly url = 'http://127.0.0.1:19530', readonly token?: string) {}
  async call<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.url}/v2/vectordb/${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]) })
    const result = await response.json() as { code: number; message?: string; data: T }
    if (!response.ok || result.code !== 0) throw new Error(`Milvus ${path}: ${result.code} ${result.message ?? response.status}`)
    return result.data
  }
  async ensureCollection(name: string, identity: EmbeddingIdentity): Promise<void> {
    const has = await this.call<{ has: boolean }>('collections/has', { collectionName: name })
    if (has.has) return
    const stringField = (fieldName: string, maxLength: number) => ({ fieldName, dataType: 'VarChar', elementTypeParams: { max_length: String(maxLength) } })
    await this.call('collections/create', { collectionName: name,
      schema: { autoId: false, enableDynamicField: false, fields: [
        { ...stringField('id', 64), isPrimary: true }, stringField('ticket_id', 191), stringField('content_hash', 64),
        stringField('source_version', 1024), stringField('field', 191), stringField('text_hash', 64),
        ...['part', 'start', 'end'].map(fieldName => ({ fieldName, dataType: 'Int64' })),
        { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: String(identity.dimensions) } },
      ] },
      indexParams: [{ fieldName: 'vector', indexName: 'vector_idx', metricType: identity.metric, params: { index_type: 'AUTOINDEX' } }],
      params: { consistencyLevel: 'Strong' },
    })
  }
  async upsert(name: string, chunks: readonly TicketChunk[], vectors: readonly (readonly number[])[], signal?: AbortSignal): Promise<void> {
    if (chunks.length !== vectors.length) throw new Error('Embedding/chunk cardinality mismatch')
    await this.call('entities/upsert', { collectionName: name, data: chunks.map((c, i) => ({ id: c.id, ticket_id: c.ticketId,
      source_version: c.sourceVersion, content_hash: c.contentHash, field: c.field, part: c.part, start: c.start, end: c.end, text_hash: c.textHash, vector: vectors[i] })) }, signal)
  }
  async count(name: string): Promise<number> {
    const data = await this.call<Record<string, number>[]>('entities/query', { collectionName: name, filter: '', outputFields: ['count(*)'], consistencyLevel: 'Strong' })
    return Number(data[0]?.['count(*)'])
  }
  async search(name: string, vector: readonly number[], ticketIds: readonly string[], topK: number, signal?: AbortSignal): Promise<MilvusHit[]> {
    if (!ticketIds.length) return []
    // SQL-authorized hard-filter IDs are pushed into each ANN call; return values are still rechecked at source.
    const hits: MilvusHit[] = []
    for (let offset = 0; offset < ticketIds.length; offset += 1000) {
      const data = await this.call<MilvusHit[]>('entities/search', { collectionName: name, data: [vector], annsField: 'vector',
        filter: `ticket_id in ${JSON.stringify(ticketIds.slice(offset, offset + 1000))}`, limit: topK,
        groupByField: 'ticket_id', groupParams: { groupByField: 'ticket_id', groupSize: 1 },
        outputFields: ['ticket_id', 'content_hash', 'source_version', 'field', 'part', 'start', 'end', 'text_hash'],
        consistencyLevel: 'Strong', searchParams: { metricType: 'COSINE' } }, signal)
      hits.push(...data)
    }
    const unique = new Map<string, MilvusHit>()
    for (const hit of hits.sort((a, b) => b.distance - a.distance || a.ticket_id.localeCompare(b.ticket_id))) if (!unique.has(hit.ticket_id)) unique.set(hit.ticket_id, hit)
    return [...unique.values()].slice(0, topK)
  }
}
