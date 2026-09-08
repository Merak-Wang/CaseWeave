import type { RetrievalStateId, TicketCandidateRef, TicketEvidenceId } from './brand.js'
import type { RetrievalCandidateJudgment, RetrievalGap } from './retrieval-state.js'

/** Projection and origin are independent: a generated overview is never a source quote. */
export type TicketProjectionLevel = 'L0' | 'L1' | 'L2' | 'L3'
export interface TicketContentOrigin {
  readonly kind: 'source' | 'generated' | 'unknown'
  readonly sourceFields?: readonly string[]
  readonly description?: string
}
export interface EvidencePosition { readonly candidateRef: TicketCandidateRef; readonly field: string; readonly part: number; readonly start: number }
export interface ContextManifest {
  readonly id: string
  readonly roleId: string
  readonly stateId: RetrievalStateId
  readonly inputGeneration: number
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly evidenceIds: readonly TicketEvidenceId[]
  readonly evidenceSpans: readonly { readonly evidenceId: TicketEvidenceId; readonly start: number; readonly end: number; readonly contentHash: string }[]
  readonly knowledgeRefs: readonly string[]
  readonly releaseId?: string
  readonly renderedHash: string
  readonly estimatedTokens: number
  readonly tokenBudget?: number
  readonly measurement: 'conservative_estimate' | 'dsh_request'
}
export interface ExpertAssignment {
  readonly domainId: string
  readonly goal: string
  readonly scope: string
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly knowledgeIds?: readonly string[]
}
export type DisagreementKind = 'fact' | 'business_scope' | 'knowledge_conflict' | 'coverage' | 'source_conflict'
export interface ExpertFinding {
  readonly id: string
  readonly taskId: string
  readonly inputGeneration: number
  readonly judgments: readonly RetrievalCandidateJudgment[]
  readonly gaps: readonly RetrievalGap[]
  readonly counterEvidenceRefs: readonly string[]
  readonly nextAction: string
  readonly question?: string
  readonly disagreementKind?: DisagreementKind
}
export interface ExpertTask extends ExpertAssignment {
  readonly id: string
  readonly branchId: string
  readonly inputGeneration: number
  readonly releaseId?: string
  readonly knowledgeRefs: readonly string[]
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'superseded'
  readonly allowedTools: readonly string[]
  readonly maxActions: number
  readonly actionsUsed: number
  /** A committed execution fact, never the model's private reasoning. */
  readonly activity?: { readonly kind: 'starting' | 'inspect' | 'search' | 'report'; readonly at: string }
  readonly modelSteps?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly childSessionId?: string
  readonly failure?: string
  readonly finding?: ExpertFinding
  readonly context?: { readonly candidateRefs: readonly TicketCandidateRef[]; readonly evidencePosition?: EvidencePosition;
    readonly evidenceIds: readonly TicketEvidenceId[]; readonly evidenceWindowOffset: number }
}
export interface ExpertConflict {
  readonly candidateRef: TicketCandidateRef
  readonly findingIds: readonly string[]
  readonly kind: DisagreementKind
  readonly status: 'open' | 'resolved'
  readonly resolution?: { readonly reason: string; readonly evidenceRefs: readonly string[] }
}
export interface RetrievalKnowledgeCatalog {
  readonly releaseId?: string
  readonly status: 'available' | 'empty' | 'disabled'
  readonly warning?: string
  readonly domains: readonly { readonly id: string; readonly description: string; readonly entryIds: readonly string[] }[]
}
