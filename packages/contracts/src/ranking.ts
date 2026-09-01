import type { TicketCandidateRef } from './brand.js'

/** `dense` is an external diagnostic/evaluation mode; the model-visible first pass remains fixed `hybrid`. */
export type TicketRetrievalMode = 'keyword' | 'dense' | 'hybrid'
export type TicketSearchStage = 'initial_hybrid' | 'repair_search' | 'next_page' | 'baseline'

export interface TicketSearchChannelTrace {
  readonly channel: 'keyword' | 'vector' | 'reranker'
  readonly implementation: string
  readonly version: string
  readonly resultCount: number
  readonly elapsedMs: number
  readonly model?: string
  readonly revision?: string
  readonly dimensions?: number
  readonly querySource?: 'direct_user_original' | 'direct_user_keywords' | 'agent_rewrite'
}

export interface TicketRankSignal {
  readonly candidateRef: TicketCandidateRef
  readonly finalRank: number
  readonly fusedScore: number
  readonly channels: readonly {
    readonly channel: 'keyword' | 'vector' | 'reranker'
    readonly rank: number
    readonly score: number
  }[]
}

/** Persisted diagnostics for one bounded search; vectors and model paths are deliberately absent. */
export interface TicketSearchTrace {
  readonly stage: TicketSearchStage
  readonly requestedMode: TicketRetrievalMode
  readonly executedMode: TicketRetrievalMode | 'keyword_fallback'
  readonly strategyVersion: string
  readonly channels: readonly TicketSearchChannelTrace[]
  readonly fusion?: {
    readonly method: 'weighted_rrf'
    readonly version: string
    readonly rankConstant: number
    readonly keywordWeight: number
    readonly vectorWeight: number
  }
  readonly reranker?: {
    readonly model: string
    readonly revision: string
    readonly topN: number
    readonly scoreKind: 'yes_probability'
  }
  readonly signals: readonly TicketRankSignal[]
}
