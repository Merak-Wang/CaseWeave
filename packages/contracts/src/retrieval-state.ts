import type {
  RetrievalId,
  RetrievalStateId,
  TicketCandidateRef,
  TicketEvidenceId,
} from './brand.js'
import type { RetrievalErrorCode } from './errors.js'
import type { TicketSearchStage } from './ranking.js'
import type {
  TicketCandidate,
  TicketCountPolicy,
  TicketEvidenceField,
  TicketEvidenceSegment,
  TicketFilter,
  TicketQueryLogic,
  TicketQueryContract,
  TicketQueryDelta,
  TicketRetrievalSpec,
  TicketSearchPage,
  TicketSnapshot,
  TicketTaskTarget,
} from './types.js'

export interface RetrievalTaskContract {
  readonly target: TicketTaskTarget
  /** User-level Top-K limit. Exhaustive tasks deliberately omit it. */
  readonly requestedCount?: number
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
export type RetrievalNextAction = 'present_current_top_k' | 'accept_current_top_k' | 'finish_partial' | 'finish_no_result' | 'continue_ranking' | 'keyword_search' | 'vector_search' | 'read_l3_details' | 'clarify'

/** Pre-v12 assessment shape retained only to decode historical Session events. */
export interface RetrievalKnowledgeAssessment {
  readonly decision: RetrievalKnowledgeDecision
  readonly selectedCandidateRefs: readonly TicketCandidateRef[]
  readonly excludedCandidateRefs: readonly TicketCandidateRef[]
  readonly gaps: readonly RetrievalGap[]
  readonly nextAction: RetrievalNextAction
  readonly evaluator: 'model' | 'system'
  readonly model?: string
}

/** A judgment is supported only by evidence actually delivered to this model. */
export interface RetrievalCandidateJudgment {
  readonly exclusionChecks?: readonly {
    readonly requirementId: string
    readonly sourceText: string
    readonly applies: 'yes' | 'no' | 'uncertain'
    readonly reason: string
    readonly evidenceRefs: readonly string[]
  }[]
  readonly adoptedFindingId?: string
  readonly conflictResolution?: { readonly kind: import('./agent-context.js').DisagreementKind; readonly reason: string; readonly evidenceRefs: readonly string[] }
  readonly candidateRef: TicketCandidateRef
  readonly verdict: 'accept' | 'exclude' | 'undetermined'
  readonly evidenceRefs: readonly string[]
  readonly reason: string
}

/** One public model submission: judgments, remaining gaps, and one executable action. */
export interface RetrievalDecision {
  readonly stateId: RetrievalStateId
  readonly judgments: readonly RetrievalCandidateJudgment[]
  readonly gaps: readonly RetrievalGap[]
  readonly action:
    | { readonly kind: 'search'; readonly mode?: 'keyword' | 'dense'; readonly delta?: TicketQueryDelta; readonly continueRanking?: boolean }
    | { readonly kind: 'inspect'; readonly candidateRefs?: readonly TicketCandidateRef[]; readonly fields?: readonly TicketEvidenceField[]; readonly nextWindow?: boolean; readonly tokenBudget?: number; readonly position?: import('./agent-context.js').EvidencePosition; readonly level?: 'L2' | 'L3'; readonly history?: boolean }
    | { readonly kind: 'delegate'; readonly assignments: readonly import('./agent-context.js').ExpertAssignment[] }
    | { readonly kind: 'clarify'; readonly question: string; readonly candidateRefs: readonly TicketCandidateRef[]; readonly evidenceRefs: readonly string[]; readonly facet?: string; readonly options?: readonly string[] }
    | { readonly kind: 'finish'; readonly reason?: 'satisfied' | 'no_result' | 'incomplete'; readonly explanation: string;
        readonly coverage?: { readonly checked: readonly string[]; readonly remaining: readonly string[];
          readonly nextAction: string; readonly nextActionValue: 'useful' | 'low' | 'none';
          readonly expertReviews?: readonly { readonly taskId: string; readonly reason: string; readonly evidenceRefs: readonly string[] }[] } }
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

export interface ContextCompressionStats {
  readonly workingSetCount: number
  readonly capacityCount: number
  readonly last?: { readonly reason: 'working_set' | 'window_pressure' | 'provider_overflow'; readonly beforeTokens: number;
    readonly thresholdTokens: number; readonly limit: number; readonly at: string }
}
export interface RetrievalBudgetState {
  /** Latest full request usage, independent of the lifetime token totals. */
  readonly context?: { readonly estimatedInputTokens: number; readonly measuredInputTokens?: number;
    readonly limit?: number; readonly reservedTokens: number; readonly compactionCount: number; readonly compression?: ContextCompressionStats }
  /** Cross-action Provider page ceiling. */
  readonly maxSearches: number
  readonly maxConsecutiveToolErrors?: number
  readonly maxRepeatedToolErrors?: number
  readonly repeatedToolFailure?: { readonly signature: string; readonly count: number }
  readonly consecutiveToolErrors?: number
  readonly searchesUsed: number
  /** Actual conversation-model requests admitted by the Harness. */
  readonly modelStepsUsed: number
  readonly successfulToolCalls?: number
  readonly failedToolCalls?: number
  readonly providerLatencyMs?: number
  readonly modelLatencyMs?: number
  readonly wallClockElapsedMs: number
  readonly serializationBytes?: number
  readonly totalInputTokens?: number
  readonly totalMeasuredInputTokens?: number
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
  | 'capacity_exceeded'
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
 * model-authored natural-language answer. `tickets` contains the accepted
 * current candidates. Unjudged candidates belong only to the progress projection.
 */
export interface TicketResultCollection {
  readonly type: 'ticket_collection'
  readonly schemaVersion: 2
  readonly retrievalId: RetrievalId
  readonly packId?: string
  readonly resultRevision: string
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
  readonly judgments: readonly RetrievalCandidateJudgment[]
  readonly explanation?: string
  readonly evidence: readonly TicketEvidenceSegment[]
  readonly remainingGapKinds: readonly RetrievalGapKind[]
}

/** Complete domain state, reconstructable from versioned events. */
export interface RetrievalState {
  readonly projectionVersion?: 2
  /** Increments for every accepted user update, including semantic feedback. */
  readonly inputGeneration?: number
  readonly contextManifests?: readonly import('./agent-context.js').ContextManifest[]
  readonly knowledgeCatalog?: import('./agent-context.js').RetrievalKnowledgeCatalog
  readonly expertTasks?: readonly import('./agent-context.js').ExpertTask[]
  readonly expertConflicts?: readonly import('./agent-context.js').ExpertConflict[]
  readonly sharedSearches?: readonly { readonly key: string; readonly spec: TicketRetrievalSpec; readonly page: TicketSearchPage; readonly inputGeneration: number }[]
  readonly evidenceReadPosition?: import('./agent-context.js').EvidencePosition | undefined
  readonly contextCandidateRefs?: readonly TicketCandidateRef[] | undefined
  readonly searchProgress?: import('./provider.js').TicketSearchProgress | undefined
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
  readonly activeRankingStart?: number
  readonly excludedCandidateRefs: readonly TicketCandidateRef[]
  readonly selectedCandidateRefs: readonly TicketCandidateRef[]
  readonly judgments?: readonly RetrievalCandidateJudgment[]
  /** Accumulated actual model visibility, invalidated when hard conditions change. */
  readonly modelVisibleCandidateRefs?: readonly TicketCandidateRef[]
  readonly modelVisibleEvidenceIds?: readonly TicketEvidenceId[]
  /** Compatible IDs before additive background updates; decisions still validate current evidence/conflicts. */
  readonly measurementStateIds?: readonly RetrievalStateId[]
  readonly coordinatorActivity?: 'working' | 'waiting_experts'
  readonly candidateWindowOffset?: number
  readonly evidenceWindowOffset?: number
  /** Preserved provider failure identity behind a stopped termination. */
  readonly stopErrorCode?: RetrievalErrorCode | undefined
  readonly stopExplanation?: string | undefined
  readonly userFeedback?: readonly { readonly text: string; readonly receivedAt: string; readonly question?: string }[]
  /** Waiting time is excluded from the online execution limit. */
  readonly executionClock?: { readonly waitingSince?: string; readonly totalWaitingMs: number }
  /** Historical replay is a fact source, not a current access grant. */
  readonly accessValidation?: 'current' | 'required'
  readonly lastAssessment?: RetrievalKnowledgeAssessment | undefined
  readonly lastPage?: TicketSearchPage | undefined
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
    readonly evidenceRefs?: readonly string[]
    readonly options?: readonly string[]
  }
  readonly frozenEvidence?: FrozenEvidencePack | undefined
  readonly provenance: RetrievalStateProvenance
}

/** RFC 6902-shaped operation used only for a state-to-state durable transition. */
export type RetrievalStatePatchOperation =
  | { readonly op: 'add' | 'replace'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string }

/** One replayable, state-chain-bound delta between consecutive revisions. */
export interface RetrievalStatePatch {
  readonly fromStateId: RetrievalStateId
  readonly fromRevision: number
  readonly toStateId: RetrievalStateId
  readonly toRevision: number
  readonly operations: readonly RetrievalStatePatchOperation[]
}

export interface EvidenceContextSelection {
  readonly manifest?: import('./agent-context.js').ContextManifest
  readonly retrievalId: RetrievalId
  readonly stateId: RetrievalStateId
  readonly policyVersion: string
  readonly includedCandidateRefs: readonly TicketCandidateRef[]
  readonly includedEvidenceIds: readonly TicketEvidenceId[]
  readonly excluded: readonly { readonly ref: string; readonly reason: 'unauthorized' | 'not_selected' | 'superseded' | 'token_budget' | 'unread' }[]
  /** Optional deployment cap. Absent means structural selection bounds are the only product-level limit. */
  readonly tokenBudget?: number
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
  /** Absent only on receipts created before versioned confirmation downloads. */
  readonly resultRevision?: string
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
  /** Bounded task snapshots carry authoritative totals; terminal arrays are fetched via dedicated APIs. */
  readonly collectionWindow?: { readonly current: number; readonly history: number; readonly confirmed: number; readonly version: string; readonly limit: number }
  readonly expertProgress?: readonly { readonly id: string; readonly domainId: string; readonly goal: string; readonly status: import('./agent-context.js').ExpertTask['status']; readonly findingCount: number; readonly failure?: string }[]
  readonly openExpertConflicts?: number
  readonly searchProgress?: import('./provider.js').TicketSearchProgress
  readonly retrievalId: RetrievalId
  readonly version: number
  readonly querySummary: string
  readonly confirmedConstraints?: readonly TicketFilter[]
  readonly selectedCandidateRefs?: readonly TicketCandidateRef[]
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
  /** Current effective keyword terms; falls back to the immutable first-round plan. */
  readonly keywordTerms?: readonly string[]
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
