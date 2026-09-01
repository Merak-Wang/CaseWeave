export type RankingMode = 'keyword' | 'dense' | 'hybrid'
export type RankingChannelKind = 'keyword' | 'vector' | 'reranker'

export interface RankingDocument {
  readonly id: string
  readonly contentHash: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly metadata: string
}

export interface RankingQuery {
  readonly text: string
  readonly semanticHints: readonly string[]
  readonly excludedTerms: readonly string[]
  /** Every group must match; alternatives inside one group are equivalent. */
  readonly requiredConcepts?: readonly {
    readonly canonical: string
    readonly alternatives: readonly string[]
  }[]
  readonly mode: RankingMode
}

export interface RankingChannelScore {
  readonly channel: RankingChannelKind
  readonly rank: number
  readonly score: number
}

export interface RankingHit {
  readonly documentId: string
  readonly rank: number
  readonly score: number
  readonly channels: readonly RankingChannelScore[]
}

export interface RankingChannelExecution {
  readonly channel: RankingChannelKind
  readonly implementation: string
  readonly version: string
  readonly resultCount: number
  readonly elapsedMs: number
  readonly model?: string
  readonly revision?: string
  readonly dimensions?: number
}

export interface RankingExecution {
  readonly requestedMode: RankingMode
  readonly executedMode: RankingMode | 'keyword_fallback'
  readonly strategyVersion: string
  readonly channels: readonly RankingChannelExecution[]
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
}

export interface RankingResult {
  readonly hits: readonly RankingHit[]
  readonly execution: RankingExecution
  readonly scanned: number
  readonly warnings: readonly string[]
}

export interface RankOptions {
  readonly maxScan: number
  readonly signal?: AbortSignal
}

export interface RetrievalRanker {
  readonly profileVersion: string
  readonly capabilities: {
    readonly keyword: true
    readonly dense: boolean
    readonly fusion: boolean
    readonly reranker: boolean
  }
  /** Optional lifecycle hook used to make document vectors ready before traffic. */
  prepare?(documents: readonly RankingDocument[], options?: { readonly signal?: AbortSignal }): Promise<{
    readonly documentCount: number
    readonly model: string
    readonly revision: string
    readonly dimensions: number
    readonly elapsedMs: number
  }>
  rank(documents: readonly RankingDocument[], query: RankingQuery, options: RankOptions): Promise<RankingResult>
}
