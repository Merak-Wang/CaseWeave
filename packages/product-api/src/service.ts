import { createHash, randomUUID } from 'node:crypto'
import {
  RetrievalError,
  isReadableTicketField,
  type CandidateExportReceipt,
  type RetrievalState,
  type TicketCandidateRef,
  type TicketDetail,
  type TicketRetrievalProvider,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { encodeCsv, csvCell } from './csv.js'
import { hostAuthorizedCandidates } from './candidate-selection.js'
import { createTicketResultCollection } from '@retrieval-agent/domain/result'

export interface ExportAuditRecord {
  readonly auditId: string
  readonly exportId: string
  readonly retrievalId: string
  readonly tenantId: string
  readonly subjectId: string
  readonly entitlementVersion: string
  readonly snapshotShortId: string
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly fields: readonly string[]
  readonly rowCount: number
  readonly contentSha256: string
  readonly generatedAt: string
  readonly resultRevision: string
}
export interface ExportAuditSink {
  append(record: ExportAuditRecord): Promise<void> | void
}

export class InMemoryExportAuditSink implements ExportAuditSink {
  readonly records: ExportAuditRecord[] = []
  append(record: ExportAuditRecord): void { this.records.push(record) }
}

export interface CandidateExport {
  readonly fileName: string
  readonly mediaType: 'text/csv; charset=utf-8'
  readonly content: string
  readonly receipt: CandidateExportReceipt
}

export interface CandidateExportServiceConfig {
  readonly maxRows?: number
  readonly maxBytes?: number
  readonly now?: () => Date
  readonly id?: () => string
  readonly pageSize?: number
  /** The Host checks live task identity after asynchronous Provider work. */
  readonly assertCurrentResult?: () => void | Promise<void>
}

const HEADERS = [
  'query', 'exported_at', 'snapshot', 'completeness', 'rank', 'ticket', 'title', 'summary',
  'type', 'category', 'product', 'component', 'region', 'status', 'priority', 'created_at',
  'source_version', 'evidence_level', 'judgment', 'judgment_reason', 'evidence_ids', 'evidence_readers',
  'result_revision', 'candidate_ref', 'content_hash', 'judgment_evidence_refs', 'query_conditions', 'stopping_reason',
] as const

/** Trusted-host application service; every detail/export operation re-enters the Provider. */
export class CandidateExportService {
  readonly #provider: TicketRetrievalProvider
  readonly #audit: ExportAuditSink
  readonly #maxRows: number
  readonly #maxBytes: number
  readonly #now: () => Date
  readonly #id: () => string
  readonly #pageSize: number
  readonly #assertCurrentResult: () => void | Promise<void>

  constructor(provider: TicketRetrievalProvider, audit: ExportAuditSink, config: CandidateExportServiceConfig = {}) {
    this.#provider = provider
    this.#audit = audit
    this.#maxRows = config.maxRows ?? Number.POSITIVE_INFINITY
    this.#maxBytes = config.maxBytes ?? 50_000_000
    this.#pageSize = config.pageSize ?? 100
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 200) {
      throw new RangeError('export pageSize must be between 1 and 200')
    }
    this.#assertCurrentResult = config.assertCurrentResult ?? (() => {})
    this.#now = config.now ?? (() => new Date())
    this.#id = config.id ?? (() => randomUUID())
  }

  async exportCsv(
    principal: TrustedPrincipalContext,
    state: RetrievalState,
    refs?: readonly TicketCandidateRef[],
    signal?: AbortSignal,
  ): Promise<CandidateExport> {
    const parts: string[] = []
    const file = await this.stream(principal, state, { format: 'csv', template: 'summary' }, async part => { parts.push(part) }, refs, signal)
    return { ...file, mediaType: 'text/csv; charset=utf-8', content: parts.join('') }
  }

  /** Staging sink only: the Host publishes bytes after the final grant/result check. */
  async stream(
    principal: TrustedPrincipalContext, state: RetrievalState,
    options: { format: 'csv' | 'jsonl'; template: 'summary' | 'full' },
    write: (chunk: string, rows: number) => Promise<void>, refs?: readonly TicketCandidateRef[], signal?: AbortSignal,
  ): Promise<{ fileName: string; mediaType: string; receipt: CandidateExportReceipt }> {
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '检索快照不存在。')
    if (!state.snapshot.capabilities.exportRead) throw new RetrievalError('FIELD_NOT_ALLOWED', '当前数据源未开放工单下载。')
    if (!['csv', 'jsonl'].includes(options.format) || !['summary', 'full'].includes(options.template)) throw new RetrievalError('INVALID_REQUEST', '下载格式或字段模板无效。')
    const result = createTicketResultCollection(state)
    const confirmed = new Map(result.tickets.map(c => [c.ref, c]))
    const selectedRefs = refs ?? [...confirmed.keys()]
    if (selectedRefs.some(ref => !confirmed.has(ref))) throw new RetrievalError('CANDIDATE_NOT_FOUND', '下载只能包含当前结果版本中已确认的工单。')
    const candidates = hostAuthorizedCandidates(state, selectedRefs)
    if (candidates.length > this.#maxRows) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '候选数量超过单次导出限制。')
    const fields = options.template === 'full' ? state.snapshot.fieldCatalog.filter(isReadableTicketField).map(f => f.key) : []
    const headers = options.template === 'full' ? [...HEADERS, 'body_fields', 'unavailable_fields'] : [...HEADERS]
    const authorize = async () => {
      if (signal?.aborted) throw new RetrievalError('CANCELLED', '下载已取消。')
      const status = await this.#provider.status(principal, state.snapshot!.snapshotId)
      if (status.providerId !== this.#provider.providerId || state.snapshot!.providerId && state.snapshot!.providerId !== this.#provider.providerId) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '下载来源与当前检索 Provider 不一致。')
      }
      if (status.snapshotValid !== true) throw new RetrievalError('SNAPSHOT_INVALID', '检索快照已失效，请重新检索后导出。')
      await this.#assertCurrentResult()
    }
    await authorize()
    const generatedAt = this.#now().toISOString(), hash = createHash('sha256')
    let bytes = 0, rowCount = 0
    const emit = async (text: string) => {
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > this.#maxBytes) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '导出文件超过大小限制。')
      hash.update(text, 'utf8'); await write(text, rowCount)
    }
    if (options.format === 'csv') await emit(encodeCsv(headers, []))
    const evidenceByRef = new Map<string, typeof result.evidence[number][]>()
    for (const e of result.evidence) { const list = evidenceByRef.get(e.candidateRef) ?? []; list.push(e); evidenceByRef.set(e.candidateRef, list) }
    const judgments = new Map(result.judgments.map(j => [j.candidateRef, j]))
    for (let offset = 0; offset < candidates.length; offset += this.#pageSize) {
      if (signal?.aborted) throw new RetrievalError('CANCELLED', '下载已取消。')
      const page = candidates.slice(offset, offset + this.#pageSize)
      const details = await this.#provider.readDetails(principal, { snapshotId: state.snapshot.snapshotId,
        candidateRefs: page.map(c => c.ref), fields, purpose: 'candidate_export' }, signal ? { signal } : undefined)
      await this.#assertCurrentResult()
      if (details.snapshotId !== state.snapshot.snapshotId) throw new RetrievalError('PROTOCOL_MISMATCH', '下载响应不属于当前来源快照。')
      if (details.rejectedCandidateRefs.length || details.details.length !== page.length) throw new RetrievalError('UNAUTHORIZED', '部分确认工单已不可导出，请重新复核。')
      const byRef = new Map<TicketCandidateRef, TicketDetail>()
      const allowed = new Set(page.map(c => c.ref))
      for (const d of details.details) {
        if (!allowed.delete(d.candidateRef) || Object.keys(d.fields).some(f => !fields.includes(f)) || d.unavailableFields.some(f => !fields.includes(f))) {
          throw new RetrievalError('PROTOCOL_MISMATCH', '下载响应包含重复、未请求的工单或越权字段。')
        }
        if (fields.some(f => !Object.hasOwn(d.fields, f) && !d.unavailableFields.includes(f))) throw new RetrievalError('PROTOCOL_MISMATCH', '下载响应未说明所请求字段是否缺失。')
        if (Object.values(d.fields).some(values => !Array.isArray(values) || values.some(value => typeof value !== 'string'))
          || d.unavailableFields.some(f => Object.hasOwn(d.fields, f))) throw new RetrievalError('PROTOCOL_MISMATCH', '下载字段值或缺失声明无效。')
        byRef.set(d.candidateRef, d)
      }
      for (const c of page) {
        const d = byRef.get(c.ref)!
        if (d.sourceVersion !== c.sourceVersion || d.displayId !== c.displayId || d.title !== c.title || d.summary !== c.summary) throw new RetrievalError('SNAPSHOT_INVALID', '工单来源版本已变化，请重新检索后导出。')
        const evidence = evidenceByRef.get(c.ref) ?? [], judgment = judgments.get(c.ref)
        const row = [state.query.original, generatedAt, state.snapshot.shortId, state.lastPage?.completeness ?? 'unknown',
          String(c.rank), d.displayId, d.title, d.summary, d.l0.type ?? '', d.l0.category ?? '', d.l0.product ?? '', d.l0.component ?? '',
          d.l0.region ?? '', d.l0.status ?? '', d.l0.priority ?? '', d.l0.createdAt ?? '', d.sourceVersion,
          confirmed.get(c.ref)!.evidenceLevel, 'confirmed', judgment?.reason ?? '', JSON.stringify(evidence.map(e => e.evidenceId)),
          JSON.stringify(Object.fromEntries(evidence.map(e => [e.evidenceId, e.readers ?? ['unknown']]))), result.resultRevision, c.ref, c.contentHash,
          JSON.stringify(judgment?.evidenceRefs ?? []), JSON.stringify(state.query.confirmedConstraints), result.stoppingReason,
          ...(options.template === 'full' ? [JSON.stringify(d.fields), JSON.stringify(d.unavailableFields)] : [])]
        rowCount++
        await emit(options.format === 'csv' ? row.map(csvCell).join(',') + '\r\n' : JSON.stringify({
          schemaVersion: 1, ticketId: d.displayId, candidateRef: c.ref, title: d.title, summary: d.summary, summaryOrigin: c.summaryOrigin,
          l0: d.l0, fields: d.fields, unavailableFields: d.unavailableFields, sourceVersion: d.sourceVersion, contentHash: c.contentHash,
          resultRevision: result.resultRevision, judgment: { verdict: 'accept', reason: judgment?.reason ?? '', evidenceRefs: judgment?.evidenceRefs ?? [] },
          evidence: evidence.map(e => ({ evidenceId: e.evidenceId, field: e.field, start: e.start, end: e.end, text: e.text, origin: e.origin, spanHash: e.spanHash })),
          scope: { query: state.query.original, conditions: state.query.confirmedConstraints, snapshot: state.snapshot.shortId, stoppingReason: result.stoppingReason },
        }) + '\n')
      }
    }
    await authorize()
    const contentSha256 = hash.digest('hex'), exportId = this.#id(), auditId = this.#id()
    const receipt: CandidateExportReceipt = { exportId, retrievalId: state.retrievalId, snapshotShortId: state.snapshot.shortId,
      generatedAt, rowCount, fields: options.format === 'csv' ? headers : ['ticketId', 'candidateRef', 'title', 'summary', 'l0', 'fields', 'unavailableFields', 'sourceVersion', 'contentHash', 'resultRevision', 'judgment', 'evidence', 'scope'], contentSha256, auditId, resultRevision: result.resultRevision }
    await this.#audit.append({ ...receipt, resultRevision: result.resultRevision, tenantId: principal.tenantId, subjectId: principal.subjectId,
      entitlementVersion: principal.entitlementVersion, candidateRefs: candidates.map(c => c.ref), fields: receipt.fields })
    await this.#assertCurrentResult()
    return { fileName: `retrieval-${state.retrievalId}-${generatedAt.slice(0, 10)}.${options.format}`,
      mediaType: options.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8', receipt }
  }
}
