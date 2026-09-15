import { RetrievalError, assertTrustedPrincipal, type NormalizedTicketRecord, type QueryExpression, type QueryFieldCapability,
  type TicketFieldDescriptor, type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LEGACY_FIELD_CATALOG, stableJson, overviewOrigin } from '@retrieval-agent/provider-local'
import type { TicketDatabase } from './store.js'
import { compileSql, necessaryGrams } from './sql.js'

export const QUERY_DDL = [
  `CREATE TABLE IF NOT EXISTS ra_ticket_access (generation CHAR(64) NOT NULL, ticket_id VARCHAR(191) NOT NULL, tenant_id VARCHAR(191) NOT NULL, pii_reviewed BOOLEAN NOT NULL, subjects JSON NOT NULL, attributes JSON NOT NULL, overview_json JSON NOT NULL, PRIMARY KEY(generation,ticket_id), INDEX tenant_scope(generation,tenant_id,pii_reviewed,ticket_id))`,
  `CREATE TABLE IF NOT EXISTS ra_provider_candidate (snapshot_id VARCHAR(191) NOT NULL, candidate_ref VARCHAR(191) NOT NULL, ticket_id VARCHAR(191) NOT NULL, source_hash CHAR(64) NOT NULL, PRIMARY KEY(snapshot_id,candidate_ref))`,
  `CREATE TABLE IF NOT EXISTS ra_generation_catalog (generation CHAR(64) PRIMARY KEY, catalog_json JSON NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ra_search_candidate (run_id CHAR(64) NOT NULL, ticket_id VARCHAR(191) NOT NULL, keyword_hit BOOLEAN NOT NULL DEFAULT FALSE, vector_rank INT NULL, vector_score DOUBLE NULL, fused_score DOUBLE NOT NULL DEFAULT 0, PRIMARY KEY(run_id,ticket_id), INDEX ranked_page(run_id,fused_score DESC,ticket_id))`,
]
// The overview retains identity, access metadata and L0/L1 only. Original fields are read by ID.
const overviewSql = `JSON_REMOVE(record_json,'$.problemDescription','$.conversationOrUpdates','$.resolutionSteps','$.rootCause','$.answer','$.searchText','$.additionalEvidence','$.rawSource.payload')`
export async function prepareAccess(db: TicketDatabase, generation?: string): Promise<void> {
  await db.pool.query(`INSERT IGNORE INTO ra_ticket_access(generation,ticket_id,tenant_id,pii_reviewed,subjects,attributes,overview_json)
    SELECT generation,ticket_id,record_json->>'$.tenantId',record_json->>'$.piiRedactionStatus'<>'unreviewed',
      record_json->'$.allowedSubjectIds',record_json->'$.requiredAttributes',${overviewSql} FROM ra_ticket
      WHERE ${generation ? 'generation=? AND ' : ''}NOT EXISTS (SELECT 1 FROM ra_ticket_access a WHERE a.generation=ra_ticket.generation AND a.ticket_id=ra_ticket.ticket_id)`, generation ? [generation] : [])
}
function grant(alias: string, p: TrustedPrincipalContext): { sql: string; params: unknown[] } {
  return { sql: `${alias}.tenant_id=? AND ${alias}.pii_reviewed=TRUE
    AND (JSON_LENGTH(${alias}.subjects)=0 OR JSON_CONTAINS(${alias}.subjects,CAST(? AS JSON)))
    AND NOT EXISTS (SELECT 1 FROM JSON_TABLE(JSON_KEYS(${alias}.attributes),'$[*]' COLUMNS(attribute_key VARCHAR(191) PATH '$')) required_key
      WHERE JSON_LENGTH(JSON_EXTRACT(${alias}.attributes,CONCAT('$.',JSON_QUOTE(required_key.attribute_key))))>0
      AND NOT JSON_OVERLAPS(JSON_EXTRACT(${alias}.attributes,CONCAT('$.',JSON_QUOTE(required_key.attribute_key))),
        COALESCE(JSON_EXTRACT(CAST(? AS JSON),CONCAT('$.',JSON_QUOTE(required_key.attribute_key))),JSON_ARRAY())))`,
    params: [p.tenantId, JSON.stringify(p.subjectId), JSON.stringify(p.attributes)] }
}
export interface QueryScope { from: string; where: string; params: unknown[] }
export class DatabaseQueryStore {
  constructor(readonly db: TicketDatabase) {}
  async scope(generation: string, current: string, principal: TrustedPrincipalContext, expression: QueryExpression,
    fields: readonly QueryFieldCapability[], accelerate = false): Promise<QueryScope> {
    const required = accelerate ? necessaryGrams(expression) : []
    const counts = required.length ? await this.db.rows<{ gram: string; n: number }>('SELECT gram,COUNT(*) n FROM ra_gram WHERE generation=? AND gram IN (?) GROUP BY gram', [generation, required]) : []
    const best = required.sort((a, b) => (counts.find(c => c.gram === a)?.n ?? 0) - (counts.find(c => c.gram === b)?.n ?? 0))[0]
    const selective = best !== undefined && (counts.find(c => c.gram === best)?.n ?? 0) <= (await this.db.generation(generation)).record_count / 10
    const gram = selective ? best : undefined
    const compiled = compileSql(expression, fields, accelerate && (required.length === 0 || selective)), original = grant('a', principal), latest = grant('ca', principal)
    return { from: (gram ? 'ra_gram accelerator STRAIGHT_JOIN ra_ticket t ON t.generation=accelerator.generation AND t.ticket_id=accelerator.ticket_id' : 'ra_ticket t')
      + ' JOIN ra_ticket_access a ON a.generation=t.generation AND a.ticket_id=t.ticket_id'
      + (current === generation ? '' : ' JOIN ra_ticket ct ON ct.generation=? AND ct.ticket_id=t.ticket_id JOIN ra_ticket_access ca ON ca.generation=ct.generation AND ca.ticket_id=ct.ticket_id'),
    where: `${gram ? 'accelerator.generation=? AND accelerator.gram=? AND ' : ''}t.generation=? AND (${original.sql}) AND (${compiled.sql}) IS TRUE`
      + (current === generation ? '' : ` AND ct.content_hash=t.content_hash AND ct.source_version=t.source_version AND (${latest.sql})`),
    params: [...(current === generation ? [] : [current]), ...(gram ? [generation, gram] : []), generation, ...original.params, ...compiled.params, ...(current === generation ? [] : latest.params)] }
  }
  async count(scope: QueryScope): Promise<number> {
    return Number((await this.db.rows<{ n: number }>(`SELECT COUNT(*) n FROM ${scope.from} WHERE ${scope.where}`, scope.params))[0]!.n)
  }
  async *ids(scope: QueryScope, width = 500, signal?: AbortSignal): AsyncGenerator<string[]> {
    let after = ''
    while (true) {
      signal?.throwIfAborted()
      const rows = await this.db.rows<{ ticket_id: string }>(`SELECT t.ticket_id FROM ${scope.from} WHERE ${scope.where} AND t.ticket_id>? ORDER BY t.ticket_id LIMIT ?`, [...scope.params, after, width])
      signal?.throwIfAborted()
      if (!rows.length) return
      yield rows.map(r => r.ticket_id)
      if (rows.length < width) return
      after = rows.at(-1)!.ticket_id
    }
  }
  async catalog(generation: string): Promise<TicketFieldDescriptor[]> {
    const saved = (await this.db.rows<{ catalog_json: TicketFieldDescriptor[] }>('SELECT catalog_json FROM ra_generation_catalog WHERE generation=?', [generation]))[0]
    if (saved) return saved.catalog_json
    const rows = await this.db.rows<{ fields: TicketFieldDescriptor[] | null }>("SELECT DISTINCT record_json->'$.fieldCatalog' AS fields FROM ra_ticket WHERE generation=?", [generation])
    const result = new Map(LEGACY_FIELD_CATALOG.map(f => [f.key, f]))
    for (const row of rows) for (const field of row.fields ?? []) {
      const old = result.get(field.key)
      if (old && stableJson(old) !== stableJson(field)) throw new RetrievalError('PROTOCOL_MISMATCH', '来源字段声明冲突。')
      result.set(field.key, field)
    }
    const catalog = [...result.values()].sort((a, b) => a.key.localeCompare(b.key))
    await this.db.pool.query('INSERT IGNORE INTO ra_generation_catalog(generation,catalog_json) VALUES (?,?)', [generation, JSON.stringify(catalog)])
    return catalog
  }
  async records(generation: string, ids: readonly string[], full: boolean): Promise<NormalizedTicketRecord[]> {
    if (!ids.length) return []
    const rows = await this.db.rows<{ record: NormalizedTicketRecord; source_row_hash?: string }>(full
      ? 'SELECT record_json AS record FROM ra_ticket WHERE generation=? AND ticket_id IN (?)'
      : "SELECT a.overview_json AS record,t.record_json->>'$.rawSource.payload.transformation.source_row_sha256' AS source_row_hash FROM ra_ticket_access a JOIN ra_ticket t ON t.generation=a.generation AND t.ticket_id=a.ticket_id WHERE a.generation=? AND a.ticket_id IN (?)", [generation, ids])
    return rows.map(({ record, source_row_hash }) => {
      // Read only the provenance hash alongside L0/L1; original dialogue stays behind the detail/evidence entry.
      const originRecord = source_row_hash && record.rawSource ? { ...record, rawSource: { ...record.rawSource,
        payload: { transformation: { source_row_sha256: source_row_hash } } } } : record
      return { ...record, titleOrigin: overviewOrigin(originRecord, 'title'), summaryOrigin: overviewOrigin(originRecord, 'summary') }
    })
  }
  async validate(generation: string, current: string, ids: readonly string[], principal: TrustedPrincipalContext): Promise<void> {
    assertTrustedPrincipal(principal)
    if (!ids.length) return
    const currentGrant = grant('ca', principal), oldGrant = grant('a', principal)
    const rows = await this.db.rows<{ ticket_id: string; unchanged: number; allowed: number }>(`SELECT t.ticket_id,
      (ct.content_hash=t.content_hash AND ct.source_version=t.source_version) AS unchanged,
      ((${oldGrant.sql}) AND (${currentGrant.sql})) AS allowed
      FROM ra_ticket t JOIN ra_ticket_access a ON a.generation=t.generation AND a.ticket_id=t.ticket_id
      LEFT JOIN ra_ticket ct ON ct.generation=? AND ct.ticket_id=t.ticket_id
      LEFT JOIN ra_ticket_access ca ON ca.generation=ct.generation AND ca.ticket_id=ct.ticket_id
      WHERE t.generation=? AND t.ticket_id IN (?)`, [...oldGrant.params, ...currentGrant.params, current, generation, ids])
    if (rows.length !== new Set(ids).size || rows.some(r => !r.unchanged)) throw new RetrievalError('SNAPSHOT_INVALID', '引用的工单来源已更新或删除，请重新核对受影响证据。')
    if (rows.some(r => !r.allowed)) throw new RetrievalError('UNAUTHORIZED', '引用工单的当前访问资格已撤销。')
  }
}
