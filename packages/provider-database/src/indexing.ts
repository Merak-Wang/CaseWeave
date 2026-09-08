import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import { sha256, stableJson } from '@retrieval-agent/provider-local'
import { ticketChunks } from './projection.js'
import { TicketDatabase, type EmbeddingIdentity } from './store.js'
import { MilvusClient } from './milvus.js'

/** Immutable collections + SQL publication fence. Checkpoint only after Milvus acknowledges an idempotent upsert. */
export async function buildIndex(db: TicketDatabase, milvus: MilvusClient, model: RetrievalModelGateway, generation: string,
  identity: EmbeddingIdentity, options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void; batchSize?: number } = {}): Promise<string> {
  const source = await db.generation(generation)
  const records = await db.records(generation)
  const chunks = records.flatMap(record => ticketChunks(record, identity.chunkChars))
  const id = sha256(stableJson({ generation, identity })); const collection = `ra_${id.slice(0, 40)}`
  const connection = await db.pool.getConnection(); const lock = `ra-index-${id.slice(0, 48)}`
  let ownsLock = false
  try {
    const locks = await db.rows<{ acquired: number }>('SELECT 1 AS acquired')
    if (!locks.length) throw new Error('Database unavailable')
    const [result] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [lock])
    if ((result as { acquired: number }[])[0]?.acquired !== 1) throw new Error('Index generation already has an active worker')
    ownsLock = true
    await db.pool.query('INSERT IGNORE INTO ra_index(id,generation,collection_name,identity_json,status,total_chunks,watermark) VALUES (?,?,?,?,?,?,?)', [id, generation, collection, JSON.stringify(identity), 'building', chunks.length, source.source_watermark])
    await milvus.ensureCollection(collection, identity)
    const completed = new Set((await db.rows<{ chunk_id: string }>('SELECT chunk_id FROM ra_index_checkpoint WHERE index_id=?', [id])).map(r => r.chunk_id))
    const remaining = chunks.filter(chunk => !completed.has(chunk.id))
    const cacheIdentity = sha256(stableJson({ model: identity.model, revision: identity.revision, dimensions: identity.dimensions, normalization: identity.normalization, inputType: 'document' }))
    let count = completed.size; const batchSize = options.batchSize ?? 16
    for (let offset = 0; offset < remaining.length; offset += batchSize) {
      options.signal?.throwIfAborted()
      const batch = remaining.slice(offset, offset + batchSize)
      const cached = await db.rows<{ text_hash: string; vector_json: number[] }>('SELECT text_hash,vector_json FROM ra_embedding_cache WHERE identity_hash=? AND text_hash IN (?)', [cacheIdentity, batch.map(c => c.textHash)])
      const vectors = new Map(cached.map(r => [r.text_hash, r.vector_json]))
      const missing = [...new Map(batch.filter(c => !vectors.has(c.textHash)).map(c => [c.textHash, c])).values()]
      if (missing.length) {
        const embedded = await model.embed({ texts: missing.map(c => c.text), inputType: 'document', requireCompleteInput: true, ...(options.signal ? { signal: options.signal } : {}) })
        if (embedded.length !== missing.length) throw new Error('Model returned wrong embedding cardinality')
        missing.forEach((c, i) => vectors.set(c.textHash, [...embedded[i]!]))
        await db.pool.query('INSERT IGNORE INTO ra_embedding_cache(identity_hash,text_hash,vector_json) VALUES ?', [missing.map(c => [cacheIdentity, c.textHash, JSON.stringify(vectors.get(c.textHash))])])
      }
      await milvus.upsert(collection, batch, batch.map(c => vectors.get(c.textHash)!), options.signal)
      await connection.beginTransaction()
      try {
        await connection.query('INSERT IGNORE INTO ra_index_checkpoint(index_id,chunk_id) VALUES ?', [batch.map(c => [id, c.id])])
        count += batch.length
        await connection.query('UPDATE ra_index SET completed_chunks=?,status=? WHERE id=?', [count, 'building', id])
        await connection.commit()
      } catch (error) { await connection.rollback(); throw error }
      options.onProgress?.(count, chunks.length)
    }
    const actual = await milvus.count(collection)
    if (actual !== chunks.length) throw new Error(`Milvus generation count mismatch: ${actual}/${chunks.length}`)
    await db.pool.query('UPDATE ra_index SET status=?,completed_chunks=? WHERE id=?', ['ready', chunks.length, id])
    return id
  } catch (error) {
    if (ownsLock) await db.pool.query('UPDATE ra_index SET status=? WHERE id=? AND status<>?', ['failed', id, 'ready'])
    throw error
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [lock]); connection.release() }
}
