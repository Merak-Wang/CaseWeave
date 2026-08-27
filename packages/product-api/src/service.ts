import { createHash, randomUUID } from 'node:crypto'
import {
  RetrievalError,
  type CandidateExportReceipt,
  type RetrievalState,
  type TicketCandidate,
  type TicketCandidateRef,
  type TicketDetailResult,
  type TicketEvidenceField,
  type TicketRetrievalProvider,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { encodeCsv } from './csv.js'

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
}

const HEADERS = [
  'query', 'exported_at', 'snapshot', 'completeness', 'rank', 'ticket', 'title', 'summary',
  'type', 'category', 'product', 'component', 'region', 'status', 'priority', 'created_at',
  'source_version', 'evidence_level',
] as const

function byRef(state: RetrievalState, refs: readonly TicketCandidateRef[]): TicketCandidate[] {
  const allowed = new Map(state.candidates.map(candidate => [candidate.ref, candidate]))
  const unique = [...new Set(refs)]
  if (unique.some(ref => !allowed.has(ref))) throw new RetrievalError('CANDIDATE_NOT_FOUND', '导出引用不属于当前候选。')
  return unique.map(ref => allowed.get(ref)!)
}

function readEvidenceLevel(state: RetrievalState, ref: TicketCandidateRef): 'L1' | 'L2' {
  return state.promotedEvidence.some(evidence => evidence.candidateRef === ref) ? 'L2' : 'L1'
}

/** Trusted-host application service; every detail/export operation re-enters the Provider. */
export class CandidateExportService {
  readonly #provider: TicketRetrievalProvider
  readonly #audit: ExportAuditSink
  readonly #maxRows: number
  readonly #maxBytes: number
  readonly #now: () => Date
  readonly #id: () => string

  constructor(provider: TicketRetrievalProvider, audit: ExportAuditSink, config: CandidateExportServiceConfig = {}) {
    this.#provider = provider
    this.#audit = audit
    this.#maxRows = config.maxRows ?? 200
    this.#maxBytes = config.maxBytes ?? 2_000_000
    this.#now = config.now ?? (() => new Date())
    this.#id = config.id ?? (() => randomUUID())
  }

  async readDetails(
    principal: TrustedPrincipalContext,
    state: RetrievalState,
    refs: readonly TicketCandidateRef[],
    fields: readonly TicketEvidenceField[],
    signal?: AbortSignal,
  ): Promise<TicketDetailResult> {
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '检索快照不存在。')
    byRef(state, refs)
    return await this.#provider.readDetails(principal, {
      snapshotId: state.snapshot.snapshotId,
      candidateRefs: refs,
      fields,
      purpose: 'inline_detail',
    }, signal === undefined ? undefined : { signal })
  }

  async exportCsv(
    principal: TrustedPrincipalContext,
    state: RetrievalState,
    refs: readonly TicketCandidateRef[] = state.candidates.map(candidate => candidate.ref),
    signal?: AbortSignal,
  ): Promise<CandidateExport> {
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '检索快照不存在。')
    const candidates = byRef(state, refs)
    if (candidates.length > this.#maxRows) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '候选数量超过单次导出限制。')
    const status = await this.#provider.status(principal, state.snapshot.snapshotId)
    if (status.snapshotValid !== true) throw new RetrievalError('SNAPSHOT_INVALID', '检索快照已失效，请重新检索后导出。')
    const details = await this.#provider.readDetails(principal, {
      snapshotId: state.snapshot.snapshotId,
      candidateRefs: candidates.map(candidate => candidate.ref),
      fields: [],
      purpose: 'candidate_export',
    }, signal === undefined ? undefined : { signal })
    if (details.rejectedCandidateRefs.length > 0 || details.details.length !== candidates.length) {
      throw new RetrievalError('UNAUTHORIZED', '部分候选已不可导出，请重新检索。')
    }
    const detailByRef = new Map(details.details.map(detail => [detail.candidateRef, detail]))
    const generatedAt = this.#now().toISOString()
    const rows = candidates.map(candidate => {
      const detail = detailByRef.get(candidate.ref)
      if (detail === undefined) throw new RetrievalError('UNAUTHORIZED', '候选在导出重新授权时不可用。')
      return [
        state.query.original,
        generatedAt,
        state.snapshot!.shortId,
        state.lastPage?.completeness ?? 'unknown',
        String(candidate.rank),
        detail.displayId,
        detail.title,
        detail.summary,
        detail.l0.type ?? '',
        detail.l0.category ?? '',
        detail.l0.product ?? '',
        detail.l0.component ?? '',
        detail.l0.region ?? '',
        detail.l0.status ?? '',
        detail.l0.priority ?? '',
        detail.l0.createdAt ?? '',
        detail.sourceVersion,
        readEvidenceLevel(state, candidate.ref),
      ]
    })
    const content = encodeCsv(HEADERS, rows)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.#maxBytes) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '导出文件超过大小限制。')
    const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    const exportId = this.#id()
    const auditId = this.#id()
    const receipt: CandidateExportReceipt = {
      exportId,
      retrievalId: state.retrievalId,
      snapshotShortId: state.snapshot.shortId,
      generatedAt,
      rowCount: rows.length,
      fields: HEADERS,
      contentSha256,
      auditId,
    }
    await this.#audit.append({
      auditId,
      exportId,
      retrievalId: state.retrievalId,
      tenantId: principal.tenantId,
      subjectId: principal.subjectId,
      entitlementVersion: principal.entitlementVersion,
      snapshotShortId: state.snapshot.shortId,
      candidateRefs: candidates.map(candidate => candidate.ref),
      fields: HEADERS,
      rowCount: rows.length,
      contentSha256,
      generatedAt,
    })
    return {
      fileName: `retrieval-${state.retrievalId}-${generatedAt.slice(0, 10)}.csv`,
      mediaType: 'text/csv; charset=utf-8',
      content,
      receipt,
    }
  }
}

/** Build detail rows only from evidence already present in state; performs no Provider call. */
export function alreadyReadEvidence(state: RetrievalState, ref: TicketCandidateRef): Readonly<Partial<Record<TicketEvidenceField, readonly string[]>>> {
  const result: Partial<Record<TicketEvidenceField, string[]>> = {}
  for (const evidence of state.promotedEvidence) {
    if (evidence.candidateRef !== ref) continue
    const values = result[evidence.field] ?? []
    values.push(evidence.text)
    result[evidence.field] = values
  }
  return result
}
