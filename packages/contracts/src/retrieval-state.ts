import type {
  RetrievalId,
  RetrievalStateId,
  TicketCandidateRef,
  TicketEvidenceId,
} from './brand.js'
import type { TicketSearchStage } from './ranking.js'
import type {
  TicketCandidate,
  TicketCountPolicy,
  TicketEvidenceField,
  TicketEvidenceSegment,
  TicketFilter,
  TicketQueryLogic,
  TicketQueryContract,
  TicketRetrievalSpec,
  TicketSearchPage,
  TicketSnapshot,
  TicketTaskTarget,
} from './types.js'

export interface RetrievalTaskContract {
  readonly target: TicketTaskTarget
  /** Explicit result count or adaptive upper bound, according to countPolicy. */
  readonly requestedCount: number
  readonly countPolicy: TicketCountPolicy
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
  readonly description?: string
}

export type RetrievalKnowledgeDecision = 'present_current_top_k' | 'accept_current_top_k' | 'return_partial' | 'no_result' | 'needs_clarification' | 'continue'
export type RetrievalNextAction = 'present_current_top_k' | 'accept_current_top_k' | 'finish_partial' | 'finish_no_result' | 'continue_ranking' | 'keyword_search' | 'vector_search' | 'promote' | 'clarify'

/** Strict semantic judgment proposed by the model and admitted by Harness. */
export interface RetrievalKnowledgeAssessment {
  readonly decision: RetrievalKnowledgeDecision
  readonly selectedCandidateRefs: readonly TicketCandidateRef[]
  readonly excludedCandidateRefs: readonly TicketCandidateRef[]
  readonly gaps: readonly RetrievalGap[]
  readonly nextAction: RetrievalNextAction
  readonly evaluator: 'model' | 'system'
  readonly model?: string
}

/** One immutable ranking observation; active ranking is derived across observations. */
export interface RetrievalRankingObservation {
  readonly searchEventId: string
  readonly stage: TicketSearchStage
  readonly queryFingerprint: string
  readonly ranking: readonly { readonly ref: TicketCandidateRef; readonly rank: number }[]
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
  /** Actual conversation-model requests admitted by the Harness. */
  readonly modelStepsUsed?: number
  readonly successfulToolCalls?: number
  readonly failedToolCalls?: number
  readonly providerLatencyMs?: number
  readonly modelLatencyMs?: number
  readonly wallClockElapsedMs?: number
  readonly serializationBytes?: number
  readonly totalInputTokens?: number
  readonly totalOutputTokens?: number
}

export interface RetrievalProgressState {
  readonly newCandidateRefs: readonly TicketCandidateRef[]
  /** Newly promoted L2 segments for the next compact tool delta. */
  readonly newEvidenceIds?: readonly TicketEvidenceId[]
  readonly rankOverlap: number
  readonly newDecisiveEvidence: boolean
  readonly resolvedGaps: readonly RetrievalGapKind[]
  readonly noProgressStreak: number
}

export type RetrievalTermination =
  | 'active'
  | 'top_k_accepted'
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
    readonly evidenceLevel: 'L1' | 'L2' | 'L3'
    readonly evidenceIds: readonly TicketEvidenceId[]
  }[]
  readonly stoppingReason: Exclude<RetrievalTermination, 'active' | 'needs_clarification'>
  readonly remainingGaps: readonly RetrievalGap[]
  readonly budget: RetrievalBudgetState
  readonly complete: boolean
  /** The current task decision is terminal, independent of source exhaustion. */
  readonly decisionFinalized: true
  /** A ranked Top-K task accepted the frozen selection. */
  readonly topKAccepted: boolean
  /** Exact query/ranking pagination fact; it is not a corpus-recall claim. */
  readonly resultPagesExhausted: boolean
  readonly semanticRecallKnown: boolean
  readonly resultMayBeIncomplete: boolean
  readonly nextPageAvailable: boolean
  readonly providerId: string
  readonly promptVersion: string
}

/**
 * The only terminal product value. It is a deterministic collection, never a
 * model-authored natural-language answer. `tickets` is the exact frozen
 * allowlist (or empty when the retrieval stopped before a set could be frozen).
 */
export interface TicketResultCollection {
  readonly type: 'ticket_collection'
  readonly schemaVersion: 1
  readonly retrievalId: RetrievalId
  readonly packId?: string
  readonly query: string
  readonly target: TicketTaskTarget
  readonly snapshotShortId?: string
  readonly stoppingReason: Exclude<RetrievalTermination, 'active' | 'needs_clarification'>
  readonly complete: boolean
  readonly decisionFinalized: true
  readonly topKAccepted: boolean
  readonly resultPagesExhausted: boolean
  readonly semanticRecallKnown: boolean
  readonly resultMayBeIncomplete: boolean
  readonly nextPageAvailable: boolean
  readonly tickets: readonly TicketCandidate[]
  readonly evidence: readonly TicketEvidenceSegment[]
  readonly remainingGapKinds: readonly RetrievalGapKind[]
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
    readonly contract?: TicketQueryContract
    readonly confirmedConstraints: readonly TicketFilter[]
    readonly unresolvedConstraints: readonly string[]
  }
  readonly candidates: readonly TicketCandidate[]
  /** Append-only acquisition history, distinct from the revisable active ranking. */
  readonly candidateHistory: readonly TicketCandidate[]
  readonly rankingHistory: readonly RetrievalRankingObservation[]
  readonly excludedCandidateRefs: readonly TicketCandidateRef[]
  readonly selectedCandidateRefs: readonly TicketCandidateRef[]
  readonly lastAssessment?: RetrievalKnowledgeAssessment | undefined
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

/** Durable metadata for an authorized on-demand detail read; ticket content is not persisted here. */
export interface CandidateDetailReadReceipt {
  readonly readId: string
  readonly retrievalId: RetrievalId
  readonly snapshotShortId: string
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly fields: readonly TicketEvidenceField[]
  readonly readAt: string
  readonly auditId: string
}

/** Candidate node is a deterministic UI projection, never model-authored Markdown. */
export interface TicketCandidateNode {
  readonly retrievalId: RetrievalId
  readonly version: number
  readonly querySummary: string
  readonly queryLogic?: TicketQueryLogic
  readonly snapshotShortId?: string
  readonly completeness: 'pending' | TicketSearchPage['completeness']
  readonly nextPageAvailable: boolean
  readonly resultPagesExhausted: boolean
  readonly semanticRecallKnown: boolean
  readonly boundary?: TicketSearchPage['boundary']
  readonly normalizedQuery?: string
  readonly resultPolicy?: TicketQueryContract['resultPolicy']
  readonly fastQuery?: TicketQueryContract['fastQuery']
  readonly queryAmbiguities?: TicketQueryContract['ambiguities']
  readonly status: 'searching' | 'results' | 'empty' | 'partial' | 'snapshot_invalid' | 'permission_blocked' | 'error' | 'stopped'
  readonly candidates: readonly TicketCandidate[]
  readonly alreadyReadEvidence: readonly TicketEvidenceSegment[]
  /** L2 text fields the Host may reauthorize for an explicit row click. */
  readonly detailFields: readonly { readonly key: TicketEvidenceField; readonly label: string }[]
  readonly message?: string
  readonly exportEnabled: boolean
  /** Present only after the retrieval has reached a terminal product value. */
  readonly result?: TicketResultCollection
}
