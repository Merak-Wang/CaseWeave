import {
  RetrievalError,
  assertTicketRetrievalRequest,
  assertTrustedPrincipal,
  type DetailReadRequest,
  type EvidenceReadRequest,
  type ProviderCallOptions,
  type RetrievalErrorCode,
  type TicketDetailResult,
  type TicketEvidenceResult,
  type TicketProviderStatus,
  type TicketRetrievalProvider,
  type TicketRetrievalRequest,
  type TicketRetrievalSpec,
  type TicketSearchOptions,
  type TicketSearchPage,
  type TicketSnapshot,
  type TicketSnapshotId,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import {
  STREAMCLUSTER_PROTOCOL_VERSION,
  type OpenSnapshotParams,
  type OpenSnapshotResponse,
  type ReadEvidenceParams,
  type ReadEvidenceResponse,
  type ReadProviderStatusParams,
  type ReadProviderStatusResponse,
  type ReadTicketDetailsParams,
  type ReadTicketDetailsResponse,
  type SearchTicketsParams,
  type SearchTicketsResponse,
  type StreamClusterCapabilitiesResponse,
} from './protocol.js'
import {
  assertCapabilities,
  assertProtocol,
  assertSearchPage,
  assertSnapshot,
  type ValidatedStreamClusterCapabilities,
} from './validation.js'

const ERROR_CODES = new Set<RetrievalErrorCode>([
  'INVALID_REQUEST', 'UNAUTHORIZED', 'SNAPSHOT_NOT_FOUND', 'SNAPSHOT_INVALID',
  'CANDIDATE_NOT_FOUND', 'FIELD_NOT_ALLOWED', 'BUDGET_EXHAUSTED',
  'INVALID_TRANSITION', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'CANCELLED',
  'PROTOCOL_MISMATCH', 'EXPORT_LIMIT_EXCEEDED',
])

export interface StreamClusterProviderConfig {
  readonly baseUrl: string
  readonly providerId?: string
  readonly authorization?: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly defaultRequestedCount?: number
  readonly maxRequestedCount?: number
  readonly fetch?: typeof fetch
}

interface ResolvedConfig {
  readonly baseUrl: string
  readonly authorization?: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly defaultRequestedCount: number
  readonly maxRequestedCount: number
  readonly fetch: typeof fetch
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetrievalError('PROTOCOL_MISMATCH', `StreamCluster ${label} 响应格式无效。`)
  }
  return value as Record<string, unknown>
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function assertEvidence(value: unknown, snapshotId: TicketSnapshotId): TicketEvidenceResult {
  const result = object(value, 'evidence') as unknown as TicketEvidenceResult
  if (result.snapshotId !== snapshotId || !Array.isArray(result.evidence)
    || !Array.isArray(result.requestedCandidateRefs) || !Array.isArray(result.rejectedCandidateRefs)
    || !Array.isArray(result.warnings)) {
    throw new RetrievalError('PROTOCOL_MISMATCH', 'StreamCluster 证据响应无效。')
  }
  return result
}

function assertDetails(value: unknown, snapshotId: TicketSnapshotId): TicketDetailResult {
  const result = object(value, 'details') as unknown as TicketDetailResult
  if (result.snapshotId !== snapshotId || !Array.isArray(result.details)
    || !Array.isArray(result.rejectedCandidateRefs) || !Array.isArray(result.warnings)) {
    throw new RetrievalError('PROTOCOL_MISMATCH', 'StreamCluster 详情响应无效。')
  }
  return result
}

function resolveConfig(config: StreamClusterProviderConfig): ResolvedConfig {
  let parsed: URL
  try { parsed = new URL(config.baseUrl) }
  catch (error) { throw new TypeError('StreamCluster baseUrl must be an absolute HTTP(S) URL', { cause: error }) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('StreamCluster baseUrl must be an HTTP(S) origin/path without credentials, query, or hash')
  }
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxResponseBytes = config.maxResponseBytes ?? 2 * 1024 * 1024
  const defaultRequestedCount = config.defaultRequestedCount ?? 5
  const maxRequestedCount = config.maxRequestedCount ?? 20
  for (const [label, value] of Object.entries({ timeoutMs, maxResponseBytes, defaultRequestedCount, maxRequestedCount })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`)
  }
  if (defaultRequestedCount > maxRequestedCount || maxRequestedCount > 100) {
    throw new TypeError('StreamCluster requested-count limits are invalid')
  }
  if (config.authorization !== undefined && (/\r|\n/u.test(config.authorization) || config.authorization.trim().length === 0)) {
    throw new TypeError('StreamCluster authorization must be one non-empty header value')
  }
  return {
    baseUrl: parsed.href.replace(/\/+$/u, ''),
    ...(config.authorization === undefined ? {} : { authorization: config.authorization }),
    timeoutMs,
    maxResponseBytes,
    defaultRequestedCount,
    maxRequestedCount,
    fetch: config.fetch ?? globalThis.fetch,
  }
}

/** Versioned, bounded, read-only client; the remote service remains the authorization authority. */
export class StreamClusterTicketProvider implements TicketRetrievalProvider {
  readonly providerId: string
  readonly #config: ResolvedConfig
  #handshake: Promise<ValidatedStreamClusterCapabilities> | undefined

  constructor(config: StreamClusterProviderConfig) {
    this.#config = resolveConfig(config)
    this.providerId = config.providerId?.trim() || 'streamcluster-v2'
  }

  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec {
    assertTicketRetrievalRequest(request)
    const normalizedQuery = (request.retrievalQuery ?? request.query).normalize('NFKC').trim().replace(/\s+/gu, ' ')
    const requestedCount = request.requestedCount ?? this.#config.defaultRequestedCount
    if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > this.#config.maxRequestedCount) {
      throw new RetrievalError('INVALID_REQUEST', `候选数量必须在 1 到 ${this.#config.maxRequestedCount} 之间。`)
    }
    return {
      target: request.target,
      originalQuery: request.query,
      normalizedQuery,
      ...(request.retrievalIntent === undefined ? {} : { retrievalIntent: request.retrievalIntent }),
      requestedCount,
      countPolicy: request.countPolicy ?? (request.requestedCount === undefined ? 'provider_default' : 'explicit'),
      mode: request.mode ?? 'hybrid',
      filters: [...request.filters ?? []],
      ...(request.fastQuery === undefined ? {} : {
        fastQuery: request.fastQuery,
        keywordQuery: {
          terms: [...request.fastQuery.keyword.terms],
          operator: request.fastQuery.keyword.operator,
        },
        semanticQuery: request.fastQuery.vector.text,
      }),
      ...(request.queryContract?.logic === undefined
        ? {}
        : { requiredConcepts: request.queryContract.logic.requiredConcepts.map(concept => ({ ...concept, alternatives: [...concept.alternatives] })) }),
      ambiguities: [...request.ambiguities ?? []],
      excludedTerms: [],
      semanticHints: [],
      compilerVersion: 'streamcluster-query-v2',
    }
  }

  async openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot> {
    assertTrustedPrincipal(principal)
    const capabilities = await this.#ensureHandshake(options)
    const params: OpenSnapshotParams = {
      protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
      principal,
      ...(options?.traceId === undefined ? {} : { traceId: options.traceId }),
    }
    const response = await this.#post<OpenSnapshotResponse>('/v1/ticket-retrieval/snapshots', params, options)
    assertProtocol(response, 'snapshot envelope')
    return assertSnapshot(response.snapshot, this.providerId, capabilities)
  }

  async search(principal: TrustedPrincipalContext, snapshotId: TicketSnapshotId, query: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
    assertTrustedPrincipal(principal)
    const capabilities = await this.#ensureHandshake(options)
    const params: SearchTicketsParams = {
      protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
      principal,
      snapshotId,
      query,
      options: {
        topK: options.topK,
        maxScan: options.maxScan,
        stage: options.stage,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      },
      ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    }
    const response = await this.#post<SearchTicketsResponse>('/v1/ticket-retrieval/search', params, options)
    assertProtocol(response, 'search envelope')
    return assertSearchPage(response.page, snapshotId, query, options, capabilities)
  }

  async readEvidence(principal: TrustedPrincipalContext, request: EvidenceReadRequest, options?: ProviderCallOptions): Promise<TicketEvidenceResult> {
    assertTrustedPrincipal(principal)
    await this.#ensureHandshake(options)
    const params: ReadEvidenceParams = {
      protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
      principal,
      request,
      ...(options?.traceId === undefined ? {} : { traceId: options.traceId }),
    }
    const response = await this.#post<ReadEvidenceResponse>('/v1/ticket-retrieval/evidence', params, options)
    assertProtocol(response, 'evidence envelope')
    return assertEvidence(response.result, request.snapshotId)
  }

  async readDetails(principal: TrustedPrincipalContext, request: DetailReadRequest, options?: ProviderCallOptions): Promise<TicketDetailResult> {
    assertTrustedPrincipal(principal)
    await this.#ensureHandshake(options)
    const params: ReadTicketDetailsParams = {
      protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
      principal,
      request,
      ...(options?.traceId === undefined ? {} : { traceId: options.traceId }),
    }
    const response = await this.#post<ReadTicketDetailsResponse>('/v1/ticket-retrieval/details', params, options)
    assertProtocol(response, 'details envelope')
    return assertDetails(response.result, request.snapshotId)
  }

  async status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshotId): Promise<TicketProviderStatus> {
    assertTrustedPrincipal(principal)
    await this.#ensureHandshake()
    const params: ReadProviderStatusParams = {
      protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
      principal,
      ...(snapshotId === undefined ? {} : { snapshotId }),
    }
    const response = await this.#post<ReadProviderStatusResponse>('/v1/ticket-retrieval/status', params)
    assertProtocol(response, 'status envelope')
    const status = object(response.status, 'status') as unknown as TicketProviderStatus
    if (status.providerId !== this.providerId || status.readOnly !== true || typeof status.ready !== 'boolean' || !Array.isArray(status.warnings)) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'StreamCluster 状态响应无效。')
    }
    return status
  }

  async #ensureHandshake(options?: ProviderCallOptions): Promise<ValidatedStreamClusterCapabilities> {
    if (this.#handshake === undefined) {
      this.#handshake = this.#request<StreamClusterCapabilitiesResponse>('/v1/ticket-retrieval/capabilities', 'GET', undefined, options)
        .then(response => assertCapabilities(response, this.providerId))
        .catch((error: unknown) => {
          this.#handshake = undefined
          throw error
        })
    }
    return await this.#handshake
  }

  async #post<T>(path: string, body: unknown, options?: ProviderCallOptions): Promise<T> {
    return await this.#request<T>(path, 'POST', body, options)
  }

  async #request<T>(path: string, method: 'GET' | 'POST', body?: unknown, options?: ProviderCallOptions): Promise<T> {
    if (isAborted(options?.signal)) throw new RetrievalError('CANCELLED', 'StreamCluster 请求已取消。')
    const deadline = options?.deadlineMs ?? this.#config.timeoutMs
    if (!Number.isSafeInteger(deadline) || deadline < 1) throw new RetrievalError('INVALID_REQUEST', 'StreamCluster deadline 无效。')
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort() }, Math.min(deadline, this.#config.timeoutMs))
    const signal = options?.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal])
    try {
      const response = await this.#config.fetch(`${this.#config.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.#config.authorization === undefined ? {} : { authorization: this.#config.authorization }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      })
      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > this.#config.maxResponseBytes) {
        throw new RetrievalError('PROTOCOL_MISMATCH', 'StreamCluster 响应超过大小限制。')
      }
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > this.#config.maxResponseBytes) {
        throw new RetrievalError('PROTOCOL_MISMATCH', 'StreamCluster 响应超过大小限制。')
      }
      let payload: unknown
      try { payload = JSON.parse(text) as unknown }
      catch (error) { throw new RetrievalError('PROTOCOL_MISMATCH', 'StreamCluster 返回了无效 JSON。', { cause: error }) }
      if (!response.ok) throw this.#httpError(response.status, payload)
      return payload as T
    } catch (error) {
      if (error instanceof RetrievalError) throw error
      if (isAborted(options?.signal)) throw new RetrievalError('CANCELLED', 'StreamCluster 请求已取消。', { cause: error })
      if (timeout.signal.aborted) throw new RetrievalError('TIMEOUT', 'StreamCluster 请求超时。', { retryable: true, cause: error })
      throw new RetrievalError('PROVIDER_UNAVAILABLE', 'StreamCluster 当前不可用。', { retryable: true, cause: error })
    } finally {
      clearTimeout(timer)
    }
  }

  #httpError(status: number, payload: unknown): RetrievalError {
    const envelope = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined
    const error = envelope?.error !== null && typeof envelope?.error === 'object' && !Array.isArray(envelope.error)
      ? envelope.error as Record<string, unknown>
      : undefined
    if (typeof error?.code === 'string' && ERROR_CODES.has(error.code as RetrievalErrorCode)) {
      const message = typeof error.message === 'string' && error.message.trim().length > 0 && error.message.length <= 500
        ? error.message
        : 'StreamCluster 拒绝了请求。'
      return new RetrievalError(error.code as RetrievalErrorCode, message, { retryable: error.retryable === true })
    }
    if (status === 401 || status === 403) return new RetrievalError('UNAUTHORIZED', 'StreamCluster 未授权当前请求。')
    if (status === 408 || status === 504) return new RetrievalError('TIMEOUT', 'StreamCluster 请求超时。', { retryable: true })
    if (status >= 500) return new RetrievalError('PROVIDER_UNAVAILABLE', 'StreamCluster 当前不可用。', { retryable: true })
    return new RetrievalError('PROTOCOL_MISMATCH', 'StreamCluster 返回了无法识别的错误。')
  }
}
