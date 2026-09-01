import type {
  RetrievalId,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketId,
  TicketSnapshotId,
} from './brand.js'
import type { TicketRetrievalMode, TicketSearchTrace } from './ranking.js'
/** Trusted identity established by the product host, never by a model or browser field. */
export interface TrustedPrincipalContext {
  readonly tenantId: string
  readonly subjectId: string
  readonly entitlementVersion: string
  readonly purpose: 'ticket_retrieval'
  readonly attributes: Readonly<Record<string, readonly string[]>>
  readonly issuedAt: string
  readonly expiresAt?: string
}
/** User-level retrieval target. */
export type TicketTaskTarget = 'ranked_cases' | 'constrained_list' | 'cohort_collection' | 'resolution_path'
/** Ranked retrieval intent, independent from the target set semantics. */
export type TicketRetrievalIntent = 'known_item' | 'analogous_case'
export type TicketCountPolicy = 'explicit' | 'adaptive' | 'provider_default'
export interface TicketQueryAmbiguity {
  readonly kind: 'reference' | 'quantity' | 'boundary' | 'constraint'
  readonly text: string
}
export interface TicketQueryEntity {
  readonly type: 'business_object' | 'ticket_id'
  readonly surface: string
  readonly canonical: string
}

/** One semantic concept that must be present when a user explicitly joins clauses with AND. */
export interface TicketQueryConcept {
  readonly surface: string
  readonly canonical: string
  /** Provider-executable lexical variants for this concept; one variant is sufficient. */
  readonly alternatives: readonly string[]
}

/** Explicit Boolean meaning extracted from the direct-user query. */
export interface TicketQueryLogic {
  readonly operator: 'and'
  /** Every concept group is required; alternatives inside one group are OR-equivalent. */
  readonly requiredConcepts: readonly TicketQueryConcept[]
}
/**
 * Harness-owned interpretation of one direct-user query. This is persisted
 * before Provider access so a retrieval can explain exactly which task,
 * language, domain, entities, constraints, and result-set policy it used.
 */
export interface TicketQueryContract {
  /** Version 1 remains readable for persisted sessions; new compiler output uses version 2. */
  readonly schemaVersion: 1 | 2
  readonly original: string
  readonly normalized: string
  readonly task: TicketTaskTarget
  readonly resultPolicy: 'explicit_top_k' | 'adaptive_top_k' | 'exhaustive_current_snapshot'
  readonly maxResults: number
  readonly domain: 'telecom_ticket' | 'general_ticket'
  readonly language: 'zh' | 'en' | 'und'
  readonly entities: readonly TicketQueryEntity[]
  readonly constraints: readonly TicketFilter[]
  readonly logic?: TicketQueryLogic
  readonly ambiguities: readonly TicketQueryAmbiguity[]
  readonly confidence: number
  readonly compilerVersion: string
}
export type TicketFilterOperator = 'eq' | 'neq' | 'gte' | 'lte' | 'contains'

/** Provider-declared query field. Syntax is validated centrally; support is enforced by the Provider. */
export interface TicketFilter {
  readonly field: string
  readonly op: TicketFilterOperator
  readonly value: string
}

/** A controller-admitted modification to an existing query. */
export type TicketQueryDelta =
  | { readonly kind: 'add_terms'; readonly terms: readonly string[] }
  | { readonly kind: 'exclude_terms'; readonly terms: readonly string[] }
  | { readonly kind: 'add_filter'; readonly filter: TicketFilter }
  | { readonly kind: 'remove_filter'; readonly field: string }
  | { readonly kind: 'semantic_hint'; readonly text: string }

/** Initial consumer request before provider defaults are applied. */
export interface TicketRetrievalRequest {
  readonly target: TicketTaskTarget
  /** Exact direct-user text retained for provenance. */
  readonly query: string
  /** Retrieval-only text after deterministic directive/constraint extraction. */
  readonly retrievalQuery?: string
  readonly retrievalIntent?: TicketRetrievalIntent
  readonly requestedCount?: number
  readonly countPolicy?: Extract<TicketCountPolicy, 'explicit' | 'adaptive'>
  readonly mode?: TicketRetrievalMode
  readonly filters?: readonly TicketFilter[]
  readonly ambiguities?: readonly TicketQueryAmbiguity[]
  /** Present on the public direct-user path; manual/provider callers may omit it. */
  readonly queryContract?: TicketQueryContract
}

/** Fully validated query specification. */
export interface TicketRetrievalSpec {
  readonly target: TicketTaskTarget
  readonly originalQuery: string
  readonly normalizedQuery: string
  readonly retrievalIntent?: TicketRetrievalIntent
  readonly requestedCount: number
  readonly countPolicy: TicketCountPolicy
  readonly mode: TicketRetrievalMode
  readonly filters: readonly TicketFilter[]
  /** Hard conjunction admitted by the query compiler; every concept group must match. */
  readonly requiredConcepts?: readonly TicketQueryConcept[]
  readonly ambiguities: readonly TicketQueryAmbiguity[]
  readonly excludedTerms: readonly string[]
  readonly semanticHints: readonly string[]
  readonly compilerVersion: string
}

/** Provider-issued authorization and data snapshot. */
export interface TicketSnapshot {
  readonly snapshotId: TicketSnapshotId
  readonly shortId: string
  readonly providerId: string
  readonly createdAt: string
  readonly expiresAt?: string
  readonly sourceVersion: string
  readonly indexVersion: string
  readonly retrievalProfileVersion: string
  readonly authorizationVersion: string
  readonly principalBindingHash: string
  readonly queryPolicyVersion: string
  /** Versioned data vocabulary exposed for this authorized snapshot. */
  readonly fieldCatalog: readonly TicketFieldDescriptor[]
  readonly capabilities: {
    readonly exhaustive: boolean
    readonly pagination: boolean
    readonly evidencePromotion: boolean
    readonly detailRead: boolean
    readonly exportRead: boolean
    readonly keywordSearch: true
    readonly denseSearch: boolean
    readonly hybridFusion: boolean
    readonly reranking: boolean
  }
}

export interface TicketFieldDescriptor {
  readonly key: string
  readonly label: string
  readonly valueKind: 'keyword' | 'datetime' | 'text' | 'string_list' | 'raw_json'
  readonly accessLevel: 'L0' | 'L2'
  readonly filterOperators: readonly TicketFilterOperator[]
  readonly sensitivity: 'non_sensitive' | 'source_controlled'
}

/** Already-authorized display value. `sourcePath` is provenance, not an access path. */
export interface TicketDisplayField {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly sourcePath: string
}

/** L0 fields approved for candidate-list display. */
export interface TicketL0 {
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly resolvedAt?: string
  readonly type?: string
  readonly category?: string
  readonly product?: string
  readonly component?: string
  readonly region?: string
  readonly status?: string
  readonly priority?: string
  readonly language?: string
  readonly additionalFields?: readonly TicketDisplayField[]
}

/** L1 result returned after authorization filtering. */
export interface TicketCandidate {
  readonly ref: TicketCandidateRef
  readonly displayId: string
  readonly sourceVersion: string
  readonly snapshotId: TicketSnapshotId
  readonly contentHash: string
  readonly evidenceLevel: 'L1'
  readonly rank: number
  readonly title: string
  readonly summary: string
  readonly l0: TicketL0
  readonly matchFragments: readonly { readonly field: 'title' | 'summary'; readonly text: string; readonly truncated: boolean }[]
}

/** Bounded, deterministic page of authorized candidates. */
export interface TicketSearchPage {
  readonly snapshotId: TicketSnapshotId
  readonly queryFingerprint: string
  readonly candidates: readonly TicketCandidate[]
  readonly completeness: 'exhaustive' | 'bounded' | 'unknown'
  readonly nextCursor?: string
  readonly scanned: number
  readonly returned: number
  readonly elapsedMs: number
  readonly appliedFilters: readonly TicketFilter[]
  readonly warnings: readonly string[]
  readonly trace: TicketSearchTrace
}

/** Provider-declared L2 key. The current snapshot field catalog is the runtime allowlist. */
export type TicketEvidenceField = string

/** L2 evidence is untrusted ticket content even after authorization. */
export interface TicketEvidenceSegment {
  readonly evidenceId: TicketEvidenceId
  readonly candidateRef: TicketCandidateRef
  readonly displayId: string
  readonly sourceVersion: string
  readonly contentHash: string
  readonly field: TicketEvidenceField
  readonly text: string
  readonly start: number
  readonly end: number
  readonly estimatedTokens: number
  readonly trust: 'untrusted_ticket_evidence'
  readonly truncated: boolean
}

export interface TicketEvidenceResult {
  readonly snapshotId: TicketSnapshotId
  readonly evidence: readonly TicketEvidenceSegment[]
  readonly requestedCandidateRefs: readonly TicketCandidateRef[]
  readonly rejectedCandidateRefs: readonly TicketCandidateRef[]
  readonly tokenBudget: number
  readonly tokensUsed: number
  readonly warnings: readonly string[]
}

/** Host-facing, reauthorized candidate detail. Internal authorization metadata is absent. */
export interface TicketDetail {
  readonly candidateRef: TicketCandidateRef
  readonly displayId: string
  readonly sourceVersion: string
  readonly title: string
  readonly summary: string
  readonly l0: TicketL0
  readonly fields: Partial<Record<TicketEvidenceField, readonly string[]>>
  readonly unavailableFields: readonly TicketEvidenceField[]
}

export interface TicketDetailResult {
  readonly snapshotId: TicketSnapshotId
  readonly details: readonly TicketDetail[]
  readonly rejectedCandidateRefs: readonly TicketCandidateRef[]
  readonly warnings: readonly string[]
}

export interface TicketProviderStatus {
  readonly providerId: string
  readonly ready: boolean
  readonly readOnly: true
  readonly sourceVersion?: string
  readonly indexVersion?: string
  readonly snapshotValid?: boolean
  readonly warnings: readonly string[]
}

/** Internal normalized source record used by providers; never returned wholesale. */
export interface NormalizedTicketRecord {
  readonly ticketId: TicketId
  readonly displayId: string
  readonly tenantId: string
  readonly allowedSubjectIds: readonly string[]
  readonly requiredAttributes: Readonly<Record<string, readonly string[]>>
  readonly sourceVersion: string
  readonly contentHash: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly resolvedAt?: string
  readonly title: string
  readonly summary: string
  readonly problemDescription?: string
  readonly conversationOrUpdates: readonly string[]
  readonly resolutionSteps: readonly string[]
  readonly rootCause?: string
  readonly answer?: string
  readonly product?: string
  readonly component?: string
  readonly category?: string
  readonly type?: string
  readonly priority?: string
  readonly status?: string
  readonly language?: string
  readonly region?: string
  readonly errorCodes: readonly string[]
  readonly piiRedactionStatus: 'not_applicable' | 'redacted' | 'unreviewed'
  /** Optional source-native document retained inside the Provider and never projected wholesale. */
  readonly rawSource?: {
    readonly datasetId: string
    readonly datasetVersion: string
    readonly schemaVersion: string
    readonly recordId: string
    readonly payload: Readonly<Record<string, unknown>>
  }
  /** Additional source text selected by its adapter for retrieval indexing. */
  readonly searchText?: readonly string[]
  /** Authorized, source-specific L0 values that do not require a shared schema change. */
  readonly additionalFields?: readonly TicketDisplayField[]
  /** Provider-side values for source-specific filters. */
  readonly filterValues?: Readonly<Record<string, string | readonly string[]>>
  /** Source-specific L2 values, including an explicitly requested raw view when policy allows it. */
  readonly additionalEvidence?: Readonly<Record<string, readonly string[]>>
  /** Descriptors contributed by the source adapter. */
  readonly fieldCatalog?: readonly TicketFieldDescriptor[]
}
