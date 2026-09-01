import { createHash, randomUUID } from 'node:crypto'
import {
  RAG_SERVICE_PROTOCOL_VERSION,
  type PrepareRankingParams,
  type PrepareRankingResponse,
  type RankDocumentsParams,
  type RankDocumentsResponse,
  type RankingProfileParams,
} from './protocol.js'
import type { RankOptions, RankingDocument, RankingHit, RankingQuery, RankingResult, RetrievalRanker } from './types.js'

export interface Bm25fOptions {
  readonly k1?: number
  readonly fields?: Readonly<Record<'title' | 'summary' | 'body' | 'metadata', { readonly weight: number; readonly b: number }>>
  readonly minimumScore?: number
}

export interface FusionOptions {
  readonly rankConstant?: number
  readonly keywordWeight?: number
  readonly vectorWeight?: number
}

export interface HybridRankingOptions {
  readonly baseUrl?: string
  readonly embeddingIdentity?: { readonly model: string; readonly revision: string; readonly dimensions: number }
  readonly rerankerIdentity?: { readonly model: string; readonly revision: string }
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
  readonly fetch?: typeof globalThis.fetch
}

export class RankingError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RankingError'
  }
}

const EMBEDDING_INSTRUCTION = 'Given a support ticket search query, retrieve historical tickets with matching symptoms, products, constraints, and resolution context.'
const RERANKER_INSTRUCTION = 'Given a support ticket search query, determine whether the historical ticket describes the same user problem and compatible constraints.'

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    // Code-point ordering is deliberately shared with Python; localeCompare would make profile hashes host-dependent.
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function createProfile(options: HybridRankingOptions): RankingProfileParams {
  return {
    ...(options.embeddingIdentity === undefined ? {} : { embeddingIdentity: { ...options.embeddingIdentity } }),
    ...(options.rerankerIdentity === undefined ? {} : { rerankerIdentity: { ...options.rerankerIdentity } }),
    embeddingInstruction: options.embeddingInstruction ?? EMBEDDING_INSTRUCTION,
    rerankerInstruction: options.rerankerInstruction ?? RERANKER_INSTRUCTION,
    embeddingBatchSize: options.embeddingBatchSize ?? 16,
    modelDeadlineMs: options.modelDeadlineMs ?? 120_000,
    minimumDenseScore: options.minimumDenseScore ?? 0.1,
    fusion: {
      rankConstant: options.fusion?.rankConstant ?? 60,
      keywordWeight: options.fusion?.keywordWeight ?? 0.55,
      vectorWeight: options.fusion?.vectorWeight ?? 0.45,
    },
    bm25f: { ...options.bm25f },
    rerankerEnabled: options.rerankerEnabled ?? false,
    rerankTopN: options.rerankTopN ?? 20,
    allowKeywordFallback: options.allowKeywordFallback ?? false,
  }
}

function profileVersion(profile: RankingProfileParams): string {
  const identity = {
    version: 'quick-hybrid-v1',
    embeddingIdentity: profile.embeddingIdentity ?? null,
    rerankerIdentity: profile.rerankerIdentity ?? null,
    embeddingInstruction: profile.embeddingInstruction,
    rerankerInstruction: profile.rerankerInstruction,
    embeddingBatchSize: profile.embeddingBatchSize,
    minimumDenseScore: profile.minimumDenseScore,
    fusion: profile.fusion,
    bm25f: profile.bm25f,
    rerankerEnabled: profile.rerankerEnabled,
    rerankTopN: profile.rerankTopN,
  }
  return `quick-hybrid-v1:${createHash('sha256').update(stable(identity)).digest('hex').slice(0, 16)}`
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validHits(value: unknown, documents: readonly RankingDocument[]): value is readonly RankingHit[] {
  if (!Array.isArray(value)) return false
  const admitted = new Set(documents.map(document => document.id))
  const returned = new Set<string>()
  return value.every((raw, index) => {
    const hit = object(raw)
    if (typeof hit?.documentId !== 'string' || !admitted.has(hit.documentId) || returned.has(hit.documentId)
      || hit.rank !== index + 1 || !finite(hit.score) || !Array.isArray(hit.channels) || hit.channels.length === 0) return false
    returned.add(hit.documentId)
    return hit.channels.every(rawChannel => {
      const channel = object(rawChannel)
      return ['keyword', 'vector', 'reranker'].includes(String(channel?.channel))
        && Number.isSafeInteger(channel?.rank) && Number(channel?.rank) >= 1 && finite(channel?.score)
    })
  })
}

function validResult(value: unknown, documents: readonly RankingDocument[], expectedProfile: string): value is RankingResult {
  const result = object(value)
  const execution = object(result?.execution)
  if (!validHits(result?.hits, documents) || execution?.strategyVersion !== expectedProfile
    || !['keyword', 'dense', 'hybrid'].includes(String(execution?.requestedMode))
    || !['keyword', 'dense', 'hybrid', 'keyword_fallback'].includes(String(execution?.executedMode))
    || !Array.isArray(execution.channels) || execution.channels.length === 0
    || !Number.isSafeInteger(result?.scanned) || Number(result?.scanned) < 0 || Number(result?.scanned) > documents.length
    || !Number.isSafeInteger(result?.keywordEligible) || Number(result?.keywordEligible) < 0
    || Number(result?.keywordEligible) > Number(result?.scanned) || result?.rankedHits !== result.hits.length
    || !Array.isArray(result.warnings) || !result.warnings.every(item => typeof item === 'string')) return false
  return execution.channels.every(raw => {
    const channel = object(raw)
    return ['keyword', 'vector', 'reranker'].includes(String(channel?.channel))
      && typeof channel?.implementation === 'string' && typeof channel.version === 'string'
      && Number.isSafeInteger(channel.resultCount) && Number(channel.resultCount) >= 0 && finite(channel.elapsedMs)
  })
}

/** HTTP adapter for BM25F/dense/fusion/reranking implemented by the uv-managed Python service. */
export class HybridRankingEngine implements RetrievalRanker {
  readonly profileVersion: string
  readonly capabilities: RetrievalRanker['capabilities']
  readonly #baseUrl: string
  readonly #profile: RankingProfileParams
  readonly #deadlineMs: number
  readonly #fetch: typeof globalThis.fetch

  constructor(options: HybridRankingOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8012').replace(/\/+$/u, '')
    this.#profile = createProfile(options)
    this.#deadlineMs = options.modelDeadlineMs ?? 120_000
    this.#fetch = options.fetch ?? globalThis.fetch
    this.profileVersion = profileVersion(this.#profile)
    this.capabilities = {
      keyword: true,
      dense: options.embeddingIdentity !== undefined,
      fusion: options.embeddingIdentity !== undefined,
      reranker: options.embeddingIdentity !== undefined && (options.rerankerEnabled ?? false),
    }
    if (!/^https?:\/\//u.test(this.#baseUrl)) throw new TypeError('RAG service baseUrl must use http or https')
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs < 100) throw new TypeError('modelDeadlineMs must be at least 100ms')
  }

  async prepare(documents: readonly RankingDocument[], options: { readonly signal?: AbortSignal } = {}) {
    const identity = this.#profile.embeddingIdentity
    if (identity === undefined) throw new RankingError('HYBRID_UNAVAILABLE', 'Dense 预加载要求已配置 Embedding 身份。')
    const requestId = randomUUID()
    const body: PrepareRankingParams = {
      protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
      requestId,
      documents,
      profile: this.#profile,
      options: { maxScan: Math.max(1, documents.length), deadlineMs: this.#deadlineMs },
    }
    const response = await this.#request<PrepareRankingResponse>('/v1/ranking/prepare', body, options.signal)
    if (response.protocolVersion !== RAG_SERVICE_PROTOCOL_VERSION || response.requestId !== requestId
      || response.documentCount !== documents.length || response.profileVersion !== this.profileVersion
      || response.model !== identity.model || response.revision !== identity.revision
      || response.dimensions !== identity.dimensions || !finite(response.elapsedMs)) {
      throw new RankingError('PROTOCOL_MISMATCH', 'RAG 服务返回了无效的索引预热响应。')
    }
    return response
  }

  async rank(documents: readonly RankingDocument[], query: RankingQuery, options: RankOptions): Promise<RankingResult> {
    if (!Number.isSafeInteger(options.maxScan) || options.maxScan < 1) throw new TypeError('maxScan must be positive')
    if (documents.length > options.maxScan) throw new RankingError('SCAN_LIMIT', '授权文档数量超过本地排名容量。')
    const requestId = randomUUID()
    const body: RankDocumentsParams = {
      protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
      requestId,
      documents,
      query,
      profile: this.#profile,
      options: { maxScan: options.maxScan, deadlineMs: this.#deadlineMs },
    }
    const response = await this.#request<RankDocumentsResponse>('/v1/ranking/rank', body, options.signal)
    if (response.protocolVersion !== RAG_SERVICE_PROTOCOL_VERSION || response.requestId !== requestId
      || !finite(response.elapsedMs) || !validResult(response.result, documents, this.profileVersion)
      || response.result.execution.requestedMode !== query.mode) {
      throw new RankingError('PROTOCOL_MISMATCH', 'RAG 服务返回了越界或无效的排名响应。')
    }
    return response.result
  }

  async #request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('deadline exceeded')), this.#deadlineMs)
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const error = object(object(value)?.error)
        throw new RankingError(
          typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
          typeof error?.message === 'string' ? error.message : `RAG 服务返回 HTTP ${response.status}。`,
          typeof error?.retryable === 'boolean' ? error.retryable : response.status >= 500,
          response.status,
        )
      }
      if (object(value) === undefined) throw new RankingError('PROTOCOL_MISMATCH', 'RAG 服务返回了无效 JSON。')
      return value as T
    } catch (error) {
      if (error instanceof RankingError) throw error
      const cancelled = signal?.aborted === true
      if (controller.signal.aborted) {
        throw new RankingError(cancelled ? 'CANCELLED' : 'DEADLINE_EXCEEDED', cancelled ? 'RAG 请求已取消。' : 'RAG 请求超过截止时间。', !cancelled, undefined, { cause: error })
      }
      throw new RankingError('UNAVAILABLE', '无法连接本地 RAG 服务。', true, undefined, { cause: error })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
