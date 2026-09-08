import type { PreparationProgress, RankingDocument, RankingQuery, RankingResult } from './types.js'

export const RAG_SERVICE_PROTOCOL_VERSION = 'retrieval-agent.rag.v1' as const

export interface RankingProfileParams {
  readonly embeddingIdentity?: { readonly model: string; readonly revision: string; readonly dimensions: number }
  readonly rerankerIdentity?: { readonly model: string; readonly revision: string }
  readonly embeddingInstruction: string
  readonly rerankerInstruction: string
  readonly embeddingBatchSize: number
  readonly modelDeadlineMs: number
  readonly minimumDenseScore: number
  /** Hard candidate budget applied to the dense channel before fusion. */
  readonly denseTopK: number
  readonly fusion: {
    readonly rankConstant: number
    readonly keywordWeight: number
    readonly vectorWeight: number
  }
  readonly bm25f: {
    readonly k1?: number
    readonly fields?: Readonly<Record<'title' | 'summary' | 'body' | 'metadata', { readonly weight: number; readonly b: number }>>
    readonly minimumScore?: number
  }
  readonly rerankerEnabled: boolean
  readonly rerankTopN: number
  readonly allowKeywordFallback: boolean
}

export interface PrepareRankingParams {
  readonly protocolVersion: typeof RAG_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly documents: readonly RankingDocument[]
  readonly profile: RankingProfileParams
  readonly options: {
    readonly maxScan: number
  }
}

export interface PrepareRankingResponse {
  readonly protocolVersion: typeof RAG_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly documentCount: number
  readonly model: string
  readonly revision: string
  readonly dimensions: number
  readonly elapsedMs: number
  readonly profileVersion: string
}

export interface PrepareRankingProgressResponse {
  readonly protocolVersion: typeof RAG_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly progress: PreparationProgress
}

export interface RankDocumentsParams {
  readonly protocolVersion: typeof RAG_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly documents: readonly RankingDocument[]
  readonly query: RankingQuery
  readonly profile: RankingProfileParams
  readonly options: { readonly maxScan: number; readonly deadlineMs: number }
}

export interface RankDocumentsResponse {
  readonly protocolVersion: typeof RAG_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly result: RankingResult
  readonly elapsedMs: number
}

export interface RagServiceErrorResponse {
  readonly protocolVersion?: string
  readonly requestId?: string
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean }
}
