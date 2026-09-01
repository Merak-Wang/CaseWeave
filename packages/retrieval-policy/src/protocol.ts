import type {
  RetrievalKnowledgeAssessment,
  RetrievalRankingObservation,
  RetrievalState,
  TicketCandidate,
  TicketCandidateRef,
  TicketSearchStage,
} from '@retrieval-agent/contracts'

export const RAG_POLICY_PROTOCOL_VERSION = 'retrieval-agent.rag.v1' as const

export interface CandidateRankingInputParams {
  readonly previousHistory: readonly TicketCandidate[]
  readonly previousObservations: readonly RetrievalRankingObservation[]
  readonly page: readonly TicketCandidate[]
  readonly searchEventId: string
  readonly stage: TicketSearchStage
  readonly queryFingerprint: string
  readonly excludedRefs: readonly TicketCandidateRef[]
}

export interface UpdateCandidateRankingParams {
  readonly protocolVersion: typeof RAG_POLICY_PROTOCOL_VERSION
  readonly requestId: string
  readonly input: CandidateRankingInputParams
}

export interface CandidateRankingResultResponse {
  readonly version: 'candidate-ranking-v1'
  readonly history: readonly TicketCandidate[]
  readonly observations: readonly RetrievalRankingObservation[]
  readonly active: readonly TicketCandidate[]
}

export interface UpdateCandidateRankingResponse {
  readonly protocolVersion: typeof RAG_POLICY_PROTOCOL_VERSION
  readonly requestId: string
  readonly result: CandidateRankingResultResponse
  readonly elapsedMs: number
}

export interface PlanKnowledgeAssessmentParams {
  readonly protocolVersion: typeof RAG_POLICY_PROTOCOL_VERSION
  readonly requestId: string
  readonly state: RetrievalState
  readonly assessment: RetrievalKnowledgeAssessment
  readonly config: { readonly noProgressLimit: number }
}

export interface PlanKnowledgeAssessmentResponse {
  readonly protocolVersion: typeof RAG_POLICY_PROTOCOL_VERSION
  readonly requestId: string
  readonly version: 'knowledge-assessment-v1'
  readonly patch: Partial<RetrievalState>
  readonly elapsedMs: number
}
