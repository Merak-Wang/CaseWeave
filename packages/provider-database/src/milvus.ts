import type { TicketChunk } from './projection.js'
import type { EmbeddingIdentity } from './store.js'

export interface MilvusHit { id: string; ticket_id: string; content_hash: string; source_version: string; field: string; part: number; start: number; end: number; text_hash: string; distance: number }
export class MilvusClient {
  constructor(readonly url = process.env.RETRIEVAL_AGENT_MILVUS_URL ?? 'http://127.0.0.1:19530', readonly token?: string) {}
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
  async readVectors(name: string, ids: readonly string[], signal?: AbortSignal) {
    if (!ids.length) return []
    return this.call<(Omit<MilvusHit, 'distance'> & { vector: number[] })[]>('entities/get', {
      collectionName: name, id: ids, outputFields: ['id', 'ticket_id', 'source_version', 'content_hash', 'vector'],
      consistencyLevel: 'Strong' }, signal)
  }
  async searchCollection(name: string, vector: readonly number[], topK: number, signal?: AbortSignal): Promise<MilvusHit[]> {
    return this.searchFilter(name, vector, '', topK, signal)
  }
  private async searchFilter(name: string, vector: readonly number[], filter: string, topK: number, signal?: AbortSignal): Promise<MilvusHit[]> {
    signal?.throwIfAborted()
    const hits = await this.call<MilvusHit[]>('entities/search', { collectionName: name, data: [vector], annsField: 'vector', filter, limit: topK,
      groupByField: 'ticket_id', groupParams: { groupByField: 'ticket_id', groupSize: 1 },
      outputFields: ['ticket_id', 'content_hash', 'source_version', 'field', 'part', 'start', 'end', 'text_hash'],
      consistencyLevel: 'Strong', searchParams: { metricType: 'COSINE' } }, signal)
    signal?.throwIfAborted()
    return hits
  }
  async search(name: string, vector: readonly number[], ticketIds: readonly string[], topK: number, signal?: AbortSignal): Promise<MilvusHit[]> {
    async function* batches() { for (let i = 0; i < ticketIds.length; i += 1000) yield ticketIds.slice(i, i + 1000) }
    return this.searchBatches(name, vector, batches(), topK, signal)
  }
  async searchBatches(name: string, vector: readonly number[], batches: AsyncIterable<readonly string[]>, topK: number, signal?: AbortSignal): Promise<MilvusHit[]> {
    signal?.throwIfAborted()
    let best: MilvusHit[] = [], pending: Promise<MilvusHit[]>[] = []
    const abort = new AbortController(), combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])])
    const flush = async () => {
      const outcomes = await Promise.allSettled(pending); pending = []
      const failure = outcomes.find(o => o.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      const unique = new Map<string, MilvusHit>()
      const hits = [...best, ...outcomes.flatMap(o => o.status === 'fulfilled' ? o.value : [])]
      for (const hit of hits.sort((a, b) => b.distance - a.distance || a.ticket_id.localeCompare(b.ticket_id))) if (!unique.has(hit.ticket_id)) unique.set(hit.ticket_id, hit)
      best = [...unique.values()].slice(0, topK)
    }
    try {
      for await (const batch of batches) {
        combined.throwIfAborted()
        if (!batch.length) continue
        const request = this.searchFilter(name, vector, `ticket_id in ${JSON.stringify(batch)}`, topK, combined).then(hits => {
          if (hits.some(h => !batch.includes(h.ticket_id))) throw new Error('Milvus returned an ID outside the authorized filter')
          return hits
        })
        // Attach a rejection handler immediately, including while the next SQL batch is in flight.
        pending.push(request); void request.catch(error => { abort.abort(error) })
        if (pending.length === 4) await flush()
      }
      await flush(); combined.throwIfAborted(); return best
    } catch (error) { abort.abort(error); await Promise.allSettled(pending); throw error }
  }
}
