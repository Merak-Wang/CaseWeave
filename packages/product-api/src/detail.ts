import { randomUUID } from 'node:crypto'
import {
  RetrievalError,
  isReadableTicketField,
  type CandidateDetailReadReceipt,
  type RetrievalState,
  type TicketCandidateRef,
  type TicketDetailResult,
  type TicketEvidenceField,
  type TicketRetrievalProvider,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { hostAuthorizedCandidates } from './candidate-selection.js'

export interface DetailReadAuditRecord {
  readonly auditId: string
  readonly readId: string
  readonly retrievalId: string
  readonly tenantId: string
  readonly subjectId: string
  readonly entitlementVersion: string
  readonly snapshotShortId: string
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly fields: readonly TicketEvidenceField[]
  readonly readAt: string
}

export interface DetailReadAuditSink {
  append(record: DetailReadAuditRecord): Promise<void> | void
}

export class InMemoryDetailReadAuditSink implements DetailReadAuditSink {
  readonly records: DetailReadAuditRecord[] = []
  append(record: DetailReadAuditRecord): void { this.records.push(record) }
}

export interface CandidateDetailRead {
  readonly result: TicketDetailResult
  readonly receipt: CandidateDetailReadReceipt
}

export interface CandidateDetailServiceConfig {
  readonly maxCandidates?: number
  readonly maxFields?: number
  readonly now?: () => Date
  readonly id?: () => string
}

/** Trusted-host detail service; every click re-enters the active Provider with a fresh Principal. */
export class CandidateDetailService {
  readonly #provider: TicketRetrievalProvider
  readonly #audit: DetailReadAuditSink
  readonly #maxCandidates: number
  readonly #maxFields: number
  readonly #now: () => Date
  readonly #id: () => string

  constructor(provider: TicketRetrievalProvider, audit: DetailReadAuditSink, config: CandidateDetailServiceConfig = {}) {
    this.#provider = provider
    this.#audit = audit
    this.#maxCandidates = config.maxCandidates ?? 1
    this.#maxFields = config.maxFields ?? 16
    this.#now = config.now ?? (() => new Date())
    this.#id = config.id ?? (() => randomUUID())
  }

  async readDetails(
    principal: TrustedPrincipalContext,
    state: RetrievalState,
    refs: readonly TicketCandidateRef[],
    fields: readonly TicketEvidenceField[],
    signal?: AbortSignal,
  ): Promise<CandidateDetailRead> {
    if (state.snapshot === undefined || state.snapshot.capabilities.detailRead !== true) {
      throw new RetrievalError('SNAPSHOT_INVALID', '当前检索快照不支持工单详情读取。')
    }
    const candidates = hostAuthorizedCandidates(state, refs)
    const selectedFields = [...new Set(fields)]
    if (candidates.length > this.#maxCandidates || selectedFields.length > this.#maxFields) {
      throw new RetrievalError('INVALID_REQUEST', '单次详情读取超过限制。')
    }
    const allowedFields = new Set(state.snapshot.fieldCatalog
      .filter(isReadableTicketField)
      .map(field => field.key))
    if (selectedFields.some(field => !allowedFields.has(field))) {
      throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了当前快照不允许展示的详情字段。')
    }
    const result = await this.#provider.readDetails(principal, {
      snapshotId: state.snapshot.snapshotId,
      candidateRefs: candidates.map(candidate => candidate.ref),
      fields: selectedFields,
      purpose: 'inline_detail',
    }, signal === undefined ? undefined : { signal })
    if (result.rejectedCandidateRefs.length > 0 || result.details.length !== candidates.length) {
      throw new RetrievalError('UNAUTHORIZED', '工单详情重新授权失败，请重新检索。')
    }
    const returnedRefs = new Set(result.details.map(detail => detail.candidateRef))
    if (result.snapshotId !== state.snapshot.snapshotId || returnedRefs.size !== candidates.length
      || candidates.some(candidate => !returnedRefs.has(candidate.ref))) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回了不同快照或候选的详情。')
    }
    for (const detail of result.details) {
      const candidate = candidates.find(item => item.ref === detail.candidateRef)!
      if (detail.displayId !== candidate.displayId || detail.sourceVersion !== candidate.sourceVersion
        || Object.keys(detail.fields).some(field => !selectedFields.includes(field))
        || detail.unavailableFields.some(field => !selectedFields.includes(field))) {
        throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回的工单身份、来源版本或详情字段超出本次授权请求。')
      }
    }
    const readAt = this.#now().toISOString()
    const readId = this.#id()
    const auditId = this.#id()
    const receipt: CandidateDetailReadReceipt = {
      readId,
      retrievalId: state.retrievalId,
      snapshotShortId: state.snapshot.shortId,
      candidateRefs: candidates.map(candidate => candidate.ref),
      fields: selectedFields,
      readAt,
      auditId,
    }
    await this.#audit.append({
      auditId,
      readId,
      retrievalId: state.retrievalId,
      tenantId: principal.tenantId,
      subjectId: principal.subjectId,
      entitlementVersion: principal.entitlementVersion,
      snapshotShortId: state.snapshot.shortId,
      candidateRefs: receipt.candidateRefs,
      fields: selectedFields,
      readAt,
    })
    return { result, receipt }
  }
}
