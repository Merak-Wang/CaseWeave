import type {
  DetailReadRequest,
  EvidenceReadRequest,
  L3DetailsReadRequest,
  RetrievalErrorCode,
  TicketDetailResult,
  TicketEvidenceResult,
  TicketL3DetailsResult,
  TicketProviderStatus,
  TicketRetrievalSpec,
  TicketSearchOptions,
  TicketSearchPage,
  TicketSnapshot,
  TicketSnapshotId,
  TrustedPrincipalContext,
} from '@retrieval-agent/contracts'

export const STREAMCLUSTER_PROTOCOL_VERSION = 'retrieval-agent.streamcluster.v5' as const

export interface StreamClusterCapabilitiesResponse {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly providerId: string
  readonly readOnly: true
  readonly capabilities: {
    readonly snapshot: true
    readonly search: true
    readonly evidenceRead: true
    readonly detailRead: true
    readonly l3DetailsRead: true
    readonly status: true
    readonly keywordSearch: true
    readonly denseSearch: boolean
    readonly hybridFusion: boolean
    readonly reranking: boolean
    readonly rankingTrace: true
  }
}

export interface OpenSnapshotParams {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly principal: TrustedPrincipalContext
  readonly traceId?: string
}
export interface OpenSnapshotResponse {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly snapshot: TicketSnapshot
}

export interface SearchTicketsParams {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly principal: TrustedPrincipalContext
  readonly snapshotId: TicketSnapshotId
  readonly query: TicketRetrievalSpec
  readonly options: Pick<TicketSearchOptions, 'topK' | 'maxScan' | 'cursor' | 'stage'>
  readonly traceId?: string
}
export interface SearchTicketsResponse {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly page: TicketSearchPage
}

export interface ReadEvidenceParams {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly principal: TrustedPrincipalContext
  readonly request: EvidenceReadRequest
  readonly traceId?: string
}
export interface ReadEvidenceResponse {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly result: TicketEvidenceResult
}

export interface ReadTicketDetailsParams {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly principal: TrustedPrincipalContext
  readonly request: DetailReadRequest
  readonly traceId?: string
}
export interface ReadTicketDetailsResponse {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly result: TicketDetailResult
}

export interface ReadTicketL3DetailsParams {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly principal: TrustedPrincipalContext
  readonly request: L3DetailsReadRequest
  readonly traceId?: string
}
export interface ReadTicketL3DetailsResponse {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly result: TicketL3DetailsResult
}

export interface ReadProviderStatusParams {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly principal: TrustedPrincipalContext
  readonly snapshotId?: TicketSnapshotId
}
export interface ReadProviderStatusResponse {
  readonly protocolVersion: typeof STREAMCLUSTER_PROTOCOL_VERSION
  readonly status: TicketProviderStatus
}

export interface StreamClusterErrorResponse {
  readonly protocolVersion?: string
  readonly error: {
    readonly code: RetrievalErrorCode
    readonly message: string
    readonly retryable: boolean
  }
}
