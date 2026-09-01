import type {
  CandidateDetailReadReceipt,
  CandidateExportReceipt,
  RetrievalId,
  TicketCandidateNode,
  TicketCandidateRef,
  TicketDetail,
  TicketEvidenceField,
  TicketRetrievalRequest,
} from '@retrieval-agent/contracts'

export const EXPORT_CANDIDATES_ENDPOINT = '/api/retrieval-agent/export' as const
export const READ_TICKET_DETAIL_ENDPOINT = '/api/retrieval-agent/detail' as const

/** JSON payloads exposed by the trusted Product BFF. */
export interface StartRetrievalParams {
  readonly request: TicketRetrievalRequest
}

export interface StartRetrievalResponse {
  readonly retrievalId: RetrievalId
  readonly node: TicketCandidateNode
}

export interface ReadRetrievalParams {
  readonly retrievalId: RetrievalId
}

export interface ReadRetrievalResponse {
  readonly node: TicketCandidateNode
}

export interface ReadTicketDetailParams {
  /** Untrusted routing identity; the Host resolves the live Agent and trusted Principal. */
  readonly sessionId: string
  readonly retrievalId: RetrievalId
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly fields: readonly TicketEvidenceField[]
}

export interface ReadTicketDetailResponse {
  readonly details: readonly TicketDetail[]
  readonly rejectedCandidateRefs: readonly TicketCandidateRef[]
  readonly warnings: readonly string[]
  readonly receipt: CandidateDetailReadReceipt
}

export interface ReadTicketDetailErrorResponse {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface ExportCandidatesParams {
  /** Untrusted routing identity; the Host resolves the live Agent and its trusted Principal. */
  readonly sessionId: string
  readonly retrievalId: RetrievalId
  readonly candidateRefs: readonly TicketCandidateRef[]
}

export interface ExportCandidatesResponse {
  readonly fileName: string
  readonly mediaType: 'text/csv; charset=utf-8'
  readonly contentUtf8: string
  readonly receipt: CandidateExportReceipt
}

export interface ExportCandidatesErrorResponse {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface CandidateNodeNotification {
  readonly retrievalId: RetrievalId
  readonly node: TicketCandidateNode
}

export interface RetrievalStoppedNotification {
  readonly retrievalId: RetrievalId
  readonly node: TicketCandidateNode
}
