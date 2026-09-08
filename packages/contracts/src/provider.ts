import type { TicketCandidateRef, TicketSnapshotId } from './brand.js'
import type { TicketSearchStage } from './ranking.js'
import type {
  TicketDetailResult,
  TicketEvidenceField,
  TicketEvidenceResult,
  TicketFieldDescriptor,
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
  readonly operation: 'snapshot_open' | 'search' | 'evidence_read' | 'detail_read' | 'export'
}

/** Host-owned identity seam. Implementations must ignore model/browser identity fields. */
export interface TrustedPrincipalProvider {
  resolve(request: PrincipalResolutionRequest, options?: ProviderCallOptions): Promise<TrustedPrincipalContext>
}

export interface TicketSearchOptions extends ProviderCallOptions {
  /** Persisted progress is bounded to a display window; channel enumeration lives in the Provider store. */
  readonly onProgress?: (progress: TicketSearchProgress) => Promise<void>
  readonly topK: number
  readonly maxScan: number
  readonly cursor?: string
  readonly stage: TicketSearchStage
}

export interface TicketSearchProgress {
  readonly page: TicketSearchPage
  readonly channels: readonly { readonly channel: 'keyword' | 'vector'; readonly status: 'running' | 'completed' | 'failed' | 'skipped'; readonly count: number; readonly error?: string; readonly cursor?: string }[]
  readonly timings: Readonly<Record<string, number>>
}

export interface EvidenceReadRequest {
  readonly position?: import('./agent-context.js').EvidencePosition
  readonly level?: 'L2' | 'L3'
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

export const MAX_EVIDENCE_CANDIDATES_PER_READ = 20 as const

/** Shared admission for advertised, user-read and model-read textual evidence. */
export function isReadableTicketField(field: Pick<TicketFieldDescriptor, 'accessLevel' | 'valueKind'>): boolean {
  return ['L1', 'L2', 'L3'].includes(field.accessLevel) && field.valueKind !== 'raw_json'
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
  status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshotId): Promise<TicketProviderStatus>
}
