import type {
  CandidateDetailReadReceipt,
  CandidateExportReceipt,
  RetrievalId,
  TicketCandidateNode,
  TicketCandidateRef,
  TicketDetail,
  TicketEvidenceField,
} from '@retrieval-agent/contracts'

export const EXPORT_CANDIDATES_ENDPOINT = '/api/retrieval-agent/export' as const
export const READ_TICKET_DETAIL_ENDPOINT = '/api/retrieval-agent/detail' as const
export const CONTINUE_RETRIEVAL_ENDPOINT = '/api/retrieval-agent/continue' as const
export const READ_RETRIEVAL_ENDPOINT = '/api/retrieval-agent/presentation' as const

/** JSON payloads exposed by the trusted Product BFF. */
export interface ReadRetrievalParams {
  readonly sessionId: string
  readonly retrievalId: RetrievalId
}

export interface ReadRetrievalResponse {
  readonly node: TicketCandidateNode
}

export interface ReadRetrievalErrorResponse {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface ContinueRetrievalParams {
  /** Untrusted routing identity; the Host resolves the live Agent and trusted Principal. */
  readonly sessionId: string
  readonly retrievalId: RetrievalId
}

export interface ContinueRetrievalResponse {
  readonly retrievalId: RetrievalId
  readonly candidateCount: number
  readonly nextPageAvailable: boolean
}

export interface ContinueRetrievalErrorResponse {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
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
