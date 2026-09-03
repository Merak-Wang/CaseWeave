import type { TicketCandidateRef, TicketSnapshotId } from './brand.js'
import type { TicketSearchStage } from './ranking.js'
import type {
  TicketDetailResult,
  TicketEvidenceField,
  TicketEvidenceResult,
  TicketL3DetailsResult,
  TicketProviderStatus,
  TicketRetrievalRequest,
  TicketRetrievalSpec,
  TicketSearchPage,
  TicketSnapshot,
  TrustedPrincipalContext,
} from './types.js'

export interface ProviderCallOptions {
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
  readonly traceId?: string
}

export interface PrincipalResolutionRequest {
  readonly sessionId: string
  readonly operation: 'snapshot_open' | 'search' | 'evidence_read' | 'detail_read' | 'l3_details_read' | 'export'
}

/** Host-owned identity seam. Implementations must ignore model/browser identity fields. */
export interface TrustedPrincipalProvider {
  resolve(request: PrincipalResolutionRequest, options?: ProviderCallOptions): Promise<TrustedPrincipalContext>
}

export interface TicketSearchOptions extends ProviderCallOptions {
  readonly topK: number
  readonly maxScan: number
  readonly cursor?: string
  readonly stage: TicketSearchStage
}

export interface EvidenceReadRequest {
  readonly snapshotId: TicketSnapshotId
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly fields: readonly TicketEvidenceField[]
  readonly tokenBudget: number
}

export interface DetailReadRequest {
  readonly snapshotId: TicketSnapshotId
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly fields: readonly TicketEvidenceField[]
  readonly purpose: 'inline_detail' | 'candidate_export'
}

export const MAX_L3_DETAILS_PER_READ = 20 as const

/** Dedicated atomic L3 batch read; callers cannot choose arbitrary raw fields. */
export interface L3DetailsReadRequest {
  readonly snapshotId: TicketSnapshotId
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly purpose: 'model_ticket_load'
}

/** Every data-bearing method receives the trusted principal again. */
export interface TicketRetrievalProvider {
  readonly providerId: string
  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec
  openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot>
  search(
    principal: TrustedPrincipalContext,
    snapshotId: TicketSnapshotId,
    query: TicketRetrievalSpec,
    options: TicketSearchOptions,
  ): Promise<TicketSearchPage>
  readEvidence(
    principal: TrustedPrincipalContext,
    request: EvidenceReadRequest,
    options?: ProviderCallOptions,
  ): Promise<TicketEvidenceResult>
  readDetails(
    principal: TrustedPrincipalContext,
    request: DetailReadRequest,
    options?: ProviderCallOptions,
  ): Promise<TicketDetailResult>
  readL3Details(
    principal: TrustedPrincipalContext,
    request: L3DetailsReadRequest,
    options?: ProviderCallOptions,
  ): Promise<TicketL3DetailsResult>
  status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshotId): Promise<TicketProviderStatus>
}
