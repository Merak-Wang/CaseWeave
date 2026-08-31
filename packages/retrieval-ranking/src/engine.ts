import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import { Bm25fIndex, BM25F_VERSION, type Bm25fOptions } from './bm25f.js'
import { DENSE_RANKING_VERSION, DenseRanker } from './dense.js'
import { FUSION_VERSION, weightedReciprocalRankFusion, type FusionOptions } from './fusion.js'
import { tokenizeRankingText } from './tokenize.js'
import type {
  RankOptions,
  RankingDocument,
  RankingChannelExecution,
  RankingHit,
  RankingQuery,
  RankingResult,
  RetrievalRanker,
} from './types.js'

export interface HybridRankingOptions {
  readonly gateway?: RetrievalModelGateway
  readonly embeddingIdentity?: { readonly model: string; readonly revision: string; readonly dimensions: number }
  readonly rerankerIdentity?: { readonly model: string; readonly revision: string }
  readonly cacheDir?: string
  readonly embeddingInstruction?: string
  readonly rerankerInstruction?: string
  readonly embeddingBatchSize?: number
  readonly modelDeadlineMs?: number
  readonly minimumDenseScore?: number
  readonly fusion?: FusionOptions
  readonly bm25f?: Bm25fOptions
  readonly rerankerEnabled?: boolean
  readonly rerankTopN?: number
  readonly allowKeywordFallback?: boolean
}

export class RankingError extends Error {
  constructor(readonly code: 'SCAN_LIMIT' | 'HYBRID_UNAVAILABLE', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RankingError'
  }
}

const DEFAULT_EMBEDDING_INSTRUCTION = 'Given a support ticket search query, retrieve historical tickets with matching symptoms, products, constraints, and resolution context.'
const DEFAULT_RERANKER_INSTRUCTION = 'Given a support ticket search query, determine whether the historical ticket describes the same user problem and compatible constraints.'

function profileVersion(options: HybridRankingOptions): string {
  const value = JSON.stringify({
    version: 'quick-hybrid-v1',
    embeddingIdentity: options.embeddingIdentity,
    rerankerIdentity: options.rerankerIdentity,
    embeddingInstruction: options.embeddingInstruction ?? DEFAULT_EMBEDDING_INSTRUCTION,
    rerankerInstruction: options.rerankerInstruction ?? DEFAULT_RERANKER_INSTRUCTION,
    embeddingBatchSize: options.embeddingBatchSize ?? 16,
    minimumDenseScore: options.minimumDenseScore ?? 0.1,
    fusion: options.fusion ?? {},
    bm25f: options.bm25f ?? {},
    rerankerEnabled: options.rerankerEnabled ?? false,
    rerankTopN: options.rerankTopN ?? 20,
  })
  return `quick-hybrid-v1:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function excluded(document: RankingDocument, terms: ReadonlySet<string>): boolean {
  if (terms.size === 0) return false
  const tokens = new Set(tokenizeRankingText(`${document.title}\n${document.summary}\n${document.body}\n${document.metadata}`))
  return [...terms].some(term => tokens.has(term))
}

function keywordHits(index: Bm25fIndex, query: RankingQuery): { readonly hits: RankingHit[]; readonly elapsedMs: number } {
  const result = index.search(query.text, query.excludedTerms)
  return {
    elapsedMs: result.elapsedMs,
    hits: result.hits.map(hit => ({
      documentId: hit.documentId,
      rank: hit.rank,
      score: hit.score,
      channels: [{ channel: 'keyword', rank: hit.rank, score: hit.score }],
    })),
  }
}

/** Provider-neutral implementation of the patent-mapped fixed quick hybrid retrieval stage. */
export class HybridRankingEngine implements RetrievalRanker {
  readonly profileVersion: string
  readonly capabilities: RetrievalRanker['capabilities']
  readonly #gateway: RetrievalModelGateway | undefined
  readonly #dense?: DenseRanker
  readonly #bm25f: Bm25fOptions | undefined
  readonly #fusion: FusionOptions
  readonly #rerankerInstruction: string
  readonly #rerankerEnabled: boolean
  readonly #rerankTopN: number
  readonly #allowKeywordFallback: boolean
  readonly #modelDeadlineMs: number

  constructor(options: HybridRankingOptions = {}) {
    this.profileVersion = profileVersion(options)
    this.#gateway = options.gateway
    this.#bm25f = options.bm25f
    this.#fusion = options.fusion ?? {}
    this.#rerankerInstruction = options.rerankerInstruction ?? DEFAULT_RERANKER_INSTRUCTION
    this.#rerankerEnabled = options.rerankerEnabled ?? false
    this.#rerankTopN = options.rerankTopN ?? 20
    this.#allowKeywordFallback = options.allowKeywordFallback ?? false
    this.#modelDeadlineMs = options.modelDeadlineMs ?? 120_000
    if (this.#gateway !== undefined) {
      this.#dense = new DenseRanker({
        gateway: this.#gateway,
        ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
        instruction: options.embeddingInstruction ?? DEFAULT_EMBEDDING_INSTRUCTION,
        ...(options.embeddingBatchSize === undefined ? {} : { batchSize: options.embeddingBatchSize }),
        ...(options.minimumDenseScore === undefined ? {} : { minimumScore: options.minimumDenseScore }),
        ...(options.modelDeadlineMs === undefined ? {} : { deadlineMs: options.modelDeadlineMs }),
      })
    }
    this.capabilities = {
      keyword: true,
      dense: this.#dense !== undefined,
      fusion: this.#dense !== undefined,
      reranker: this.#dense !== undefined && this.#rerankerEnabled,
    }
    if (!Number.isSafeInteger(this.#rerankTopN) || this.#rerankTopN < 1) throw new TypeError('rerankTopN must be positive')
  }

  async prepare(documents: readonly RankingDocument[], options: { readonly signal?: AbortSignal } = {}) {
    if (this.#dense === undefined) throw new RankingError('HYBRID_UNAVAILABLE', 'Dense 预加载要求已配置 Embedding 服务。')
    return await this.#dense.prepare(documents, options.signal)
  }

  async rank(documents: readonly RankingDocument[], query: RankingQuery, options: RankOptions): Promise<RankingResult> {
    if (!Number.isSafeInteger(options.maxScan) || options.maxScan < 1) throw new TypeError('maxScan must be positive')
    if (documents.length > options.maxScan) throw new RankingError('SCAN_LIMIT', '授权文档数量超过本地排名容量。')
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('cancelled')
    const excludedTerms = new Set(query.excludedTerms.flatMap(tokenizeRankingText))
    const allowed = documents.filter(document => !excluded(document, excludedTerms))
    const lexical = query.mode === 'dense' ? undefined : keywordHits(new Bm25fIndex(allowed, this.#bm25f), query)
    const keywordExecution = lexical === undefined ? undefined : {
      channel: 'keyword' as const,
      implementation: 'bm25f',
      version: BM25F_VERSION,
      resultCount: lexical.hits.length,
      elapsedMs: lexical.elapsedMs,
    }
    if (query.mode === 'keyword') {
      return {
        hits: lexical!.hits,
        execution: {
          requestedMode: 'keyword', executedMode: 'keyword', strategyVersion: this.profileVersion,
          channels: [keywordExecution!],
        },
        scanned: allowed.length,
        warnings: [],
      }
    }
    if (this.#dense === undefined) {
      if (query.mode === 'dense' || !this.#allowKeywordFallback) {
        throw new RankingError('HYBRID_UNAVAILABLE', 'Dense 或 Hybrid 检索要求已配置的 Embedding 服务。')
      }
      return {
        hits: lexical!.hits,
        execution: {
          requestedMode: 'hybrid', executedMode: 'keyword_fallback', strategyVersion: this.profileVersion,
          channels: [keywordExecution!],
        },
        scanned: allowed.length,
        warnings: ['dense_unavailable_keyword_fallback'],
      }
    }
    const denseQuery = [query.text, ...query.semanticHints].filter(Boolean).join('\n')
    let dense
    try {
      dense = await this.#dense.search(allowed, denseQuery, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (query.mode === 'dense' || !this.#allowKeywordFallback) {
        throw new RankingError('HYBRID_UNAVAILABLE', 'Dense 检索失败，禁止静默冒充可用通道。', { cause: error })
      }
      return {
        hits: lexical!.hits,
        execution: {
          requestedMode: 'hybrid', executedMode: 'keyword_fallback', strategyVersion: this.profileVersion,
          channels: [keywordExecution!],
        },
        scanned: allowed.length,
        warnings: ['dense_failed_keyword_fallback'],
      }
    }
    const denseExecution = {
      channel: 'vector' as const,
      implementation: 'exact_cosine',
      version: DENSE_RANKING_VERSION,
      resultCount: dense.hits.length,
      elapsedMs: dense.elapsedMs,
      model: dense.model,
      revision: dense.revision,
      dimensions: dense.dimensions,
    }
    if (query.mode === 'dense') {
      return {
        hits: dense.hits.map(hit => ({
          documentId: hit.documentId,
          rank: hit.rank,
          score: hit.score,
          channels: [{ channel: 'vector', rank: hit.rank, score: hit.score }],
        })),
        execution: {
          requestedMode: 'dense', executedMode: 'dense', strategyVersion: this.profileVersion,
          channels: [denseExecution],
        },
        scanned: allowed.length,
        warnings: [],
      }
    }
    let hits = weightedReciprocalRankFusion(
      lexical!.hits.map(hit => ({ documentId: hit.documentId, rank: hit.rank, score: hit.score })),
      dense.hits,
      this.#fusion,
    )
    const channels: RankingChannelExecution[] = [keywordExecution!, denseExecution]
    const warnings: string[] = []
    let reranker: { readonly model: string; readonly revision: string; readonly topN: number; readonly scoreKind: 'yes_probability' } | undefined
    if (this.#rerankerEnabled && this.#gateway !== undefined && hits.length > 0) {
      const started = performance.now()
      const selected = hits.slice(0, this.#rerankTopN)
      const byId = new Map(allowed.map(document => [document.id, document]))
      try {
        const ready = await this.#gateway.ready(options.signal)
        const descriptor = ready.models.find(model => model.kind === 'reranker' && model.loaded)
        if (descriptor === undefined) throw new Error('reranker model is not ready')
        const ranked = await this.#gateway.rerank({
          query: query.text,
          candidates: selected.map(hit => {
            const document = byId.get(hit.documentId)!
            return { id: hit.documentId, text: `${document.title}\n${document.summary}\n${document.body}`.slice(0, 12_000) }
          }),
          instruction: this.#rerankerInstruction,
          topK: selected.length,
          deadlineMs: this.#modelDeadlineMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
        const selectedIds = new Set(selected.map(hit => hit.documentId))
        const rankedIds = new Set(ranked.map(item => item.id))
        const rankedRanks = new Set(ranked.map(item => item.rank))
        if (ranked.length !== selected.length || rankedIds.size !== ranked.length || rankedRanks.size !== ranked.length
          || ranked.some(item => !selectedIds.has(item.id) || !Number.isSafeInteger(item.rank)
            || item.rank < 1 || item.rank > ranked.length || !Number.isFinite(item.score))) {
          throw new Error('reranker returned candidates outside the admitted fusion pool')
        }
        const reranked = new Map(ranked.map(item => [item.id, item]))
        hits = [...hits].sort((left, right) => {
          const leftRank = reranked.get(left.documentId)?.rank
          const rightRank = reranked.get(right.documentId)?.rank
          if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank
          if (leftRank !== undefined) return -1
          if (rightRank !== undefined) return 1
          return left.rank - right.rank
        }).map((hit, index) => {
          const score = reranked.get(hit.documentId)
          return {
            ...hit,
            rank: index + 1,
            channels: score === undefined ? hit.channels : [...hit.channels, { channel: 'reranker' as const, rank: score.rank, score: score.score }],
          }
        })
        channels.push({
          channel: 'reranker', implementation: 'qwen_yes_no', version: 'qwen-reranker-v1',
          resultCount: ranked.length, elapsedMs: Math.max(0, performance.now() - started),
          model: descriptor.model, revision: descriptor.revision,
        })
        reranker = { model: descriptor.model, revision: descriptor.revision, topN: selected.length, scoreKind: 'yes_probability' }
      } catch (error) {
        if (options.signal?.aborted) throw error
        warnings.push('reranker_failed_open')
      }
    }
    return {
      hits,
      execution: {
        requestedMode: 'hybrid', executedMode: 'hybrid', strategyVersion: this.profileVersion,
        channels,
        fusion: {
          method: 'weighted_rrf', version: FUSION_VERSION,
          rankConstant: this.#fusion.rankConstant ?? 60,
          keywordWeight: this.#fusion.keywordWeight ?? 0.55,
          vectorWeight: this.#fusion.vectorWeight ?? 0.45,
        },
        ...(reranker === undefined ? {} : { reranker }),
      },
      scanned: allowed.length,
      warnings,
    }
  }
}
