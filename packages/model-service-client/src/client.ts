import { randomUUID } from 'node:crypto'
import {
  MODEL_SERVICE_PROTOCOL_VERSION,
  type EmbedTextsParams,
  type EmbedTextsResponse,
  type ModelServiceErrorResponse,
  type ModelServiceReadyResponse,
  type RerankTextsParams,
  type RerankTextsResponse,
} from './protocol.js'
import type { EmbedInput, RerankInput, RetrievalModelGateway } from './types.js'

export interface ModelServiceClientOptions {
  readonly baseUrl: string
  readonly embeddingModel: string
  readonly embeddingDimensions: number
  readonly embeddingRevision?: string
  readonly rerankerModel?: string
  readonly rerankerRevision?: string
  readonly defaultDeadlineMs?: number
  readonly fetch?: typeof globalThis.fetch
}

export class ModelServiceClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ModelServiceClientError'
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function errorPayload(value: unknown): ModelServiceErrorResponse | undefined {
  const body = object(value)
  const error = object(body?.error)
  return typeof error?.code === 'string' && typeof error.message === 'string' && typeof error.retryable === 'boolean'
    ? { error: { code: error.code, message: error.message, retryable: error.retryable } }
    : undefined
}

function finiteVector(value: unknown, dimensions: number): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length !== dimensions) return undefined
  if (!value.every(item => typeof item === 'number' && Number.isFinite(item))) return undefined
  const vector = value as number[]
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0))
  return Math.abs(norm - 1) <= 0.02 ? vector : undefined
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new ModelServiceClientError('CANCELLED', '模型请求已取消。', false))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new ModelServiceClientError('CANCELLED', '模型请求已取消。', false))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
  })
}

/** Versioned, bounded client for the long-lived local model process. */
export class ModelServiceClient implements RetrievalModelGateway {
  readonly #baseUrl: string
  readonly #embeddingModel: string
  readonly #embeddingDimensions: number
  readonly #embeddingRevision: string | undefined
  readonly #rerankerModel: string | undefined
  readonly #rerankerRevision: string | undefined
  readonly #defaultDeadlineMs: number
  readonly #fetch: typeof globalThis.fetch
  #readyPromise: Promise<ModelServiceReadyResponse> | undefined

  constructor(options: ModelServiceClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.#embeddingModel = options.embeddingModel
    this.#embeddingDimensions = options.embeddingDimensions
    this.#embeddingRevision = options.embeddingRevision
    this.#rerankerModel = options.rerankerModel
    this.#rerankerRevision = options.rerankerRevision
    this.#defaultDeadlineMs = options.defaultDeadlineMs ?? 30_000
    this.#fetch = options.fetch ?? globalThis.fetch
    if (!/^https?:\/\//u.test(this.#baseUrl)) throw new TypeError('model service baseUrl must use http or https')
    if (!Number.isSafeInteger(this.#embeddingDimensions) || this.#embeddingDimensions < 1) throw new TypeError('embeddingDimensions must be positive')
    if (!Number.isSafeInteger(this.#defaultDeadlineMs) || this.#defaultDeadlineMs < 100) throw new TypeError('defaultDeadlineMs must be at least 100ms')
  }

  ready(signal?: AbortSignal): Promise<ModelServiceReadyResponse> {
    this.#readyPromise ??= this.#request<ModelServiceReadyResponse>('/health/ready', undefined, undefined, this.#defaultDeadlineMs)
      .then(response => {
        if (response.protocolVersion !== MODEL_SERVICE_PROTOCOL_VERSION || response.ready !== true || !Array.isArray(response.models)) {
          throw new ModelServiceClientError('PROTOCOL_MISMATCH', '模型服务握手响应不兼容。', false)
        }
        const embedding = response.models.find(model => model.kind === 'embedding' && model.model === this.#embeddingModel)
        if (embedding === undefined || embedding.loaded !== true || embedding.dimensions !== this.#embeddingDimensions
          || embedding.pooling !== 'last_token' || embedding.normalization !== 'l2') {
          throw new ModelServiceClientError('MODEL_MISMATCH', '模型服务没有加载配置要求的 Embedding 模型。', false)
        }
        if (this.#embeddingRevision !== undefined && embedding.revision !== this.#embeddingRevision) {
          throw new ModelServiceClientError('MODEL_MISMATCH', 'Embedding 模型 revision 与配置不一致。', false)
        }
        if (this.#rerankerModel !== undefined) {
          const reranker = response.models.find(model => model.kind === 'reranker' && model.model === this.#rerankerModel)
          if (reranker === undefined || reranker.loaded !== true || reranker.scoreKind !== 'yes_probability') {
            throw new ModelServiceClientError('MODEL_MISMATCH', '模型服务没有加载配置要求的重排模型。', false)
          }
          if (this.#rerankerRevision !== undefined && reranker.revision !== this.#rerankerRevision) {
            throw new ModelServiceClientError('MODEL_MISMATCH', '重排模型 revision 与配置不一致。', false)
          }
        }
        return response
      })
      .catch(error => {
        this.#readyPromise = undefined
        throw error
      })
    return waitForCaller(this.#readyPromise, signal)
  }

  async embed(input: EmbedInput): Promise<readonly (readonly number[])[]> {
    if (input.texts.length === 0) return []
    const ready = await this.ready(input.signal)
    if (input.texts.length > ready.limits.maxBatchSize) throw new ModelServiceClientError('BATCH_LIMIT', 'Embedding 批次超过服务上限。', false)
    const requestId = randomUUID()
    const body: EmbedTextsParams = {
      ...(input.requireCompleteInput === undefined ? {} : { requireCompleteInput: input.requireCompleteInput }),
      protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
      requestId,
      model: this.#embeddingModel,
      input: [...input.texts],
      inputType: input.inputType,
      dimensions: this.#embeddingDimensions,
      normalize: true,
      ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    }
    const response = await this.#request<EmbedTextsResponse>('/v1/embeddings', body, input.signal, input.deadlineMs ?? this.#defaultDeadlineMs)
    if (input.requireCompleteInput && response.inputComplete !== true) throw new ModelServiceClientError('PROTOCOL_MISMATCH', '模型未证明输入已完整嵌入。', false)
    if (response.timings && Object.values(response.timings).every(value => Number.isFinite(value) && value >= 0)) input.onTiming?.(response.timings)
    if (response.protocolVersion !== MODEL_SERVICE_PROTOCOL_VERSION || response.requestId !== requestId
      || response.model !== this.#embeddingModel || response.dimensions !== this.#embeddingDimensions
      || (this.#embeddingRevision !== undefined && response.revision !== this.#embeddingRevision)
      || response.normalization !== 'l2' || !Number.isFinite(response.elapsedMs) || response.elapsedMs < 0
      || !Array.isArray(response.data) || response.data.length !== input.texts.length) {
      throw new ModelServiceClientError('PROTOCOL_MISMATCH', 'Embedding 响应元数据不兼容。', false)
    }
    return response.data.map((row, index) => {
      const vector = row.index === index ? finiteVector(row.embedding, this.#embeddingDimensions) : undefined
      if (vector === undefined) throw new ModelServiceClientError('INVALID_VECTOR', `Embedding 第 ${index} 行无效。`, false)
      return vector
    })
  }

  async rerank(input: RerankInput): Promise<readonly { readonly id: string; readonly rank: number; readonly score: number }[]> {
    if (this.#rerankerModel === undefined) throw new ModelServiceClientError('CAPABILITY_DISABLED', '未配置重排模型。', false)
    if (input.candidates.length === 0) return []
    const ready = await this.ready(input.signal)
    if (input.candidates.length > ready.limits.maxRerankCandidates) throw new ModelServiceClientError('BATCH_LIMIT', '重排候选超过服务上限。', false)
    const requestId = randomUUID()
    const body: RerankTextsParams = {
      protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
      requestId,
      model: this.#rerankerModel,
      query: input.query,
      candidates: input.candidates.map(candidate => ({ ...candidate })),
      instruction: input.instruction,
      topK: input.topK,
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    }
    const response = await this.#request<RerankTextsResponse>('/v1/rerank', body, input.signal, input.deadlineMs ?? this.#defaultDeadlineMs)
    if (response.protocolVersion !== MODEL_SERVICE_PROTOCOL_VERSION || response.requestId !== requestId
      || response.model !== this.#rerankerModel
      || (this.#rerankerRevision !== undefined && response.revision !== this.#rerankerRevision)
      || response.scoreKind !== 'yes_probability' || !Number.isFinite(response.elapsedMs) || response.elapsedMs < 0
      || !Array.isArray(response.results) || response.results.length !== input.topK) {
      throw new ModelServiceClientError('PROTOCOL_MISMATCH', '重排响应元数据不兼容。', false)
    }
    const ids = new Set(input.candidates.map(candidate => candidate.id))
    const returnedIds = new Set(response.results.map(item => item.id))
    const ranks = new Set(response.results.map(item => item.rank))
    const inputIndexes = new Set(response.results.map(item => item.inputIndex))
    if (returnedIds.size !== response.results.length || ranks.size !== response.results.length
      || inputIndexes.size !== response.results.length
      || response.results.some(item => !ids.has(item.id) || !Number.isFinite(item.score) || item.score < 0 || item.score > 1
        || !Number.isSafeInteger(item.rank) || item.rank < 1 || item.rank > response.results.length
        || !Number.isSafeInteger(item.inputIndex) || item.inputIndex < 0 || item.inputIndex >= input.candidates.length
        || input.candidates[item.inputIndex]?.id !== item.id)) {
      throw new ModelServiceClientError('PROTOCOL_MISMATCH', '重排响应包含无效候选或分数。', false)
    }
    return response.results.map(item => ({ id: item.id, rank: item.rank, score: item.score }))
  }

  async #request<T>(path: string, body: unknown, signal: AbortSignal | undefined, deadlineMs: number): Promise<T> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('deadline exceeded')), deadlineMs)
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const payload = errorPayload(value)
        throw new ModelServiceClientError(payload?.error.code ?? 'HTTP_ERROR', payload?.error.message ?? `模型服务返回 HTTP ${response.status}。`, payload?.error.retryable ?? response.status >= 500, response.status)
      }
      if (object(value) === undefined) throw new ModelServiceClientError('PROTOCOL_MISMATCH', '模型服务返回了无效 JSON。', false)
      return value as T
    } catch (error) {
      if (error instanceof ModelServiceClientError) throw error
      if (controller.signal.aborted) {
        const callerCancelled = signal?.aborted === true
        throw new ModelServiceClientError(callerCancelled ? 'CANCELLED' : 'DEADLINE_EXCEEDED', callerCancelled ? '模型请求已取消。' : '模型请求超过截止时间。', !callerCancelled, undefined, { cause: error })
      }
      throw new ModelServiceClientError('UNAVAILABLE', '无法连接本地模型服务。', true, undefined, { cause: error })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
