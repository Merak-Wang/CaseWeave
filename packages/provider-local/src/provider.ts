import { performance } from 'node:perf_hooks'
import {
  RetrievalError,
  isReadableTicketField,
  evaluateQuery,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketSnapshotId,
  assertTicketRetrievalRequest,
  assertTrustedPrincipal,
  type DetailReadRequest,
  type EvidenceReadRequest,
  type NormalizedTicketRecord,
  type ProviderCallOptions,
  type TicketCandidate,
  type TicketDetail,
  type TicketDetailResult,
  type TicketEvidenceField,
  type TicketEvidenceResult,
  type TicketFieldDescriptor,
  type TicketFilter,
  type TicketProviderStatus,
  type TicketRetrievalProvider,
  type TicketRetrievalRequest,
  type TicketRetrievalSpec,
  type TicketSearchOptions,
  type TicketSearchPage,
  type TicketSnapshot,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import {
  HybridRankingEngine,
  RankingError,
  type RankingResult,
  type RetrievalRanker,
} from '@retrieval-agent/model-service-client/ranking'
import { sha256, shortOpaque, stableJson } from './hash.js'
import { canRead, principalBinding } from './authorization.js'
import { evidenceFieldValues, LEGACY_FIELD_CATALOG } from './fields.js'
import { candidateL0, matchFragment, matchesFilter, rankingDocuments, queryDocument } from './search-projection.js'
import { estimateTokens, truncateToEstimatedTokens } from './text.js'

export interface LocalTicketProviderConfig {
  readonly providerId?: string
  readonly indexVersion?: string
  readonly queryPolicyVersion?: string
  /** Resource capacity for one search response; never a user result-count limit. */
  readonly maxPageSize?: number
  readonly snapshotTtlMs?: number
  readonly now?: () => Date
  readonly ranker?: RetrievalRanker
  readonly defaultMode?: 'keyword' | 'dense' | 'hybrid'
}

interface SnapshotEntry {
  readonly snapshot: TicketSnapshot
  readonly bindingHash: string
  readonly records: readonly NormalizedTicketRecord[]
  readonly candidateRefs: Map<string, NormalizedTicketRecord>
  readonly rankings: Map<string, RankingResult>
}

const COMPILER_VERSION = 'retrieval-query-v1'
function overviewOrigin(record: NormalizedTicketRecord, field: 'title' | 'summary'): import('@retrieval-agent/contracts').TicketContentOrigin {
  const declared = field === 'title' ? record.titleOrigin : record.summaryOrigin
  if (declared) return declared
  if (record.rawSource?.datasetId === 'deepseek-ai/ESFT') return field === 'title'
    ? { kind: 'generated', sourceFields: ['summary'], description: '由上游摘要首句派生的定位标题。' }
    : { kind: 'unknown', sourceFields: ['summary'], description: '上游提供的摘要，非对话原文；摘要生成方式未声明。' }
  return { kind: 'unknown' }
}
function abortIfNeeded(options?: ProviderCallOptions): void {
  if (options?.signal?.aborted === true) throw new RetrievalError('CANCELLED', '操作已取消。')
}

/** Fixture-only provider. It intentionally defaults to denying unreviewed PII. */
export class LocalTicketProvider implements TicketRetrievalProvider {
  readonly providerId: string
  readonly #records: readonly NormalizedTicketRecord[]
  readonly #indexVersion: string
  readonly #queryPolicyVersion: string
  readonly #maxPageSize: number
  readonly #snapshotTtlMs: number
  readonly #now: () => Date
  readonly #fieldCatalog: readonly TicketFieldDescriptor[]
  readonly #filterFields: ReadonlyMap<string, TicketFieldDescriptor>
  readonly #evidenceFields: ReadonlySet<string>
  readonly #detailFields: ReadonlySet<string>
  readonly #ranker: RetrievalRanker
  readonly #defaultMode: 'keyword' | 'dense' | 'hybrid'
  readonly #snapshots = new Map<string, SnapshotEntry>()

  constructor(records: readonly NormalizedTicketRecord[], config: LocalTicketProviderConfig = {}) {
    this.providerId = config.providerId ?? 'local-fixture-v1'
    this.#records = [...records]
    this.#ranker = config.ranker ?? new HybridRankingEngine()
    this.#defaultMode = config.defaultMode ?? 'keyword'
    const sourceIndexVersion = config.indexVersion ?? sha256(records.map(record => `${record.ticketId}:${record.contentHash}`).sort().join('\n'))
    this.#indexVersion = sha256(`${sourceIndexVersion}:${this.#ranker.profileVersion}`)
    this.#queryPolicyVersion = config.queryPolicyVersion ?? 'query-policy-v1'
    this.#maxPageSize = config.maxPageSize ?? 100
    this.#snapshotTtlMs = config.snapshotTtlMs ?? 15 * 60_000
    this.#now = config.now ?? (() => new Date())
    const catalog = new Map<string, TicketFieldDescriptor>()
    for (const descriptor of [...LEGACY_FIELD_CATALOG, ...records.flatMap(record => record.fieldCatalog ?? [])]) {
      const previous = catalog.get(descriptor.key)
      if (previous !== undefined && stableJson(previous) !== stableJson(descriptor)) {
        throw new TypeError(`conflicting field descriptor ${descriptor.key}`)
      }
      catalog.set(descriptor.key, { ...descriptor, filterOperators: [...descriptor.filterOperators] })
    }
    this.#fieldCatalog = [...catalog.values()].sort((left, right) => left.key.localeCompare(right.key))
    this.#filterFields = new Map(this.#fieldCatalog.filter(field => field.filterOperators.length > 0).map(field => [field.key, field]))
    this.#evidenceFields = new Set(this.#fieldCatalog.filter(isReadableTicketField).map(field => field.key))
    this.#detailFields = new Set(this.#evidenceFields)
    if (!Number.isSafeInteger(this.#maxPageSize) || this.#maxPageSize < 1) throw new TypeError('maxPageSize must be positive')
    if (!Number.isSafeInteger(this.#snapshotTtlMs) || this.#snapshotTtlMs < 1) throw new TypeError('snapshotTtlMs must be positive')
  }

  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec {
    assertTicketRetrievalRequest(request)
    this.#assertFiltersSupported(request.filters ?? [])
    const requestedCount = request.requestedCount
    const countPolicy = request.countPolicy ?? 'adaptive'
    return {
      target: request.target,
      ...(request.retrievalIntent === undefined ? {} : { retrievalIntent: request.retrievalIntent }),
      originalQuery: request.query,
      normalizedQuery: (request.retrievalQuery ?? request.query).normalize('NFKC').trim().replace(/\s+/gu, ' '),
      ...(requestedCount === undefined ? {} : { requestedCount }),
      countPolicy,
      mode: request.mode ?? this.#defaultMode,
      filters: [...request.filters ?? []],
      ...(request.fastQuery === undefined ? {} : {
        fastQuery: request.fastQuery,
        ...(request.fastQuery.keyword === undefined ? {} : { keywordQuery: {
          terms: [...request.fastQuery.keyword.terms],
          operator: request.fastQuery.keyword.operator,
        } }),
        semanticQuery: request.fastQuery.vector.text,
      }),
      ...(request.queryContract?.logic === undefined
        ? {}
        : { requiredConcepts: request.queryContract.logic.requiredConcepts.map(concept => ({ ...concept, alternatives: [...concept.alternatives] })) }),
      ambiguities: [...request.ambiguities ?? []],
      excludedTerms: [],
      semanticHints: [],
      compilerVersion: COMPILER_VERSION,
      ...(request.queryContract?.queryPlan === undefined ? {} : { queryPlan: request.queryContract.queryPlan }),
    }
  }

  async openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot> {
    abortIfNeeded(options)
    assertTrustedPrincipal(principal, this.#now().getTime())
    const now = this.#now()
    const bindingHash = principalBinding(principal)
    const records = this.#records.filter(record => canRead(record, principal))
    const sourceVersion = sha256(records.map(record => `${record.sourceVersion}:${record.contentHash}`).sort().join('\n'))
    const snapshotId = TicketSnapshotId(shortOpaque('snap', bindingHash, sourceVersion, this.#indexVersion, now.toISOString()))
    const snapshot: TicketSnapshot = {
      snapshotId,
      shortId: sha256(snapshotId).slice(0, 10),
      providerId: this.providerId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#snapshotTtlMs).toISOString(),
      sourceVersion,
      indexVersion: this.#indexVersion,
      retrievalProfileVersion: this.#ranker.profileVersion,
      authorizationVersion: principal.entitlementVersion,
      principalBindingHash: bindingHash,
      queryPolicyVersion: this.#queryPolicyVersion,
      fieldCatalog: this.#fieldCatalog,
      capabilities: {
        exhaustive: true,
        pagination: true,
        evidencePromotion: true,
        detailRead: true,
        exportRead: true,
        keywordSearch: true,
        denseSearch: this.#ranker.capabilities.dense,
        hybridFusion: this.#ranker.capabilities.fusion,
        reranking: this.#ranker.capabilities.reranker,
      },
    }
    this.#snapshots.set(snapshotId, { snapshot, bindingHash, records, candidateRefs: new Map(), rankings: new Map() })
    return snapshot
  }

  /** Reconstruct identities only from the same source and a fresh trusted grant. */
  restoreSnapshot(principal: TrustedPrincipalContext, snapshot: TicketSnapshot): void {
    assertTrustedPrincipal(principal, this.#now().getTime())
    const bindingHash = principalBinding(principal)
    if (bindingHash !== snapshot.principalBindingHash || snapshot.authorizationVersion !== principal.entitlementVersion) {
      throw new RetrievalError('UNAUTHORIZED', '当前身份无权恢复此快照。')
    }
    const records = this.#records.filter(record => canRead(record, principal))
    const sourceVersion = sha256(records.map(record => `${record.sourceVersion}:${record.contentHash}`).sort().join('\n'))
    if (snapshot.providerId !== this.providerId || snapshot.sourceVersion !== sourceVersion
      || snapshot.indexVersion !== this.#indexVersion || (snapshot.expiresAt !== undefined && Date.parse(snapshot.expiresAt) <= this.#now().getTime())) {
      throw new RetrievalError('SNAPSHOT_INVALID', '历史来源、索引或快照期限已失效。')
    }
    this.#snapshots.set(snapshot.snapshotId, { snapshot, bindingHash, records, rankings: new Map(),
      candidateRefs: new Map(records.map(record => [shortOpaque('cand', snapshot.snapshotId, record.ticketId), record])) })
  }

  async search(
    principal: TrustedPrincipalContext,
    snapshotId: TicketSnapshotId,
    query: TicketRetrievalSpec,
    options: TicketSearchOptions,
  ): Promise<TicketSearchPage> {
    const started = performance.now()
    abortIfNeeded(options)
    const entry = this.#authorizeSnapshot(principal, snapshotId)
    this.#assertFiltersSupported(query.filters)
    if (!Number.isSafeInteger(options.topK) || options.topK < 1 || options.topK > this.#maxPageSize) {
      throw new RetrievalError('INVALID_REQUEST', `单页候选数量必须在 1 到 ${this.#maxPageSize} 之间。`)
    }
    if (!Number.isSafeInteger(options.maxScan) || options.maxScan < 1) throw new RetrievalError('INVALID_REQUEST', 'maxScan 无效。')
    const queryFingerprint = sha256(stableJson(query))
    this.#decodeCursor(options.cursor, snapshotId, queryFingerprint)
    const filtered = entry.records.filter(record => query.filters.every(filter => matchesFilter(record, filter)))
    const eligible = query.queryPlan === undefined ? filtered : filtered.filter(record => evaluateQuery(query.queryPlan!.hard, queryDocument(record)) === true)
    const documents = rankingDocuments(eligible)
    const fastKeyword = query.fastQuery?.keyword
    const isUnmodifiedKeyword = fastKeyword === undefined
      ? query.keywordQuery === undefined
      : query.keywordQuery?.operator === fastKeyword.operator
        && query.keywordQuery.terms.length === fastKeyword.terms.length
        && query.keywordQuery.terms.every((term, index) => term === fastKeyword.terms[index])
    const isUnmodifiedFastQuery = query.fastQuery !== undefined
      && query.semanticQuery === query.fastQuery.vector.text
      && isUnmodifiedKeyword
    let ranked = entry.rankings.get(queryFingerprint)
    try {
      if (ranked === undefined) {
        const astKeyword = query.queryPlan !== undefined && isUnmodifiedKeyword
        const keywordRecords = astKeyword ? eligible.filter(record => evaluateQuery(query.queryPlan!.keyword, queryDocument(record)) === true) : []
        ranked = astKeyword && query.mode === 'keyword' ? {
          hits: [], execution: { requestedMode: 'keyword', executedMode: 'keyword', strategyVersion: 'literal-ast-v1', channels: [] },
          scanned: eligible.length, keywordEligible: 0, rankedHits: 0, warnings: [],
        } : await this.#ranker.rank(documents, {
          text: query.normalizedQuery,
          fastPath: options.stage !== 'repair_search' && isUnmodifiedFastQuery,
          ...(query.semanticQuery === undefined ? {} : { semanticText: query.semanticQuery }),
          ...(query.keywordQuery === undefined ? {} : { keywordQuery: query.keywordQuery }),
          semanticHints: query.semanticHints,
          excludedTerms: query.excludedTerms,
          ...(query.requiredConcepts === undefined ? {} : { requiredConcepts: query.requiredConcepts }),
          mode: astKeyword ? 'dense' : query.mode,
        }, { maxScan: options.maxScan, ...(options.signal === undefined ? {} : { signal: options.signal }) })
        if (astKeyword && query.mode !== 'dense') {
          const merged = new Map(ranked.hits.map(hit => [hit.documentId, hit]))
          keywordRecords.forEach((record, i) => {
            const old = merged.get(record.ticketId)
            const channels = [...old?.channels ?? [], { channel: 'keyword' as const, rank: i + 1, score: 1 }]
            merged.set(record.ticketId, { documentId: record.ticketId, rank: i + 1, score: channels.reduce((sum, c) => sum + 1 / (60 + c.rank), 0), channels })
          })
          const hits = [...merged.values()].sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId)).map((hit, i) => ({ ...hit, rank: i + 1 }))
          ranked = { ...ranked, hits, keywordEligible: keywordRecords.length, rankedHits: hits.length,
            execution: { ...ranked.execution, requestedMode: query.mode, executedMode: query.mode, channels: [
              { channel: 'keyword', implementation: 'file-literal-ast', version: 'nfkc-lower-v1', resultCount: keywordRecords.length, elapsedMs: 0, querySource: 'direct_user_keywords' }, ...ranked.execution.channels,
            ] } }
        }
        entry.rankings.set(queryFingerprint, ranked)
      }
    } catch (error) {
      if (error instanceof RankingError && error.code === 'SCAN_LIMIT') {
        throw new RetrievalError('CAPACITY_EXCEEDED', '当前授权语料超过本地检索容量。', { cause: error })
      }
      if (error instanceof RankingError && error.code === 'HYBRID_UNAVAILABLE') {
        throw new RetrievalError('PROVIDER_UNAVAILABLE', '本地 Hybrid 检索模型不可用。', { retryable: true, cause: error })
      }
      if (error instanceof RankingError && error.code === 'CANCELLED') {
        throw new RetrievalError('CANCELLED', 'RAG 排名请求已取消。', { cause: error })
      }
      if (error instanceof RankingError && error.code === 'DEADLINE_EXCEEDED') {
        throw new RetrievalError('TIMEOUT', 'RAG 排名请求超时。', { retryable: true, cause: error })
      }
      if (error instanceof RankingError && error.code === 'PROTOCOL_MISMATCH') {
        throw new RetrievalError('PROTOCOL_MISMATCH', 'RAG 排名服务返回了越界或无效结果。', { cause: error })
      }
      if (error instanceof RankingError) {
        throw new RetrievalError('PROVIDER_UNAVAILABLE', 'RAG 排名服务不可用。', { retryable: error.retryable, cause: error })
      }
      throw error
    }
    if (ranked === undefined) throw new RetrievalError('PROVIDER_UNAVAILABLE', '本地排名结果不可用。')
    return this.projectRanking(principal, snapshotId, query, options, ranked, started)
  }

  /** Shared authorized evidence projection for externally executed SQL/Milvus rankings. */
  projectRanking(principal: TrustedPrincipalContext, snapshotId: TicketSnapshot['snapshotId'], query: TicketRetrievalSpec,
    options: TicketSearchOptions, ranked: RankingResult, started = performance.now()): TicketSearchPage {
    abortIfNeeded(options)
    const entry = this.#authorizeSnapshot(principal, snapshotId)
    const queryFingerprint = sha256(stableJson(query))
    const offset = this.#decodeCursor(options.cursor, snapshotId, queryFingerprint)
    const terms = query.keywordQuery?.terms ?? []
    const filtered = entry.records.filter(record => query.filters.every(filter => matchesFilter(record, filter)))
    const byId = new Map(filtered.map(record => [record.ticketId as string, record]))
    if (new Set(ranked.hits.map(hit => hit.documentId)).size !== ranked.hits.length
      || ranked.hits.some(hit => !byId.has(hit.documentId))) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '排名器返回了未授权或重复的文档。')
    }
    // Candidate ranks are not semantic acceptance. Later pages must remain reachable after exclusions.
    const resultHits = ranked.hits
    const pageHits = resultHits.slice(offset, offset + options.topK)
    const candidates = pageHits.map((hit, index): TicketCandidate => {
      const record = byId.get(hit.documentId)!
      const ref = TicketCandidateRef(shortOpaque('cand', snapshotId, record.ticketId))
      entry.candidateRefs.set(ref, record)
      const titleFragment = matchFragment(record.title, terms)
      const summaryFragment = matchFragment(record.summary, terms)
      return {
        ref,
        displayId: record.displayId,
        sourceVersion: record.sourceVersion,
        snapshotId,
        contentHash: record.contentHash,
        evidenceLevel: 'L1',
        projectionVersion: 2,
        summaryOrigin: overviewOrigin(record, 'summary'),
        titleOrigin: overviewOrigin(record, 'title'),
        rank: offset + index + 1,
        title: record.title,
        summary: record.summary,
        l0: candidateL0(record),
        matchFragments: [
          ...(titleFragment === undefined ? [] : [{ field: 'title' as const, ...titleFragment }]),
          ...(summaryFragment === undefined ? [] : [{ field: 'summary' as const, ...summaryFragment }]),
        ],
        matchSignals: {
          channels: [...new Set(hit.channels.map(channel => channel.channel))],
          keywordTerms: [...(query.keywordQuery?.terms ?? [])],
        },
      }
    })
    const nextOffset = offset + candidates.length
    const hasNext = nextOffset < resultHits.length
    const signalByDocument = new Map(pageHits.map((hit, index) => [hit.documentId, { hit, candidate: candidates[index]! }]))
    return {
      snapshotId,
      queryFingerprint,
      candidates,
      completeness: hasNext ? 'bounded' : 'exhaustive',
      ...(hasNext ? { nextCursor: this.#encodeCursor(nextOffset, snapshotId, queryFingerprint) } : {}),
      scanned: ranked.scanned,
      returned: candidates.length,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      appliedFilters: [...query.filters],
      warnings: [...ranked.warnings],
      trace: {
        stage: options.stage,
        ...ranked.execution,
        signals: [...signalByDocument.values()].map(({ hit, candidate }) => ({
          candidateRef: candidate.ref,
          finalRank: candidate.rank,
          fusedScore: hit.score,
          channels: hit.channels.map(channel => ({ ...channel })),
        })),
      },
      boundary: {
        authorizedCorpusSize: entry.records.length,
        documentsAfterStructuredFilters: filtered.length,
        documentsEligibleForKeywordChannel: ranked.keywordEligible,
        rankedHits: ranked.rankedHits,
        resultPagesExhausted: !hasNext,
        semanticRecallKnown: false,
      },
    }
  }

  async readEvidence(
    principal: TrustedPrincipalContext,
    request: EvidenceReadRequest,
    options?: ProviderCallOptions,
  ): Promise<TicketEvidenceResult> {
    abortIfNeeded(options)
    const entry = this.#authorizeSnapshot(principal, request.snapshotId)
    if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget < 1) throw new RetrievalError('INVALID_REQUEST', '证据 token 预算无效。')
    for (const field of request.fields) if (!this.#evidenceFields.has(field)) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了不允许的证据字段。')
    let remaining = request.tokenBudget
    let tokensUsed = 0
    const position = request.position
    if (position && (!request.candidateRefs.includes(position.candidateRef) || !request.fields.includes(position.field)
      || !Number.isSafeInteger(position.part) || position.part < 0 || !Number.isSafeInteger(position.start) || position.start < 0)) {
      throw new RetrievalError('INVALID_REQUEST', '续读位置不属于本次候选和字段。')
    }
    let reached = position === undefined
    let nextPosition: TicketEvidenceResult['nextPosition']
    const evidence: TicketEvidenceResult['evidence'][number][] = []
    const rejected: typeof request.candidateRefs[number][] = []
    reading: for (const ref of request.candidateRefs) {
      abortIfNeeded(options)
      const record = entry.candidateRefs.get(ref)
      if (record === undefined || !canRead(record, principal)) {
        rejected.push(ref)
        continue
      }
      for (const field of request.fields) {
        for (const [part, value] of evidenceFieldValues(record, field).entries()) {
          if (!reached) {
            if (ref !== position!.candidateRef || field !== position!.field || part !== position!.part) continue
            if (position!.start > value.length) throw new RetrievalError('INVALID_REQUEST', '续读位置超出来源字段。')
            reached = true
          }
          let start = position && ref === position.candidateRef && field === position.field && part === position.part ? position.start : 0
          while (start < value.length) {
          if (remaining <= 0) { nextPosition = { candidateRef: ref, field, part, start }; break reading }
          const selected = truncateToEstimatedTokens(value.slice(start), Math.min(remaining, 1200))
          if (selected.text.length === 0) { nextPosition = { candidateRef: ref, field, part, start }; break reading }
          const end = start + selected.text.length
          const evidenceId = TicketEvidenceId(shortOpaque('ev', request.snapshotId, ref, field, String(part), record.contentHash, String(start), String(end)))
          evidence.push({
            projectionVersion: 2, projectionLevel: field === 'summary' ? 'L1' : request.level ?? 'L2', part, fieldLength: value.length,
            datasetId: record.rawSource?.datasetId ?? this.providerId, spanHash: sha256(selected.text),
            origin: field === 'summary' ? overviewOrigin(record, 'summary') : { kind: 'source', sourceFields: [field] },
            evidenceId,
            candidateRef: ref,
            displayId: record.displayId,
            sourceVersion: record.sourceVersion,
            contentHash: record.contentHash,
            field,
            text: selected.text,
            start,
            end,
            estimatedTokens: selected.tokens,
            trust: 'untrusted_ticket_evidence',
            truncated: start > 0 || end < value.length,
            evidenceLevel: ['title', 'summary'].includes(field) ? 'L1' : 'L2',
            readers: ['provider'], snapshotId: request.snapshotId,
            authorizationVersion: entry.snapshot.authorizationVersion,
            principalBindingHash: entry.snapshot.principalBindingHash,
          })
          remaining -= selected.tokens
          tokensUsed += selected.tokens
          start = end
          }
        }
      }
    }
    if (!reached) throw new RetrievalError('INVALID_REQUEST', '续读字段或分段已不存在。')
    return {
      ...(nextPosition === undefined ? {} : { nextPosition }),
      snapshotId: request.snapshotId,
      evidence,
      requestedCandidateRefs: [...request.candidateRefs],
      rejectedCandidateRefs: rejected,
      tokenBudget: request.tokenBudget,
      tokensUsed,
      warnings: remaining === 0 ? ['token_budget_exhausted'] : [],
    }
  }

  async readDetails(
    principal: TrustedPrincipalContext,
    request: DetailReadRequest,
    options?: ProviderCallOptions,
  ): Promise<TicketDetailResult> {
    abortIfNeeded(options)
    const entry = this.#authorizeSnapshot(principal, request.snapshotId)
    for (const field of request.fields) if (!this.#detailFields.has(field)) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了不允许的详情字段。')
    const details: TicketDetail[] = []
    const evidence: TicketEvidenceResult['evidence'][number][] = []
    const rejected: typeof request.candidateRefs[number][] = []
    for (const ref of request.candidateRefs) {
      abortIfNeeded(options)
      const record = entry.candidateRefs.get(ref)
      if (record === undefined || !canRead(record, principal)) {
        rejected.push(ref)
        continue
      }
      const fields: Partial<Record<TicketEvidenceField, readonly string[]>> = {}
      const unavailableFields: TicketEvidenceField[] = []
      for (const field of request.fields) {
        const values = evidenceFieldValues(record, field)
        if (values.length === 0) unavailableFields.push(field)
        else fields[field] = [...values]
        for (const [part, text] of values.entries()) evidence.push({
          projectionVersion: 2, projectionLevel: field === 'summary' ? 'L1' : 'L3', part, fieldLength: text.length,
          datasetId: record.rawSource?.datasetId ?? this.providerId, spanHash: sha256(text),
          origin: field === 'summary' ? overviewOrigin(record, 'summary') : { kind: 'source', sourceFields: [field] },
          evidenceId: TicketEvidenceId(shortOpaque('ev', request.snapshotId, ref, field, String(part), record.contentHash, '0', String(text.length))),
          candidateRef: ref, displayId: record.displayId, sourceVersion: record.sourceVersion, contentHash: record.contentHash,
          field, text, start: 0, end: text.length, estimatedTokens: estimateTokens(text),
          trust: 'untrusted_ticket_evidence', truncated: false,
          evidenceLevel: ['title', 'summary'].includes(field) ? 'L1' : 'L2', readers: ['provider'],
          snapshotId: request.snapshotId, authorizationVersion: entry.snapshot.authorizationVersion,
          principalBindingHash: entry.snapshot.principalBindingHash,
        })
      }
      details.push({
        candidateRef: ref,
        displayId: record.displayId,
        sourceVersion: record.sourceVersion,
        title: record.title,
        summary: record.summary,
        l0: candidateL0(record),
        fields,
        unavailableFields,
      })
    }
    return { snapshotId: request.snapshotId, details, evidence, rejectedCandidateRefs: rejected, warnings: [] }
  }

  async status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshotId): Promise<TicketProviderStatus> {
    assertTrustedPrincipal(principal, this.#now().getTime())
    if (snapshotId === undefined) {
      return { providerId: this.providerId, ready: true, readOnly: true, indexVersion: this.#indexVersion, warnings: [] }
    }
    try {
      const entry = this.#authorizeSnapshot(principal, snapshotId)
      return {
        providerId: this.providerId,
        ready: true,
        readOnly: true,
        sourceVersion: entry.snapshot.sourceVersion,
        indexVersion: entry.snapshot.indexVersion,
        snapshotValid: true,
        warnings: [],
      }
    } catch (error) {
      if (error instanceof RetrievalError && (error.code === 'SNAPSHOT_INVALID' || error.code === 'SNAPSHOT_NOT_FOUND')) {
        return { providerId: this.providerId, ready: true, readOnly: true, indexVersion: this.#indexVersion, snapshotValid: false, warnings: ['snapshot_invalid'] }
      }
      throw error
    }
  }

  #authorizeSnapshot(principal: TrustedPrincipalContext, snapshotId: TicketSnapshotId): SnapshotEntry {
    assertTrustedPrincipal(principal, this.#now().getTime())
    const entry = this.#snapshots.get(snapshotId)
    if (entry === undefined) throw new RetrievalError('SNAPSHOT_NOT_FOUND', '检索快照不存在或已不可用。')
    if (principalBinding(principal) !== entry.bindingHash) throw new RetrievalError('UNAUTHORIZED', '当前身份不能使用该检索快照。')
    if (entry.snapshot.expiresAt !== undefined && Date.parse(entry.snapshot.expiresAt) <= this.#now().getTime()) {
      throw new RetrievalError('SNAPSHOT_INVALID', '检索快照已失效，请重新检索。')
    }
    return entry
  }

  #assertFiltersSupported(filters: readonly TicketFilter[]): void {
    for (const filter of filters) {
      const descriptor = this.#filterFields.get(filter.field)
      if (descriptor === undefined || !descriptor.filterOperators.includes(filter.op)) {
        throw new RetrievalError('FIELD_NOT_ALLOWED', `Provider 不支持筛选字段或操作 ${filter.field}:${filter.op}。`)
      }
      if (descriptor.valueKind === 'datetime' && Number.isNaN(Date.parse(filter.value))) {
        throw new RetrievalError('INVALID_REQUEST', `筛选字段 ${filter.field} 需要有效时间。`)
      }
    }
  }

  #encodeCursor(offset: number, snapshotId: TicketSnapshotId, queryFingerprint: string): string {
    const body = `${offset}:${queryFingerprint}`
    const signature = sha256(`${snapshotId}:${body}`).slice(0, 16)
    return Buffer.from(`${body}:${signature}`, 'utf8').toString('base64url')
  }

  #decodeCursor(cursor: string | undefined, snapshotId: TicketSnapshotId, queryFingerprint: string): number {
    if (cursor === undefined) return 0
    let decoded: string
    try {
      decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    } catch (error) {
      throw new RetrievalError('INVALID_REQUEST', '分页游标无效。', { cause: error })
    }
    const [offsetText, fingerprint, signature, extra] = decoded.split(':')
    if (extra !== undefined || offsetText === undefined || fingerprint === undefined || signature === undefined) {
      throw new RetrievalError('INVALID_REQUEST', '分页游标无效。')
    }
    const offset = Number(offsetText)
    const expected = sha256(`${snapshotId}:${offsetText}:${fingerprint}`).slice(0, 16)
    if (!Number.isSafeInteger(offset) || offset < 0 || fingerprint !== queryFingerprint || signature !== expected) {
      throw new RetrievalError('INVALID_REQUEST', '分页游标与当前检索不匹配。')
    }
    return offset
  }
}
