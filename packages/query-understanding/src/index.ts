import { randomUUID } from 'node:crypto'
import type {
  TicketFastQueryPlan,
  TicketQueryContract,
  TicketQueryEntity,
  TicketQueryLogic,
  TicketRetrievalRequest,
} from '@retrieval-agent/contracts'
import {
  QUERY_ANALYSIS_PROTOCOL_VERSION,
  type QueryAnalysisParams,
  type QueryAnalysisResponse,
} from './protocol.js'

export * from './protocol.js'

const ASSEMBLER_VERSION = 'spacy-fast-query-v3'

/** 查询分析端口：业务装配依赖这个接口，不依赖某个具体 HTTP 客户端，便于替换 Provider 和做契约测试。 */
export interface TicketQueryAnalyzer {
  analyze(query: string, signal?: AbortSignal): Promise<QueryAnalysisResponse>
}

export interface SpacyQueryAnalyzerOptions {
  readonly baseUrl: string
  readonly deadlineMs?: number
  readonly fetch?: typeof globalThis.fetch
}

/** 将跨进程失败统一为稳定错误码，避免调用方解析网络库或 FastAPI 的原始异常文本。 */
export class QueryAnalysisClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'QueryAnalysisClientError'
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function nonEmptyString(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function validOffset(start: unknown, end: unknown, query: string): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number(start) >= 0
    && Number(end) > Number(start) && Number(end) <= query.length
}

/**
 * 在 FastAPI 返回值进入检索状态前完成封闭校验。
 * 这里不仅检查 JSON 形状，还检查版本、请求关联、数量上限和所有原文边界，防止上游返回改写词或越界 provenance。
 */
function validResponse(value: unknown, requestId: string, query: string): value is QueryAnalysisResponse {
  const response = object(value)
  const analyzer = object(response?.analyzer)
  // 第一层检查响应身份、分析器身份和集合规模，先拒绝版本漂移或异常放大的载荷。
  if (response?.protocolVersion !== QUERY_ANALYSIS_PROTOCOL_VERSION || response.requestId !== requestId
    || analyzer?.engine !== 'spacy' || analyzer.loaded !== true
    || ![analyzer.engineVersion, analyzer.pipeline, analyzer.pipelineVersion, analyzer.lexiconVersion]
      .every(item => nonEmptyString(item))
    || !Array.isArray(analyzer.components) || !analyzer.components.every(item => nonEmptyString(item, 100))
    || !nonEmptyString(response.language, 20) || !Number.isFinite(response.elapsedMs) || Number(response.elapsedMs) < 0
    || !Array.isArray(response.keywords) || response.keywords.length > 8
    || !response.keywords.every(term => nonEmptyString(term) && query.includes(term))
    || new Set(response.keywords).size !== response.keywords.length
    || !Array.isArray(response.candidates) || response.candidates.length > 32
    || !Array.isArray(response.tokens) || response.tokens.length > 64
    || !Array.isArray(response.entities) || response.entities.length > 32
    || !Array.isArray(response.triples) || response.triples.length > 8) return false

  if (response.requestedCount !== undefined
    && (typeof response.requestedCount !== 'number' || !Number.isSafeInteger(response.requestedCount)
      || response.requestedCount < 1 || response.requestedCount > 50)) {
    return false
  }
  // 候选词必须是原始 query 的连续表面片段；领域词典只能合并原文，不能在首轮生成同义词。
  for (const raw of response.candidates) {
    const item = object(raw)
    if (!nonEmptyString(item?.text) || !query.includes(item.text) || !validOffset(item.start, item.end, query)
      || !['domain_lexicon', 'pos'].includes(String(item.source)) || !Array.isArray(item.pos)
      || item.pos.length < 1 || !item.pos.every(pos => nonEmptyString(pos, 50))) return false
  }
  // token 的 head 使用当前 token 数组下标，越界会让依存关系无法重放，因此在边界处直接拒绝。
  for (const raw of response.tokens) {
    const item = object(raw)
    if (!nonEmptyString(item?.text) || !validOffset(item.start, item.end, query) || typeof item.lemma !== 'string'
      || !nonEmptyString(item.pos, 50) || !nonEmptyString(item.tag, 50) || !nonEmptyString(item.dep, 100)
      || !Number.isSafeInteger(item.head) || Number(item.head) < 0 || Number(item.head) >= response.tokens.length
      || typeof item.isStop !== 'boolean' || typeof item.entityType !== 'string') return false
  }
  for (const raw of response.entities) {
    const item = object(raw)
    if (!nonEmptyString(item?.text) || !nonEmptyString(item.label, 100)
      || !validOffset(item.start, item.end, query)) return false
  }
  for (const raw of response.triples) {
    const item = object(raw)
    if (!nonEmptyString(item?.subject) || !nonEmptyString(item.predicate) || !nonEmptyString(item.object)
      || !['dependency', 'coordination'].includes(String(item.source))) return false
  }
  if (response.boolean !== undefined) {
    const relation = object(response.boolean)
    const keywords = response.keywords as readonly string[]
    // 布尔关系只能引用本次已验证的关键词，不能偷偷扩大首轮关键词集合。
    if (relation === undefined || !['and', 'or'].includes(String(relation.operator))
      || !['single_set', 'separate_sets'].includes(String(relation.grouping))
      || !Array.isArray(relation.terms) || relation.terms.length < 2 || relation.terms.length > 8
      || !relation.terms.every(term => nonEmptyString(term) && keywords.includes(term))) return false
  }
  return true
}

/** 常驻 spaCy/FastAPI 查询分析客户端；每次查询只发 HTTP 请求，不临时启动 Python 进程。 */
export class SpacyQueryAnalyzer implements TicketQueryAnalyzer {
  readonly #baseUrl: string
  readonly #deadlineMs: number
  readonly #fetch: typeof globalThis.fetch

  constructor(options: SpacyQueryAnalyzerOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.#deadlineMs = options.deadlineMs ?? 5_000
    this.#fetch = options.fetch ?? globalThis.fetch
    if (!/^https?:\/\//u.test(this.#baseUrl)) throw new TypeError('query analysis baseUrl must use http or https')
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs < 100) {
      throw new TypeError('query analysis deadlineMs must be at least 100ms')
    }
  }

  async analyze(query: string, signal?: AbortSignal): Promise<QueryAnalysisResponse> {
    if (query.trim().length === 0 || query.length > 2_000) throw new TypeError('query must contain 1-2000 characters')
    // requestId 同时写入请求和响应，用于防止连接复用或错误代理返回了另一请求的分析结果。
    const requestId = randomUUID()
    const body: QueryAnalysisParams = { protocolVersion: QUERY_ANALYSIS_PROTOCOL_VERSION, requestId, query }
    // 同一个 AbortController 合并调用方取消和本地 deadline；catch 中再区分两种停止原因。
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('deadline exceeded')), this.#deadlineMs)
    try {
      const response = await this.#fetch(`${this.#baseUrl}/v1/query-analysis`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        // FastAPI 的结构化错误优先透传；非结构化错误收敛成稳定的 HTTP_ERROR。
        const error = object(object(value)?.error)
        throw new QueryAnalysisClientError(
          typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
          typeof error?.message === 'string' ? error.message : `spaCy 服务返回 HTTP ${response.status}。`,
          typeof error?.retryable === 'boolean' ? error.retryable : response.status >= 500,
          response.status,
        )
      }
      if (!validResponse(value, requestId, query)) {
        throw new QueryAnalysisClientError('PROTOCOL_MISMATCH', 'spaCy 查询分析响应无效。', false)
      }
      return value
    } catch (error) {
      if (error instanceof QueryAnalysisClientError) throw error
      const callerCancelled = signal?.aborted === true
      if (controller.signal.aborted) {
        // 用户主动取消不可重试；本地超时可能由暂时负载导致，允许上层按预算决定是否重试。
        throw new QueryAnalysisClientError(
          callerCancelled ? 'CANCELLED' : 'DEADLINE_EXCEEDED',
          callerCancelled ? 'spaCy 查询分析已取消。' : 'spaCy 查询分析超过截止时间。',
          !callerCancelled,
          undefined,
          { cause: error },
        )
      }
      throw new QueryAnalysisClientError('UNAVAILABLE', '无法连接 spaCy 查询分析服务。', true, undefined, { cause: error })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export interface FastTicketRequestOptions {
  readonly analyzer: TicketQueryAnalyzer
  readonly signal?: AbortSignal
}

function language(value: string): TicketQueryContract['language'] {
  if (value.toLowerCase().startsWith('zh')) return 'zh'
  if (value.toLowerCase().startsWith('en')) return 'en'
  return 'und'
}

/** 把 spaCy 关键词投影为 Query Contract 的 topic 实体，同时按 NFKC 规范值去重。 */
function keywordEntities(keywords: readonly string[]): TicketQueryEntity[] {
  const seen = new Set<string>()
  return keywords.flatMap((surface): TicketQueryEntity[] => {
    const canonical = surface.normalize('NFKC')
    if (seen.has(canonical)) return []
    seen.add(canonical)
    return [{ type: 'topic', surface, canonical }]
  })
}

/** 只有 spaCy 明确识别出连接词时才写入显式逻辑；这里不猜测新的左右项。 */
function explicitLogic(analysis: QueryAnalysisResponse): TicketQueryLogic | undefined {
  if (analysis.boolean === undefined) return undefined
  return {
    operator: analysis.boolean.operator,
    requiredConcepts: analysis.boolean.terms.map(surface => ({
      surface,
      canonical: surface.normalize('NFKC'),
      alternatives: [surface],
    })),
    grouping: analysis.boolean.grouping,
  }
}

/** Task classification is independent from quantity and result-set completion policy. */
function taskTarget(query: string): TicketRetrievalRequest['target'] {
  const normalized = query.normalize('NFKC').toLowerCase()
  if (/(?:如何|怎么|怎样).{0,16}(?:处理|解决|处置)|(?:处理|解决|处置)(?:方法|方案|路径|流程)|\bhow\s+to\b/u.test(normalized)) {
    return 'resolution_path'
  }
  if (/(?:列出|列表|清单|汇总|集合|统计)|\b(?:list|inventory|summary)\b/u.test(normalized)) {
    return 'cohort_collection'
  }
  return 'ranked_cases'
}

/** Exhaustive collection requires explicit language; omission of a number remains adaptive. */
function resultCountPolicy(query: string, requestedCount: number | undefined): NonNullable<TicketRetrievalRequest['countPolicy']> {
  if (requestedCount !== undefined) return 'explicit'
  const normalized = query.normalize('NFKC').toLowerCase()
  return /(?:全部|所有|全量|一个不漏|每(?:一)?(?:条|个)工单|完整(?:地)?(?:列出|返回|查找|检索))|\b(?:all|every)\b/u.test(normalized)
    ? 'exhaustive'
    : 'adaptive'
}

/**
 * 用已经校验的 NLP 结果装配固定首轮快查询。
 *
 * 流程：原始 query 交给 spaCy → 原文关键词进入关键词通道 → 完整原始 query 进入向量通道 → 两路计划和 NLP
 * provenance 一起写入 Query Contract。该函数不做同义词扩展，也不让 Agent 在首轮前改写 query。
 */
export async function buildFastTicketRequest(
  rawQuery: string,
  config: FastTicketRequestOptions,
): Promise<TicketRetrievalRequest> {
  if (rawQuery.trim().length === 0 || rawQuery.length > 2_000) {
    throw new TypeError('rawQuery must contain 1-2000 characters')
  }
  // NLP 只执行一次，后续所有字段都从同一份版本化分析结果派生，保证事件可重放。
  const analysis = await config.analyzer.analyze(rawQuery, config.signal)
  const keywordTerms = [...analysis.keywords]
  const queryLogic = explicitLogic(analysis)
  // 未识别到显式 OR 时按 AND 查找包含全部关键词的工单；向量文本始终逐字保留用户输入。
  const fastQuery: TicketFastQueryPlan = {
    schemaVersion: 2,
    source: 'direct_user',
    rewriteApplied: false,
    ...(keywordTerms.length === 0 ? {} : { keyword: {
      terms: keywordTerms,
      operator: analysis.boolean?.operator ?? 'and',
    } }),
    vector: { text: rawQuery },
  }
  const requestedCount = analysis.requestedCount
  const target = taskTarget(rawQuery)
  const countPolicy = resultCountPolicy(rawQuery, requestedCount)
  // normalized 只用于契约比较和通用检索视图，不替代 fastQuery.vector.text 中的原始 query。
  const normalized = rawQuery.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  const analyzerVersion = [
    analysis.analyzer.engine,
    analysis.analyzer.engineVersion,
    analysis.analyzer.pipeline,
    analysis.analyzer.pipelineVersion,
    analysis.analyzer.lexiconVersion,
  ].join(':')
  const queryContract: TicketQueryContract = {
    schemaVersion: 7,
    original: rawQuery,
    normalized,
    task: target,
    resultPolicy: countPolicy === 'explicit'
      ? 'explicit_top_k'
      : countPolicy === 'exhaustive' ? 'exhaustive_current_snapshot' : 'adaptive_top_k',
    ...(requestedCount === undefined ? {} : { resultLimit: requestedCount }),
    domain: 'telecom_ticket',
    language: language(analysis.language),
    entities: keywordEntities(keywordTerms),
    constraints: [],
    ...(queryLogic === undefined ? {} : { logic: queryLogic }),
    fastQuery,
    // 保存完整 spaCy provenance，后续可以解释关键词来自哪个 token、词性、依存关系和词典版本。
    nlp: {
      schemaVersion: 2,
      engine: 'spacy',
      engineVersion: analysis.analyzer.engineVersion,
      pipeline: analysis.analyzer.pipeline,
      pipelineVersion: analysis.analyzer.pipelineVersion,
      lexiconVersion: analysis.analyzer.lexiconVersion,
      keywordTerms,
      tokens: analysis.tokens.map(token => ({
        surface: token.text,
        start: token.start,
        end: token.end,
        lemma: token.lemma,
        pos: token.pos,
        tag: token.tag,
        dep: token.dep,
        head: token.head,
        isStop: token.isStop,
        entityType: token.entityType,
      })),
      entities: analysis.entities.map(entity => ({
        surface: entity.text,
        label: entity.label,
        start: entity.start,
        end: entity.end,
      })),
      triples: analysis.triples.map(triple => ({ ...triple })),
    },
    ambiguities: [],
    interpretationBasis: 'deterministic_syntax',
    compilerVersion: `${ASSEMBLER_VERSION}:${analyzerVersion}`,
  }
  return {
    target,
    query: rawQuery,
    retrievalQuery: normalized,
    ...(requestedCount === undefined ? {} : { requestedCount }),
    countPolicy,
    fastQuery,
    queryContract,
  }
}
