import {
  RetrievalError,
  TicketCandidateRef,
  TicketSnapshotId,
  type TicketCandidate,
  type TicketFieldDescriptor,
  type TicketFilter,
  type TicketRetrievalSpec,
  type TicketSearchChannelTrace,
  type TicketSearchOptions,
  type TicketSearchPage,
  type TicketSearchTrace,
  type TicketSnapshot,
} from '@retrieval-agent/contracts'
import { STREAMCLUSTER_PROTOCOL_VERSION } from './protocol.js'

export interface ValidatedStreamClusterCapabilities {
  readonly keywordSearch: true
  readonly denseSearch: boolean
  readonly hybridFusion: boolean
  readonly reranking: boolean
  readonly rankingTrace: true
}

const CHANNELS = ['keyword', 'vector', 'reranker'] as const
const FILTER_OPERATORS = ['eq', 'neq', 'gte', 'lte', 'contains'] as const

function mismatch(message: string): never {
  throw new RetrievalError('PROTOCOL_MISMATCH', message)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    mismatch(`StreamCluster ${label} 响应格式无效。`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum = 65_536): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    mismatch(`StreamCluster ${label} 无效。`)
  }
  return value
}

function optionalText(value: unknown, label: string, maximum = 65_536): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) mismatch(`StreamCluster ${label} 无效。`)
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label)
  if (result < 1) mismatch(`StreamCluster ${label} 无效。`)
  return result
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) mismatch(`StreamCluster ${label} 无效。`)
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) mismatch(`StreamCluster ${label} 无效。`)
  return value
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length > 2_048)) {
    mismatch(`StreamCluster ${label} 无效。`)
  }
  return value as string[]
}

function canonicalInstant(value: unknown, label: string): string {
  const result = text(value, label, 128)
  const timestamp = Date.parse(result)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== result) mismatch(`StreamCluster ${label} 无效。`)
  return result
}

export function assertProtocol(value: unknown, label: string): Record<string, unknown> {
  const envelope = object(value, label)
  if (envelope.protocolVersion !== STREAMCLUSTER_PROTOCOL_VERSION) {
    mismatch('StreamCluster 协议版本不兼容。')
  }
  return envelope
}

export function assertCapabilities(value: unknown, providerId: string): ValidatedStreamClusterCapabilities {
  const envelope = assertProtocol(value, 'capabilities envelope')
  if (envelope.providerId !== providerId || envelope.readOnly !== true) {
    mismatch('StreamCluster 只读 Provider 握手失败。')
  }
  const capabilities = object(envelope.capabilities, 'capabilities')
  for (const name of ['snapshot', 'search', 'evidenceRead', 'detailRead', 'status'] as const) {
    if (capabilities[name] !== true) mismatch('StreamCluster 缺少必需的只读能力。')
  }
  if (capabilities.keywordSearch !== true || capabilities.rankingTrace !== true
    || typeof capabilities.denseSearch !== 'boolean'
    || typeof capabilities.hybridFusion !== 'boolean'
    || typeof capabilities.reranking !== 'boolean') {
    mismatch('StreamCluster 检索能力声明不完整。')
  }
  if (capabilities.hybridFusion && !capabilities.denseSearch) {
    mismatch('StreamCluster Hybrid 能力缺少 Dense 检索。')
  }
  return {
    keywordSearch: true,
    denseSearch: capabilities.denseSearch,
    hybridFusion: capabilities.hybridFusion,
    reranking: capabilities.reranking,
    rankingTrace: true,
  }
}

function assertFieldCatalog(value: unknown): readonly TicketFieldDescriptor[] {
  if (!Array.isArray(value)) mismatch('StreamCluster 快照缺少字段目录。')
  const seen = new Set<string>()
  return value.map((item): TicketFieldDescriptor => {
    const field = object(item, 'field catalog item')
    const key = text(field.key, 'fieldCatalog.key', 256)
    const label = text(field.label, 'fieldCatalog.label', 512)
    if (seen.has(key)) mismatch('StreamCluster 字段目录包含重复 key。')
    seen.add(key)
    if (!['keyword', 'datetime', 'text', 'string_list', 'raw_json'].includes(String(field.valueKind))
      || !['L0', 'L1', 'L2', 'L3'].includes(String(field.accessLevel))
      || !['non_sensitive', 'source_controlled'].includes(String(field.sensitivity))
      || !Array.isArray(field.filterOperators)
      || field.filterOperators.some(operator => !FILTER_OPERATORS.includes(operator as typeof FILTER_OPERATORS[number]))
      || new Set(field.filterOperators).size !== field.filterOperators.length) {
      mismatch('StreamCluster 字段目录声明无效。')
    }
    return {
      key,
      label,
      valueKind: field.valueKind as TicketFieldDescriptor['valueKind'],
      accessLevel: (['title', 'summary'].includes(key) && field.accessLevel === 'L2' ? 'L1' : field.accessLevel) as TicketFieldDescriptor['accessLevel'],
      filterOperators: [...field.filterOperators] as TicketFieldDescriptor['filterOperators'],
      sensitivity: field.sensitivity as TicketFieldDescriptor['sensitivity'],
    }
  })
}

export function assertSnapshot(
  value: unknown,
  providerId: string,
  remote: ValidatedStreamClusterCapabilities,
): TicketSnapshot {
  const snapshot = object(value, 'snapshot')
  const snapshotId = text(snapshot.snapshotId, 'snapshotId', 256)
  const shortId = text(snapshot.shortId, 'snapshot shortId', 128)
  if (snapshot.providerId !== providerId) mismatch('StreamCluster Provider 身份不一致。')
  const createdAt = canonicalInstant(snapshot.createdAt, 'snapshot.createdAt')
  const expiresAt = snapshot.expiresAt === undefined ? undefined : canonicalInstant(snapshot.expiresAt, 'snapshot.expiresAt')
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(createdAt)) mismatch('StreamCluster 快照过期时间无效。')
  const capabilities = object(snapshot.capabilities, 'snapshot capabilities')
  for (const name of ['exhaustive', 'pagination', 'evidencePromotion', 'detailRead', 'exportRead', 'denseSearch', 'hybridFusion', 'reranking'] as const) {
    if (typeof capabilities[name] !== 'boolean') mismatch('StreamCluster 快照能力声明无效。')
  }
  if (capabilities.keywordSearch !== true || (capabilities.hybridFusion && !capabilities.denseSearch)) {
    mismatch('StreamCluster 快照检索能力声明无效。')
  }
  for (const name of ['denseSearch', 'hybridFusion', 'reranking'] as const) {
    if (capabilities[name] === true && remote[name] !== true) mismatch('StreamCluster 快照能力超出握手声明。')
  }
  return {
    snapshotId: TicketSnapshotId(snapshotId),
    shortId,
    providerId,
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    sourceVersion: text(snapshot.sourceVersion, 'snapshot.sourceVersion', 512),
    indexVersion: text(snapshot.indexVersion, 'snapshot.indexVersion', 512),
    retrievalProfileVersion: text(snapshot.retrievalProfileVersion, 'snapshot.retrievalProfileVersion', 512),
    authorizationVersion: text(snapshot.authorizationVersion, 'snapshot.authorizationVersion', 512),
    principalBindingHash: text(snapshot.principalBindingHash, 'snapshot.principalBindingHash', 512),
    queryPolicyVersion: text(snapshot.queryPolicyVersion, 'snapshot.queryPolicyVersion', 512),
    fieldCatalog: assertFieldCatalog(snapshot.fieldCatalog),
    capabilities: {
      exhaustive: capabilities.exhaustive as boolean,
      pagination: capabilities.pagination as boolean,
      evidencePromotion: capabilities.evidencePromotion as boolean,
      detailRead: capabilities.detailRead as boolean,
      exportRead: capabilities.exportRead as boolean,
      keywordSearch: true,
      denseSearch: capabilities.denseSearch as boolean,
      hybridFusion: capabilities.hybridFusion as boolean,
      reranking: capabilities.reranking as boolean,
    },
  }
}

function assertCandidate(value: unknown, snapshotId: TicketSnapshotId): TicketCandidate {
  const candidate = object(value, 'candidate')
  if (candidate.snapshotId !== snapshotId || !['L1', 'L2'].includes(String(candidate.evidenceLevel))) mismatch('StreamCluster 候选身份无效。')
  const l0 = object(candidate.l0, 'candidate.l0')
  for (const name of ['createdAt', 'updatedAt', 'resolvedAt', 'type', 'category', 'product', 'component', 'region', 'status', 'priority', 'language'] as const) {
    optionalText(l0[name], `candidate.l0.${name}`, 2_048)
  }
  if (l0.additionalFields !== undefined) {
    if (!Array.isArray(l0.additionalFields)) mismatch('StreamCluster 候选附加字段无效。')
    const keys = new Set<string>()
    for (const item of l0.additionalFields) {
      const field = object(item, 'candidate additional field')
      const key = text(field.key, 'candidate additional field key', 256)
      if (keys.has(key)) mismatch('StreamCluster 候选附加字段包含重复 key。')
      keys.add(key)
      text(field.label, 'candidate additional field label', 512)
      text(field.value, 'candidate additional field value')
      text(field.sourcePath, 'candidate additional field sourcePath', 2_048)
    }
  }
  if (!Array.isArray(candidate.matchFragments)) mismatch('StreamCluster 候选命中片段无效。')
  for (const item of candidate.matchFragments) {
    const fragment = object(item, 'candidate match fragment')
    if (!['title', 'summary'].includes(String(fragment.field)) || typeof fragment.truncated !== 'boolean') {
      mismatch('StreamCluster 候选命中片段无效。')
    }
    text(fragment.text, 'candidate match fragment text')
  }
  text(candidate.ref, 'candidate.ref', 512)
  text(candidate.displayId, 'candidate.displayId', 512)
  text(candidate.sourceVersion, 'candidate.sourceVersion', 512)
  text(candidate.contentHash, 'candidate.contentHash', 512)
  text(candidate.title, 'candidate.title')
  text(candidate.summary, 'candidate.summary')
  positiveInteger(candidate.rank, 'candidate.rank')
  // The search endpoint authorizes title/summary, not arbitrary source payload keys.
  const safeL0 = Object.fromEntries(['createdAt', 'updatedAt', 'resolvedAt', 'type', 'category', 'product', 'component', 'region', 'status', 'priority', 'language']
    .filter(key => l0[key] !== undefined).map(key => [key, l0[key]]))
  if (Array.isArray(l0.additionalFields)) safeL0.additionalFields = l0.additionalFields.map(item => {
    const field = item as Record<string, unknown>
    return { key: field.key, label: field.label, value: field.value, sourcePath: field.sourcePath }
  })
  return {
    ref: candidate.ref, displayId: candidate.displayId, sourceVersion: candidate.sourceVersion,
    snapshotId, contentHash: candidate.contentHash, evidenceLevel: 'L1', rank: candidate.rank,
    title: candidate.title, summary: candidate.summary, l0: safeL0,
    matchFragments: candidate.matchFragments.map(item => {
      const fragment = item as Record<string, unknown>
      return { field: fragment.field, text: fragment.text, truncated: fragment.truncated }
    }),
  } as unknown as TicketCandidate
}

function assertAppliedFilters(value: unknown, expected: readonly TicketFilter[]): readonly TicketFilter[] {
  if (!Array.isArray(value) || value.length !== expected.length) mismatch('StreamCluster 已应用筛选条件无效。')
  return value.map((item, index): TicketFilter => {
    const filter = object(item, 'applied filter')
    const expectedFilter = expected[index]
    if (expectedFilter === undefined || filter.op !== expectedFilter.op || filter.field !== expectedFilter.field || filter.value !== expectedFilter.value) {
      mismatch('StreamCluster 已应用筛选条件与请求不一致。')
    }
    return { ...expectedFilter }
  })
}

function assertChannel(value: unknown): TicketSearchChannelTrace {
  const channel = object(value, 'ranking trace channel')
  if (!CHANNELS.includes(channel.channel as typeof CHANNELS[number])) mismatch('StreamCluster 排名通道无效。')
  const result: TicketSearchChannelTrace = {
    channel: channel.channel as TicketSearchChannelTrace['channel'],
    implementation: text(channel.implementation, 'ranking channel implementation', 512),
    version: text(channel.version, 'ranking channel version', 512),
    resultCount: nonNegativeInteger(channel.resultCount, 'ranking channel resultCount'),
    elapsedMs: nonNegativeFinite(channel.elapsedMs, 'ranking channel elapsedMs'),
    ...(channel.model === undefined ? {} : { model: text(channel.model, 'ranking channel model', 1_024) }),
    ...(channel.revision === undefined ? {} : { revision: text(channel.revision, 'ranking channel revision', 1_024) }),
    ...(channel.dimensions === undefined ? {} : { dimensions: positiveInteger(channel.dimensions, 'ranking channel dimensions') }),
    ...(channel.querySource === undefined ? {} : {
      querySource: text(channel.querySource, 'ranking channel querySource', 64) as Exclude<TicketSearchChannelTrace['querySource'], undefined>,
    }),
  }
  if (result.querySource !== undefined && !['direct_user_original', 'direct_user_keywords', 'agent_rewrite'].includes(result.querySource)) {
    mismatch('StreamCluster 排名通道查询来源无效。')
  }
  if ((result.channel === 'vector' || result.channel === 'reranker') && (result.model === undefined || result.revision === undefined)) {
    mismatch('StreamCluster 模型排名通道缺少模型身份。')
  }
  if (result.channel === 'vector' && result.dimensions === undefined) mismatch('StreamCluster 向量排名通道缺少维度。')
  return result
}

function assertTrace(
  value: unknown,
  query: TicketRetrievalSpec,
  stage: TicketSearchOptions['stage'],
  candidates: readonly TicketCandidate[],
  remote: ValidatedStreamClusterCapabilities,
): TicketSearchTrace {
  const trace = object(value, 'ranking trace')
  if (trace.stage !== stage || trace.requestedMode !== query.mode) mismatch('StreamCluster 排名 trace 与搜索阶段或模式不一致。')
  if (!['keyword', 'dense', 'hybrid', 'keyword_fallback'].includes(String(trace.executedMode))) mismatch('StreamCluster 执行检索模式无效。')
  if ((query.mode === 'keyword' && trace.executedMode !== 'keyword')
    || (query.mode === 'dense' && trace.executedMode !== 'dense')
    || (query.mode === 'hybrid' && !['hybrid', 'keyword_fallback', 'dense'].includes(String(trace.executedMode)))) {
    mismatch('StreamCluster 执行检索模式与请求不一致。')
  }
  text(trace.strategyVersion, 'ranking strategy version', 512)
  if (!Array.isArray(trace.channels) || trace.channels.length === 0) mismatch('StreamCluster 排名 trace 缺少通道。')
  const channels = trace.channels.map(assertChannel)
  const channelNames = new Set(channels.map(channel => channel.channel))
  if (channelNames.size !== channels.length) mismatch('StreamCluster 排名 trace 通道声明无效。')
  if ((trace.executedMode === 'keyword' || trace.executedMode === 'keyword_fallback' || trace.executedMode === 'hybrid')
    && !channelNames.has('keyword')) mismatch('StreamCluster 词面或 Hybrid trace 缺少关键词通道。')
  const attemptedKeyword = channels.find(channel => channel.channel === 'keyword')
  if (trace.executedMode === 'dense' && channelNames.has('keyword')
    && (query.mode !== 'hybrid' || attemptedKeyword?.resultCount !== 0)) {
    mismatch('StreamCluster Dense trace 包含产生候选的关键词通道。')
  }
  if (trace.executedMode === 'hybrid' && !channelNames.has('vector')) mismatch('StreamCluster Hybrid trace 缺少向量通道。')
  if (trace.executedMode === 'dense' && !channelNames.has('vector')) mismatch('StreamCluster Dense trace 缺少向量通道。')
  if (trace.executedMode === 'keyword' && channelNames.has('vector')) mismatch('StreamCluster Keyword trace 包含向量通道。')
  if ((channelNames.has('vector') && !remote.denseSearch)
    || (trace.executedMode === 'hybrid' && !remote.hybridFusion)
    || (channelNames.has('reranker') && !remote.reranking)) {
    mismatch('StreamCluster 排名 trace 超出握手能力。')
  }

  const fusion = trace.fusion === undefined ? undefined : object(trace.fusion, 'fusion trace')
  if ((trace.executedMode === 'hybrid') !== (fusion !== undefined)) mismatch('StreamCluster 融合 trace 与执行模式不一致。')
  if (fusion !== undefined) {
    if (fusion.method !== 'weighted_rrf') mismatch('StreamCluster 融合方法无效。')
    text(fusion.version, 'fusion version', 512)
    positiveInteger(fusion.rankConstant, 'fusion rankConstant')
    const keywordWeight = nonNegativeFinite(fusion.keywordWeight, 'fusion keywordWeight')
    const vectorWeight = nonNegativeFinite(fusion.vectorWeight, 'fusion vectorWeight')
    if (keywordWeight > 1 || vectorWeight > 1 || keywordWeight === 0 || vectorWeight === 0) mismatch('StreamCluster 融合权重无效。')
  }

  const reranker = trace.reranker === undefined ? undefined : object(trace.reranker, 'reranker trace')
  if ((reranker !== undefined) !== channelNames.has('reranker')) mismatch('StreamCluster Reranker trace 声明不一致。')
  if (reranker !== undefined) {
    text(reranker.model, 'reranker model', 1_024)
    text(reranker.revision, 'reranker revision', 1_024)
    positiveInteger(reranker.topN, 'reranker topN')
    if (reranker.scoreKind !== 'yes_probability') mismatch('StreamCluster Reranker 分数类型无效。')
  }

  if (!Array.isArray(trace.signals) || trace.signals.length !== candidates.length) mismatch('StreamCluster 排名 signal 数量无效。')
  const candidateByRef = new Map(candidates.map(candidate => [candidate.ref as string, candidate]))
  const seenRefs = new Set<string>()
  const seenRanks = new Set<number>()
  const signals = trace.signals.map((item): TicketSearchTrace['signals'][number] => {
    const signal = object(item, 'ranking signal')
    const ref = text(signal.candidateRef, 'ranking signal candidateRef', 512)
    const candidate = candidateByRef.get(ref)
    const finalRank = positiveInteger(signal.finalRank, 'ranking signal finalRank')
    if (candidate === undefined || candidate.rank !== finalRank || seenRefs.has(ref) || seenRanks.has(finalRank)) {
      mismatch('StreamCluster 排名 signal 候选身份无效。')
    }
    seenRefs.add(ref)
    seenRanks.add(finalRank)
    if (!Array.isArray(signal.channels) || signal.channels.length === 0) mismatch('StreamCluster 排名 signal 缺少通道分数。')
    const seenSignalChannels = new Set<string>()
    const scores = signal.channels.map((item): TicketSearchTrace['signals'][number]['channels'][number] => {
      const score = object(item, 'ranking signal channel')
      if (!CHANNELS.includes(score.channel as typeof CHANNELS[number]) || !channelNames.has(score.channel as typeof CHANNELS[number])
        || seenSignalChannels.has(String(score.channel))) mismatch('StreamCluster 排名 signal 通道无效。')
      seenSignalChannels.add(String(score.channel))
      return {
        channel: score.channel as typeof CHANNELS[number],
        rank: positiveInteger(score.rank, 'ranking signal channel rank'),
        score: finite(score.score, 'ranking signal channel score'),
      }
    })
    return { candidateRef: TicketCandidateRef(ref), finalRank, fusedScore: finite(signal.fusedScore, 'ranking signal fusedScore'), channels: scores }
  })
  return {
    stage,
    requestedMode: query.mode,
    executedMode: trace.executedMode as TicketSearchTrace['executedMode'],
    strategyVersion: trace.strategyVersion as string,
    channels,
    ...(fusion === undefined ? {} : { fusion: fusion as unknown as NonNullable<TicketSearchTrace['fusion']> }),
    ...(reranker === undefined ? {} : { reranker: reranker as unknown as NonNullable<TicketSearchTrace['reranker']> }),
    signals,
  }
}

export function assertSearchPage(
  value: unknown,
  snapshotId: TicketSnapshotId,
  query: TicketRetrievalSpec,
  options: Pick<TicketSearchOptions, 'topK' | 'maxScan' | 'stage'>,
  remote: ValidatedStreamClusterCapabilities,
): TicketSearchPage {
  const page = object(value, 'search page')
  if (page.snapshotId !== snapshotId || !Array.isArray(page.candidates)) mismatch('StreamCluster 搜索响应改变了快照或候选集合。')
  const candidates = page.candidates.map(candidate => assertCandidate(candidate, snapshotId))
  if (new Set(candidates.map(candidate => candidate.ref)).size !== candidates.length
    || new Set(candidates.map(candidate => candidate.rank)).size !== candidates.length
    || candidates.some((candidate, index) => index > 0 && candidate.rank <= candidates[index - 1]!.rank)) {
    mismatch('StreamCluster 候选顺序或身份无效。')
  }
  const scanned = nonNegativeInteger(page.scanned, 'search scanned')
  const returned = nonNegativeInteger(page.returned, 'search returned')
  if (returned !== candidates.length || returned > options.topK || returned > scanned || scanned > options.maxScan) {
    mismatch('StreamCluster 搜索计量字段不一致。')
  }
  if (!['exhaustive', 'bounded', 'unknown'].includes(String(page.completeness))) mismatch('StreamCluster 搜索完整性无效。')
  const nextCursor = optionalText(page.nextCursor, 'search nextCursor', 8_192)
  const appliedFilters = assertAppliedFilters(page.appliedFilters, query.filters)
  const warnings = stringArray(page.warnings, 'search warnings')
  const trace = assertTrace(page.trace, query, options.stage, candidates, remote)
  const boundaryValue = object(page.boundary, 'search boundary')
  if (typeof boundaryValue.resultPagesExhausted !== 'boolean' || typeof boundaryValue.semanticRecallKnown !== 'boolean') {
    mismatch('StreamCluster 搜索边界观测无效。')
  }
  const boundary: TicketSearchPage['boundary'] = {
    authorizedCorpusSize: nonNegativeInteger(boundaryValue.authorizedCorpusSize, 'boundary authorizedCorpusSize'),
    documentsAfterStructuredFilters: nonNegativeInteger(boundaryValue.documentsAfterStructuredFilters, 'boundary documentsAfterStructuredFilters'),
    documentsEligibleForKeywordChannel: nonNegativeInteger(boundaryValue.documentsEligibleForKeywordChannel, 'boundary documentsEligibleForKeywordChannel'),
    rankedHits: nonNegativeInteger(boundaryValue.rankedHits, 'boundary rankedHits'),
    resultPagesExhausted: boundaryValue.resultPagesExhausted,
    semanticRecallKnown: boundaryValue.semanticRecallKnown,
  }
  if (boundary.documentsAfterStructuredFilters > boundary.authorizedCorpusSize
    || boundary.documentsEligibleForKeywordChannel > boundary.documentsAfterStructuredFilters
    || boundary.rankedHits > boundary.documentsAfterStructuredFilters
    || boundary.resultPagesExhausted !== (nextCursor === undefined)) {
    mismatch('StreamCluster 搜索边界观测无效。')
  }
  return {
    snapshotId,
    queryFingerprint: text(page.queryFingerprint, 'search queryFingerprint', 512),
    candidates,
    completeness: page.completeness as TicketSearchPage['completeness'],
    ...(nextCursor === undefined ? {} : { nextCursor }),
    scanned,
    returned,
    elapsedMs: nonNegativeFinite(page.elapsedMs, 'search elapsedMs'),
    appliedFilters,
    warnings,
    trace,
    boundary,
  }
}
