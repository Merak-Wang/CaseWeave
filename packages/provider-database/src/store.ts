import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import { normalizeLiteral, type NormalizedTicketRecord, type QueryExpression, type QueryFieldCapability } from '@retrieval-agent/contracts'
import { sha256, stableJson } from '@retrieval-agent/provider-local'
import { fieldCapabilities, grams, queryDocument } from './projection.js'
import { compileSql, necessaryGrams } from './sql.js'

const DDL = [
  `CREATE TABLE IF NOT EXISTS ra_provider_snapshot (id VARCHAR(191) PRIMARY KEY, dataset_id VARCHAR(191) NOT NULL, generation CHAR(64) NOT NULL, index_id CHAR(64) NULL, snapshot_json JSON NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ra_generation (id CHAR(64) PRIMARY KEY, dataset_id VARCHAR(191) NOT NULL, source_watermark VARCHAR(255) NOT NULL, mapping_version VARCHAR(100) NOT NULL, status VARCHAR(20) NOT NULL, record_count INT NOT NULL, fields_json JSON NOT NULL, grams_ready BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
  `CREATE TABLE IF NOT EXISTS ra_ticket (generation CHAR(64) NOT NULL, ticket_id VARCHAR(191) NOT NULL, content_hash CHAR(64) NOT NULL, source_version VARCHAR(255) NOT NULL, record_json JSON NOT NULL, PRIMARY KEY(generation,ticket_id))`,
  `CREATE TABLE IF NOT EXISTS ra_search_field (generation CHAR(64) NOT NULL, ticket_id VARCHAR(191) NOT NULL, field_key VARCHAR(191) NOT NULL, part INT NOT NULL, text_value MEDIUMTEXT NOT NULL, PRIMARY KEY(generation,ticket_id,field_key,part))`,
  `CREATE TABLE IF NOT EXISTS ra_field_value (generation CHAR(64) NOT NULL, ticket_id VARCHAR(191) NOT NULL, field_key VARCHAR(191) NOT NULL, part INT NOT NULL, text_value MEDIUMTEXT NULL, PRIMARY KEY(generation,ticket_id,field_key,part), INDEX field_lookup(generation,field_key,text_value(100)))`,
  `CREATE TABLE IF NOT EXISTS ra_gram (generation CHAR(64) NOT NULL, gram VARCHAR(8) NOT NULL, ticket_id VARCHAR(191) NOT NULL, PRIMARY KEY(generation,gram,ticket_id), INDEX ticket_lookup(generation,ticket_id))`,
  `CREATE TABLE IF NOT EXISTS ra_index (id CHAR(64) PRIMARY KEY, generation CHAR(64) NOT NULL, collection_name VARCHAR(191) NOT NULL, identity_json JSON NOT NULL, status VARCHAR(20) NOT NULL, completed_chunks INT NOT NULL DEFAULT 0, total_chunks INT NOT NULL, watermark VARCHAR(255) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ra_index_job (generation CHAR(64) NOT NULL, ticket_id VARCHAR(191) NOT NULL, operation VARCHAR(10) NOT NULL, source_hash CHAR(64) NOT NULL, PRIMARY KEY(generation,ticket_id))`,
  `CREATE TABLE IF NOT EXISTS ra_index_checkpoint (index_id CHAR(64) NOT NULL, chunk_id CHAR(64) NOT NULL, PRIMARY KEY(index_id,chunk_id))`,
  `CREATE TABLE IF NOT EXISTS ra_embedding_cache (identity_hash CHAR(64) NOT NULL, text_hash CHAR(64) NOT NULL, vector_json JSON NOT NULL, PRIMARY KEY(identity_hash,text_hash))`,
  `CREATE TABLE IF NOT EXISTS ra_publication (dataset_id VARCHAR(191) PRIMARY KEY, generation CHAR(64) NOT NULL, index_id CHAR(64) NULL, revision BIGINT NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS ra_search_run (id CHAR(64) PRIMARY KEY, generation CHAR(64) NOT NULL, binding_hash CHAR(64) NOT NULL, fingerprint CHAR(64) NOT NULL, status_json JSON NOT NULL, created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
  `CREATE TABLE IF NOT EXISTS ra_search_hit (run_id CHAR(64) NOT NULL, ticket_id VARCHAR(191) NOT NULL, channel VARCHAR(10) NOT NULL, rank_no INT NOT NULL, score DOUBLE NOT NULL, source_hash CHAR(64) NOT NULL, detail_json JSON NULL, PRIMARY KEY(run_id,ticket_id,channel))`,
]
export interface Generation { id: string; dataset_id: string; status: string; record_count: number; fields_json: QueryFieldCapability[]; grams_ready: number; source_watermark: string }
export interface IndexGeneration { id: string; generation: string; collection_name: string; identity_json: EmbeddingIdentity; status: string; total_chunks: number; completed_chunks: number; watermark: string }
export interface EmbeddingIdentity { model: string; revision: string; dimensions: number; normalization: 'l2'; metric: 'COSINE'; chunkChars: number; chunkVersion: 'field-codepoints-v3' }
export class TicketDatabase {
  readonly pool: Pool
  constructor(url = 'mysql://root@127.0.0.1:13306/retrieval_agent') { this.pool = createPool({ uri: url, connectionLimit: 8, charset: 'utf8mb4_bin', timezone: 'Z' }) }
  async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params); return rows as T[]
  }
  async migrate(): Promise<void> {
    for (const ddl of DDL) await this.pool.query(`${ddl} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
    const column = (await this.rows<{ DATA_TYPE: string }>('SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', ['ra_field_value', 'text_value']))[0]
    // Upgrade an earlier local preview in place; never truncate source scalar values.
    if (column?.DATA_TYPE !== 'mediumtext') await this.pool.query('ALTER TABLE ra_field_value MODIFY text_value MEDIUMTEXT NULL')
  }
  async close(): Promise<void> { await this.pool.end() }
  async generation(id: string): Promise<Generation> {
    const row = (await this.rows<Generation>('SELECT * FROM ra_generation WHERE id=? AND status=?', [id, 'ready']))[0]
    if (!row) throw new Error('Dataset generation is unavailable'); return row
  }
  async records(generation: string): Promise<NormalizedTicketRecord[]> {
    return (await this.rows<{ record_json: NormalizedTicketRecord }>('SELECT record_json FROM ra_ticket WHERE generation=? ORDER BY ticket_id', [generation])).map(r => r.record_json)
  }
  async importRecords(datasetId: string, records: readonly NormalizedTicketRecord[], watermark: string, onProgress?: (n: number) => void): Promise<string> {
    if (!records.length || new Set(records.map(r => r.ticketId)).size !== records.length) throw new TypeError('Import requires nonempty unique ticket identities')
    const id = sha256(stableJson({ datasetId, watermark, mapping: 'normalized-fields-v2', normalization: 'nfkc-lower-v1', records }))
    const fields = fieldCapabilities(records)
    const connection = await this.pool.getConnection()
    const lock = `ra-import-${id.slice(0, 48)}`
    try {
      const [locks] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?,0) AS acquired', [lock])
      if (locks[0]?.acquired !== 1) throw new Error('This generation is already being imported')
      const existing = await this.rows<Generation>('SELECT * FROM ra_generation WHERE id=?', [id])
      if (existing[0]?.status === 'ready') return id
      await connection.query('INSERT IGNORE INTO ra_generation(id,dataset_id,source_watermark,mapping_version,status,record_count,fields_json) VALUES (?,?,?,?,?,?,?)', [id, datasetId, watermark, 'normalized-fields-v2', 'building', records.length, JSON.stringify(fields)])
      const published = (await this.rows<{ generation: string }>('SELECT generation FROM ra_publication WHERE dataset_id=?', [datasetId]))[0]
      const previous = published ? new Map((await this.records(published.generation)).map(r => [r.ticketId as string, r.contentHash])) : new Map<string, string>()
      for (let offset = 0; offset < records.length; offset += 100) {
        const batch = records.slice(offset, offset + 100)
        await connection.beginTransaction()
        try {
          await connection.query('INSERT IGNORE INTO ra_ticket(generation,ticket_id,content_hash,source_version,record_json) VALUES ?', [batch.map(r => [id, r.ticketId, r.contentHash, r.sourceVersion, JSON.stringify(r)])])
          const textRows: unknown[][] = []; const valueRows: unknown[][] = []; const jobs: unknown[][] = []
          for (const record of batch) {
            const doc = queryDocument(record)
            for (const [field, values] of Object.entries(doc.texts)) values.forEach((value, part) => textRows.push([id, record.ticketId, field, part, normalizeLiteral(value)]))
            for (const [field, value] of Object.entries(doc.fields)) {
              const values = value === null ? [null] : typeof value === 'string' ? [value] : value
              values.forEach((v, part) => valueRows.push([id, record.ticketId, field, part, v === null ? null : normalizeLiteral(v)]))
            }
            if (previous.get(record.ticketId) !== record.contentHash) jobs.push([id, record.ticketId, 'upsert', record.contentHash])
            previous.delete(record.ticketId)
          }
          if (textRows.length) await connection.query('INSERT IGNORE INTO ra_search_field(generation,ticket_id,field_key,part,text_value) VALUES ?', [textRows])
          if (valueRows.length) await connection.query('INSERT IGNORE INTO ra_field_value(generation,ticket_id,field_key,part,text_value) VALUES ?', [valueRows])
          if (jobs.length) await connection.query('INSERT IGNORE INTO ra_index_job(generation,ticket_id,operation,source_hash) VALUES ?', [jobs])
          await connection.commit()
        } catch (error) { await connection.rollback(); throw error }
        onProgress?.(Math.min(offset + batch.length, records.length))
      }
      if (previous.size) await connection.query('INSERT IGNORE INTO ra_index_job(generation,ticket_id,operation,source_hash) VALUES ?', [[...previous].map(([ticket, hash]) => [id, ticket, 'delete', hash])])
      await connection.query('UPDATE ra_generation SET status=? WHERE id=?', ['ready', id])
      return id
    } finally { await connection.query('SELECT RELEASE_LOCK(?)', [lock]); connection.release() }
  }
  async *enumerate(generation: string, expression: QueryExpression, fields: readonly QueryFieldCapability[], options: { pageSize?: number; after?: string; accelerate?: boolean; signal?: AbortSignal } = {}): AsyncGenerator<{ records: NormalizedTicketRecord[]; cursor: string; elapsedMs: number }> {
    const required = options.accelerate ? necessaryGrams(expression) : []
    const counts = required.length ? await this.rows<{ gram: string; n: number }>('SELECT gram,COUNT(*) AS n FROM ra_gram WHERE generation=? AND gram IN (?) GROUP BY gram', [generation, required]) : []
    const best = required.sort((a, b) => (counts.find(c => c.gram === a)?.n ?? 0) - (counts.find(c => c.gram === b)?.n ?? 0))[0]
    // Broad posting lists measured slower than scanning; reserve the forced join for selective grams.
    const selective = best !== undefined && (counts.find(c => c.gram === best)?.n ?? 0) <= (await this.generation(generation)).record_count / 10
    const gram = selective ? best : undefined
    const compiled = compileSql(expression, fields, options.accelerate && (required.length === 0 || selective))
    let after = options.after ?? ''; const width = options.pageSize ?? 100
    if (!Number.isInteger(width) || width < 1 || width > 1000) throw new TypeError('Invalid SQL page size')
    while (true) {
      options.signal?.throwIfAborted(); const started = performance.now()
      const from = gram === undefined ? 'ra_ticket t' : 'ra_gram accelerator STRAIGHT_JOIN ra_ticket t ON t.generation=accelerator.generation AND t.ticket_id=accelerator.ticket_id'
      const rows = await this.rows<{ ticket_id: string; record_json: NormalizedTicketRecord }>(`SELECT t.ticket_id,t.record_json FROM ${from} WHERE ${gram === undefined ? '' : 'accelerator.generation=? AND accelerator.gram=? AND '}t.generation=? AND t.ticket_id>? AND (${compiled.sql}) IS TRUE ORDER BY t.ticket_id LIMIT ?`, [...(gram === undefined ? [] : [generation, gram]), generation, after, ...compiled.params, width])
      options.signal?.throwIfAborted()
      if (!rows.length) return
      after = rows.at(-1)!.ticket_id
      yield { records: rows.map(r => r.record_json), cursor: after, elapsedMs: performance.now() - started }
      if (rows.length < width) return
    }
  }
  async *enumerateIds(generation: string, expression: QueryExpression, fields: readonly QueryFieldCapability[], signal?: AbortSignal): AsyncGenerator<string[]> {
    const compiled = compileSql(expression, fields); let after = ''
    while (true) {
      signal?.throwIfAborted()
      const rows = await this.rows<{ ticket_id: string }>(`SELECT t.ticket_id FROM ra_ticket t WHERE t.generation=? AND t.ticket_id>? AND (${compiled.sql}) IS TRUE ORDER BY t.ticket_id LIMIT 1000`, [generation, after, ...compiled.params])
      signal?.throwIfAborted()
      if (!rows.length) return
      yield rows.map(r => r.ticket_id)
      if (rows.length < 1000) return
      after = rows.at(-1)!.ticket_id
    }
  }
  async buildGrams(generation: string, onProgress?: (n: number) => void): Promise<void> {
    const records = await this.records(generation)
    for (let i = 0; i < records.length; i += 25) {
      const rows = records.slice(i, i + 25).flatMap(record => {
        const all = new Set(Object.values(queryDocument(record).texts).flat().flatMap(grams))
        return [...all].map(gram => [generation, gram, record.ticketId])
      })
      if (rows.length) await this.pool.query('INSERT IGNORE INTO ra_gram(generation,gram,ticket_id) VALUES ?', [rows])
      if (i % 100 === 0) onProgress?.(i)
    }
    await this.pool.query('UPDATE ra_generation SET grams_ready=TRUE WHERE id=?', [generation])
  }
  async publish(datasetId: string, generation: string, indexId?: string): Promise<void> {
    const source = await this.generation(generation)
    if (source.dataset_id !== datasetId) throw new Error('Dataset identity mismatch')
    if (indexId !== undefined) {
      const index = (await this.rows<IndexGeneration>('SELECT * FROM ra_index WHERE id=? AND status=?', [indexId, 'ready']))[0]
      if (!index || index.generation !== generation || index.watermark !== source.source_watermark || index.completed_chunks !== index.total_chunks) throw new Error('SQL/vector generation mismatch or incomplete index')
    }
    await this.pool.query('INSERT INTO ra_publication(dataset_id,generation,index_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE generation=VALUES(generation),index_id=VALUES(index_id),revision=revision+1', [datasetId, generation, indexId ?? null])
  }
  async publication(datasetId: string): Promise<{ source: Generation; index?: IndexGeneration }> {
    const row = (await this.rows<{ generation: string; index_id: string | null }>('SELECT * FROM ra_publication WHERE dataset_id=?', [datasetId]))[0]
    if (!row) throw new Error(`No published dataset: ${datasetId}`)
    const source = await this.generation(row.generation)
    const index = row.index_id ? (await this.rows<IndexGeneration>('SELECT * FROM ra_index WHERE id=?', [row.index_id]))[0] : undefined
    if (index && (index.generation !== source.id || index.status !== 'ready' || index.watermark !== source.source_watermark)) throw new Error('Published SQL/vector generation mismatch')
    return { source, ...(index ? { index } : {}) }
  }
}
