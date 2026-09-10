/** TypeScript 与常驻 Python/FastAPI 查询分析服务共同遵守的线协议版本。 */
export const QUERY_ANALYSIS_PROTOCOL_VERSION = 'retrieval-agent.models.v1' as const

/** 记录实际加载的 spaCy 引擎、中文管线和领域词典版本，供健康检查和事件重放使用。 */
export interface SpacyAnalyzerDescriptorResponse {
  readonly engine: 'spacy'
  readonly engineVersion: string
  readonly pipeline: string
  readonly pipelineVersion: string
  readonly lexiconVersion: string
  readonly loaded: true
  readonly components: readonly string[]
}

/** 单个 spaCy token 的表面位置、词性和依存信息；start/end 为 UTF-16 偏移，head 是当前 tokens 数组中的下标。 */
export interface SpacyTokenResponse {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly lemma: string
  readonly pos: string
  readonly tag: string
  readonly dep: string
  readonly head: number
  readonly isStop: boolean
  readonly entityType: string
}

/** 可进入关键词通道的原文候选；start/end 为 UTF-16 偏移，source 区分领域短语合并和普通 POS 提取。 */
export interface SpacyCandidateResponse {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly source: 'domain_lexicon' | 'pos'
  readonly pos: readonly string[]
}

/** 实体来源 start/end 为原查询中的 UTF-16 偏移，与 JavaScript slice 一致。 */
export interface SpacyEntityResponse {
  readonly text: string
  readonly label: string
  readonly start: number
  readonly end: number
}

export interface SpacyTripleResponse {
  readonly subject: string
  readonly predicate: string
  readonly object: string
  readonly source: 'dependency' | 'coordination'
}

export interface QueryAnalysisParams {
  readonly protocolVersion: typeof QUERY_ANALYSIS_PROTOCOL_VERSION
  readonly requestId: string
  readonly query: string
}

/**
 * 一次查询分析的完整响应。
 * keywords 是首轮关键词通道的唯一输入；空数组表示跳过关键词通道并保留原始 query 的向量首检。
 * tokens/entities/triples 是解释与重放证据，不允许 TypeScript 再发明关键词。
 */
export interface QueryAnalysisResponse {
  readonly protocolVersion: typeof QUERY_ANALYSIS_PROTOCOL_VERSION
  readonly requestId: string
  readonly analyzer: SpacyAnalyzerDescriptorResponse
  readonly language: string
  readonly keywords: readonly string[]
  readonly candidates: readonly SpacyCandidateResponse[]
  readonly tokens: readonly SpacyTokenResponse[]
  readonly entities: readonly SpacyEntityResponse[]
  readonly triples: readonly SpacyTripleResponse[]
  readonly boolean?: {
    readonly operator: 'and' | 'or'
    readonly terms: readonly string[]
    readonly grouping: 'single_set' | 'separate_sets'
  }
  readonly elapsedMs: number
}
