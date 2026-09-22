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
  /** Local in-memory scan capacity; database providers bound each materialized ID batch by this value.
   * It is never a total match limit or a substitute for SQL predicate execution. */
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
  /** 预处理数值列块；不携带正文或逐行向量 JSON。ids 属于不可变索引代次。 */
  featureBlock?(principal: TrustedPrincipalContext, request: {
    readonly snapshotId: TicketSnapshotId; readonly limit: number; readonly cursor?: string;
    readonly ids?: readonly number[]; readonly refs?: readonly import('./brand.js').TicketCandidateRef[];
    readonly filters?: readonly import('./types.js').TicketFilter[];
    /** 原始业务查询；仅用于安排标注顺序，不产生相关性结论。 */
    readonly rankingQuery?: string;
  }, options?: ProviderCallOptions): Promise<NumericFeatureBlock>
  resolveFeatureIds?(principal: TrustedPrincipalContext, request: { readonly snapshotId: TicketSnapshotId;
    readonly ids: readonly number[] }, options?: ProviderCallOptions): Promise<readonly import('./types.js').TicketCandidate[]>
  readonly providerId: string
  /** 授权全库按块读取既有特征；不受搜索候选窗口限制，不生成新向量。 */
  scanFeatures?(principal: TrustedPrincipalContext,
    request: { readonly snapshotId: TicketSnapshotId; readonly cursor?: string; readonly limit: number },
    options?: ProviderCallOptions): Promise<{ readonly rows: readonly { readonly ref: string; readonly version: string;
      readonly content_hash: string; readonly embedding_id: string; readonly vectors: readonly (readonly number[])[] }[];
      readonly nextCursor?: string; readonly total?: number }>
  readCandidates?(principal: TrustedPrincipalContext,
    request: { readonly snapshotId: TicketSnapshotId; readonly candidateRefs: readonly TicketCandidateRef[] },
    options?: ProviderCallOptions): Promise<readonly import('./types.js').TicketCandidate[]>
  /** Read existing index features only. Missing vectors never trigger re-embedding. */
  readFeatures?(principal: TrustedPrincipalContext,
    request: { readonly snapshotId: TicketSnapshotId; readonly candidateRefs: readonly TicketCandidateRef[] },
    options?: ProviderCallOptions): Promise<readonly { readonly ref: string; readonly version: string; readonly content_hash: string;
      readonly embedding_id: string; readonly vectors: readonly (readonly number[])[] }[]>
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

export interface NumericFeatureBlock {
  readonly ids: readonly number[]; readonly dense: string; readonly dimensions: number;
  readonly available: string; readonly feature_id: string; readonly next_cursor?: string | null;
  /** 与 ids 对齐的 query n-gram / cosine 融合分数，独立于分页和块宽。 */
  readonly scores?: readonly number[];
  readonly sparse?: { readonly data: string; readonly indices: string; readonly indptr: string; readonly columns: number }
}
