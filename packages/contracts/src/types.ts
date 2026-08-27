import type {
  RetrievalId,
  RetrievalStateId,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketId,
  TicketSnapshotId,
} from './brand.js'

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

/** Allowlisted query fields. */
export type TicketFilter =
  | { readonly field: 'type' | 'category' | 'priority' | 'status' | 'language' | 'region' | 'product' | 'component'; readonly op: 'eq' | 'neq'; readonly value: string }
  | { readonly field: 'createdAt' | 'updatedAt' | 'resolvedAt'; readonly op: 'gte' | 'lte'; readonly value: string }
  | { readonly field: 'errorCodes'; readonly op: 'contains'; readonly value: string }

/** A controller-admitted modification to an existing query. */
export type TicketQueryDelta =
  | { readonly kind: 'add_terms'; readonly terms: readonly string[] }
  | { readonly kind: 'exclude_terms'; readonly terms: readonly string[] }
  | { readonly kind: 'add_filter'; readonly filter: TicketFilter }
  | { readonly kind: 'remove_filter'; readonly field: TicketFilter['field'] }
  | { readonly kind: 'semantic_hint'; readonly text: string }

/** Initial consumer request before provider defaults are applied. */
export interface TicketRetrievalRequest {
  readonly target: TicketTaskTarget
  readonly query: string
  readonly retrievalIntent?: TicketRetrievalIntent
  readonly requestedCount?: number
  readonly mode?: 'keyword' | 'hybrid'
  readonly filters?: readonly TicketFilter[]
}

/** Fully validated query specification. */
export interface TicketRetrievalSpec {
  readonly target: TicketTaskTarget
  readonly originalQuery: string
  readonly normalizedQuery: string
  readonly retrievalIntent?: TicketRetrievalIntent
  readonly requestedCount: number
  readonly mode: 'keyword' | 'hybrid'
  readonly filters: readonly TicketFilter[]
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
  readonly authorizationVersion: string
  readonly principalBindingHash: string
  readonly queryPolicyVersion: string
  readonly capabilities: {
    readonly exhaustive: boolean
    readonly pagination: boolean
    readonly evidencePromotion: boolean
    readonly detailRead: boolean
    readonly exportRead: boolean
  }
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
}

export type TicketEvidenceField = 'problemDescription' | 'conversationOrUpdates' | 'resolutionSteps' | 'rootCause' | 'answer'

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

export interface RetrievalTaskContract {
  readonly target: TicketTaskTarget
  readonly requestedCount: number
  readonly answerabilityPolicy: 'current_snapshot_evidence_only'
  readonly completenessRequirement: 'top_k' | 'exhaustive'
}

export type RetrievalPhase = 'created' | 'snapshot_opened' | 'assessed' | 'awaiting_clarification' | 'frozen' | 'stopped'

export type RetrievalGapKind = 'coverage' | 'constraint' | 'depth' | 'boundary' | 'ambiguity' | 'conflict' | 'version_or_prior'

export interface RetrievalGap {
  readonly kind: RetrievalGapKind
  readonly status: 'open' | 'resolved' | 'not_applicable' | 'unknown'
  readonly evidenceRefs: readonly string[]
  readonly evaluator: 'system' | 'model'
}

export type RetrievalActionKind =
  | 'search'
  | 'search_next'
  | 'repair_search'
  | 'assess'
  | 'promote'
  | 'request_clarification'
  | 'answer_clarification'
  | 'freeze'
  | 'stop'
  | 'read_state'

export interface RetrievalAllowedAction {
  readonly kind: RetrievalActionKind
  readonly candidateAllowlist: readonly TicketCandidateRef[]
  readonly fieldAllowlist: readonly TicketEvidenceField[]
  readonly maxTokens: number
}

export interface RetrievalBudgetState {
  readonly maxRounds: number
  readonly maxSearches: number
  readonly maxPromotions: number
  readonly maxEvidenceTokens: number
  readonly maxLatencyMs: number
  readonly roundsUsed: number
  readonly searchesUsed: number
  readonly promotionsUsed: number
  readonly evidenceTokensUsed: number
  readonly latencyMs: number
}

export interface RetrievalProgressState {
  readonly newCandidateRefs: readonly TicketCandidateRef[]
  readonly rankOverlap: number
  readonly newDecisiveEvidence: boolean
  readonly resolvedGaps: readonly RetrievalGapKind[]
  readonly noProgressStreak: number
}

export type RetrievalTermination =
  | 'active'
  | 'sufficient'
  | 'no_result'
  | 'needs_clarification'
  | 'partial'
  | 'budget_exhausted'
  | 'permission_blocked'
  | 'backend_error'
  | 'snapshot_invalid'
  | 'cancelled'

export interface RetrievalStateProvenance {
  readonly rulesVersion: string
  readonly promptVersion: string
  readonly contextPolicyVersion: string
  readonly model?: string
  readonly sourceEventIds: readonly string[]
}

export interface FrozenEvidencePack {
  readonly packId: string
  readonly retrievalId: RetrievalId
  readonly query: { readonly original: string; readonly normalized: string }
  readonly target: TicketTaskTarget
  readonly confirmedConstraints: readonly TicketFilter[]
  readonly snapshot: TicketSnapshot
  readonly candidates: readonly {
    readonly ref: TicketCandidateRef
    readonly displayId: string
    readonly sourceVersion: string
    readonly contentHash: string
    readonly evidenceLevel: 'L1' | 'L2'
    readonly evidenceIds: readonly TicketEvidenceId[]
  }[]
  readonly stoppingReason: Exclude<RetrievalTermination, 'active' | 'needs_clarification'>
  readonly remainingGaps: readonly RetrievalGap[]
  readonly budget: RetrievalBudgetState
  readonly complete: boolean
  readonly providerId: string
  readonly promptVersion: string
}

/** Complete domain state, reconstructable from versioned events. */
export interface RetrievalState {
  readonly retrievalId: RetrievalId
  readonly stateId: RetrievalStateId
  readonly previousStateId?: RetrievalStateId
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly phase: RetrievalPhase
  readonly task: RetrievalTaskContract
  readonly principalBindingHash: string
  readonly snapshot?: TicketSnapshot
  readonly query: {
    readonly original: string
    readonly spec: TicketRetrievalSpec
    readonly confirmedConstraints: readonly TicketFilter[]
    readonly unresolvedConstraints: readonly string[]
  }
  readonly candidates: readonly TicketCandidate[]
  readonly lastPage?: TicketSearchPage
  readonly promotedEvidence: readonly TicketEvidenceSegment[]
  readonly gaps: readonly RetrievalGap[]
  readonly allowedActions: readonly RetrievalAllowedAction[]
  readonly budget: RetrievalBudgetState
  readonly progress: RetrievalProgressState
  readonly termination: RetrievalTermination
  readonly clarification?: {
    readonly facet: string
    readonly question: string
    readonly candidateRefs: readonly TicketCandidateRef[]
    readonly answer?: string
  }
  readonly frozenEvidence?: FrozenEvidencePack
  readonly provenance: RetrievalStateProvenance
}

export interface EvidenceContextSelection {
  readonly retrievalId: RetrievalId
  readonly stateId: RetrievalStateId
  readonly policyVersion: string
  readonly includedCandidateRefs: readonly TicketCandidateRef[]
  readonly includedEvidenceIds: readonly TicketEvidenceId[]
  readonly excluded: readonly { readonly ref: string; readonly reason: 'unauthorized' | 'not_selected' | 'superseded' | 'token_budget' | 'unread' }[]
  readonly tokenBudget: number
  readonly estimatedTokens: number
  readonly rendered: string
}

/** Public export metadata. CSV bytes remain a Host response, not a Session fact. */
export interface CandidateExportReceipt {
  readonly exportId: string
  readonly retrievalId: RetrievalId
  readonly snapshotShortId: string
  readonly generatedAt: string
  readonly rowCount: number
  readonly fields: readonly string[]
  readonly contentSha256: string
  readonly auditId: string
}

/** Candidate node is a deterministic UI projection, never model-authored Markdown. */
export interface TicketCandidateNode {
  readonly retrievalId: RetrievalId
  readonly version: number
  readonly querySummary: string
  readonly snapshotShortId?: string
  readonly completeness: 'pending' | TicketSearchPage['completeness']
  readonly status: 'searching' | 'results' | 'empty' | 'partial' | 'snapshot_invalid' | 'permission_blocked' | 'error' | 'stopped'
  readonly candidates: readonly TicketCandidate[]
  readonly alreadyReadEvidence: readonly TicketEvidenceSegment[]
  readonly message?: string
  readonly exportEnabled: boolean
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
}
