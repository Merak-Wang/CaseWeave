import { performance } from 'node:perf_hooks'
import {
  RetrievalError,
  evaluateQuery,
  normalizeLiteral,
  TicketCandidateRef,
  TicketSnapshotId,
  assertTicketRetrievalRequest,
  assertTrustedPrincipal,
  type DetailReadRequest,
  type EvidenceReadRequest,
  type NormalizedTicketRecord,
  type ProviderCallOptions,
  type TicketCandidate,
  type TicketDetailResult,
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
  fuseRankingHits, rankSourceHits,
  type DocumentProjection,
  RankingError,
  type RankingResult,
  type RetrievalRanker,
} from '@retrieval-agent/model-service-client/ranking'
import { sha256, shortOpaque, stableJson } from './hash.js'
import { ticketGroupHashes } from './grouping.js'
import { canRead, principalBinding } from './authorization.js'
import { LEGACY_FIELD_CATALOG } from './fields.js'
import { candidateL0, matchFragment, matchesFilter, rankingDocuments, queryDocument } from './search-projection.js'
import { overviewOrigin, projectEvidence, projectDetails } from './evidence-projection.js'

export interface LocalTicketProviderConfig {
  readonly providerId?: string
  readonly indexVersion?: string
  readonly queryPolicyVersion?: string
  /** Resource capacity for one search response; never a user result-count limit. */
  readonly maxPageSize?: number
  readonly snapshotTtlMs?: number
  readonly now?: () => Date
  readonly ranker?: RetrievalRanker
  readonly documentProjection?: DocumentProjection
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
  readonly #ranker: RetrievalRanker
  readonly #documentProjection: DocumentProjection
  readonly #defaultMode: 'keyword' | 'dense' | 'hybrid'
  readonly #snapshots = new Map<string, SnapshotEntry>()
  readonly #rankingVectors = new Map<string, Promise<readonly number[]>>()

  constructor(records: readonly NormalizedTicketRecord[], config: LocalTicketProviderConfig = {}) {
    this.providerId = config.providerId ?? 'local-fixture-v1'
    this.#records = [...records]
    this.#ranker = config.ranker ?? new HybridRankingEngine(config.documentProjection === undefined ? {} : {documentProjection:config.documentProjection})
    this.#documentProjection = config.documentProjection ?? this.#ranker.documentProjection ?? 'ticket-search-projection-v1'
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
    this.#fieldCatalog = [...catalog.values()].map(field => this.#documentProjection === 'canonical-title-abstract-v1'
      && ['L2', 'L3'].includes(field.accessLevel) ? { ...field, capability: { key: field.key, searchable: false,
        operations: [] as const, availability: 'unavailable' as const, origin: 'source' as const,
        source: 'canonical-title-abstract-v1' } } : field).sort((left, right) => left.key.localeCompare(right.key))
    this.#filterFields = new Map(this.#fieldCatalog.filter(field => field.filterOperators.length > 0).map(field => [field.key, field]))
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
      documentProjection: this.#documentProjection,
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
      || snapshot.indexVersion !== this.#indexVersion) {
      throw new RetrievalError('SNAPSHOT_INVALID', '历史来源或索引已失效。')
    }
    // 来源、索引和授权仍相同时续期快照，保留结果身份以支持刷新和重启。
    const restored = { ...snapshot, expiresAt: new Date(this.#now().getTime() + this.#snapshotTtlMs).toISOString() }
    this.#snapshots.set(snapshot.snapshotId, { snapshot: restored, bindingHash, records, rankings: new Map(),
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
    const documents = rankingDocuments(eligible, this.#documentProjection)
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
          && query.queryPlan.requirements.some(requirement => requirement.kind === 'keyword')
        const literalKeyword = astKeyword || Boolean(query.keywordQuery?.terms.length)
        const normalize = (s: string) => s.normalize('NFKC').toLowerCase()
        const keywordDocument = (record: NormalizedTicketRecord) => this.#documentProjection === 'canonical-title-abstract-v1'
          ? {fields:{},texts:{title:[record.title],summary:[record.summary]}} : queryDocument(record)
        const keywordRecords = astKeyword ? eligible.filter(record => evaluateQuery(query.queryPlan!.keyword, keywordDocument(record)) === true)
          : literalKeyword ? eligible.filter(record => {
            const doc = keywordDocument(record)
            const values = [...Object.values(doc.texts), ...Object.values(doc.fields)].flatMap(value => Array.isArray(value) ? value : [value]).filter(v => typeof v === 'string').map(v => normalize(v as string))
            const hits = query.keywordQuery!.terms.map(term => values.some(value => value.includes(normalize(term))))
            return (query.keywordQuery!.operator === 'and' ? hits.every(Boolean) : hits.some(Boolean))
              && !query.excludedTerms.some(term => values.some(value => value.includes(normalize(term))))
          }) : []
        ranked = await this.#ranker.rank(documents, {
          text: query.normalizedQuery,
          fastPath: options.stage !== 'repair_search' && isUnmodifiedFastQuery,
          ...(query.semanticQuery === undefined ? {} : { semanticText: query.semanticQuery }),
          ...(query.keywordQuery === undefined ? {} : { keywordQuery: query.keywordQuery }),
          semanticHints: query.semanticHints,
          excludedTerms: query.excludedTerms,
          ...(query.requiredConcepts === undefined ? {} : { requiredConcepts: query.requiredConcepts }),
          mode: query.mode,
        }, { maxScan: options.maxScan, ...(options.signal === undefined ? {} : { signal: options.signal }) })
        if (literalKeyword && query.mode !== 'dense') {
          const members = new Set(keywordRecords.map(record => record.ticketId as string))
          const lexical = ranked.hits.flatMap(hit => hit.channels.filter(c => c.channel === 'keyword' && members.has(hit.documentId)).map(c => ({documentId:hit.documentId,score:c.score})))
          const seen = new Set(lexical.map(hit => hit.documentId))
          for (const record of keywordRecords) if (!seen.has(record.ticketId)) lexical.push({documentId:record.ticketId,score:0})
          const dense = ranked.hits.flatMap(hit => hit.channels.filter(c => c.channel === 'vector').map(c => ({documentId:hit.documentId,score:c.score})))
          const fusion=this.#ranker.fusionOptions??{rankConstant:60,keywordWeight:.55,vectorWeight:.45}
          let hits = query.mode === 'keyword'
            ? rankSourceHits(lexical).map((hit,index) => ({...hit,rank:index+1,lexical_raw:hit.score,channels:[{channel:'keyword' as const,rank:hit.rank,score:hit.score}]}))
            : fuseRankingHits(lexical,dense,fusion)
          if(ranked.execution.reranker){
            const reranks=new Map(ranked.hits.flatMap(hit=>hit.channels.filter(c=>c.channel==='reranker').map(c=>[hit.documentId,c] as const)))
            hits=hits.map(hit=>({...hit,channels:[...hit.channels,...(reranks.has(hit.documentId)?[reranks.get(hit.documentId)!]:[])]})).sort((a,b)=>(reranks.get(a.documentId)?.rank??hits.length+a.rank)-(reranks.get(b.documentId)?.rank??hits.length+b.rank)).map((hit,index)=>({...hit,rank:index+1}))
          }
          ranked = {...ranked,hits,keywordEligible:keywordRecords.length,rankedHits:hits.length,
            execution:{...ranked.execution,requestedMode:query.mode,executedMode:query.mode,
              ...(query.mode === 'hybrid' ? {fusion:{method:'weighted_rrf' as const,version:'weighted-rrf-v1',...fusion}} : {})}}

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
    entry.rankings.set(queryFingerprint, ranked)
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
        l0: candidateL0(record), groupHashes: ticketGroupHashes(record),
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
      recallScope: queryFingerprint,
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

  async readEvidence(principal: TrustedPrincipalContext, request: EvidenceReadRequest, options?: ProviderCallOptions): Promise<TicketEvidenceResult> {
    return projectEvidence({ ...this.#authorizeSnapshot(principal, request.snapshotId), now: this.#now }, principal, request, options)
  }
  async readFeatures(principal: TrustedPrincipalContext,
    request: { readonly snapshotId: TicketSnapshotId; readonly candidateRefs: readonly TicketCandidateRef[] }, options?: ProviderCallOptions) {
    const entry = this.#authorizeSnapshot(principal, request.snapshotId)
    const records = request.candidateRefs.map(ref => {
      const record = entry.candidateRefs.get(ref)
      if (!record || !canRead(record, principal)) throw new RetrievalError('UNAUTHORIZED', '特征读取需要当前已授权候选。')
      return { ref, record }
    })
    if (!this.#ranker.readFeatures) return []
    const data = await this.#ranker.readFeatures(records.map(({ record }) => ({ id: record.ticketId, contentHash: record.contentHash })), options?.signal)
    this.#authorizeSnapshot(principal, request.snapshotId)
    return records.flatMap(({ ref, record }) => {
      const feature = data.rows.find(r => r.id === record.ticketId)
      return feature ? [{ ref, version: record.sourceVersion, content_hash: record.contentHash, embedding_id: data.embedding_id, vectors: [feature.vector] }] : []
    })
  }
  async scanFeatures(principal: TrustedPrincipalContext,
    request: { snapshotId: TicketSnapshotId; cursor?: string; limit: number }, options?: ProviderCallOptions) {
    const entry = this.#authorizeSnapshot(principal, request.snapshotId)
    const offset = Number(request.cursor ?? 0), records = entry.records.slice(offset, offset + request.limit)
    const refs = records.map(record => {
      const ref = TicketCandidateRef(shortOpaque('cand', request.snapshotId, record.ticketId))
      entry.candidateRefs.set(ref, record)
      return ref
    })
    const features = new Map((await this.readFeatures(principal, { snapshotId: request.snapshotId, candidateRefs: refs }, options)).map(f => [f.ref, f]))
    return { rows: records.map((r, i) => features.get(refs[i]!) ?? { ref: refs[i]!, version: r.sourceVersion,
      content_hash: r.contentHash, embedding_id: '', vectors: [] }), total: entry.records.length,
      ...(offset + records.length < entry.records.length ? { nextCursor: String(offset + records.length) } : {}) }
  }
  async #featureScores(entry: SnapshotEntry, ids: readonly number[], dense: string, dimensions: number,
    query: string | undefined, signal?: AbortSignal): Promise<number[] | undefined> {
    if (!query || !ids.length) return undefined
    if (!this.#ranker.queryAnchors) throw new RetrievalError('PROVIDER_UNAVAILABLE', '相关度选样需要同索引查询向量。')
    let pending = this.#rankingVectors.get(query)
    if (!pending) {
      pending = this.#ranker.queryAnchors([query], signal).then(anchors => anchors.vectors[0]!)
      this.#rankingVectors.set(query, pending)
    }
    const vector = await pending, queryNorm = Math.hypot(...vector)
    const normalized = normalizeLiteral(query), points = Array.from(normalized)
    const grams = [...new Set(points.slice(0, -1).map((point, i) => point + points[i + 1]!))]
    if (!grams.length && normalized) grams.push(normalized)
    const bytes = Buffer.from(dense, 'base64')
    // 每块复用原句向量；字面覆盖只读同一投影的字段，不把正文混进标题摘要试用。
    return ids.map((id, index) => {
      const record = entry.records[id]!
      const fields = (this.#documentProjection === 'canonical-title-abstract-v1'
        ? [record.title, record.summary] : Object.values(queryDocument(record).texts).flat()).map(normalizeLiteral)
      const coverage = grams.length ? grams.filter(gram => fields.some(text => text.includes(gram))).length / grams.length : 0
      let dot = 0, norm = 0
      for (let j = 0; j < dimensions; j++) {
        const value = bytes.readFloatLE((index * dimensions + j) * 4)
        dot += value * vector[j]!; norm += value * value
      }
      const cosine = norm && queryNorm ? Math.max(0, Math.min(1, dot / Math.sqrt(norm) / queryNorm)) : 0
      return (coverage + cosine) / 2
    })
  }

  async featureBlock(principal: TrustedPrincipalContext,
    request: Parameters<NonNullable<TicketRetrievalProvider['featureBlock']>>[1], options?: ProviderCallOptions) {
    const entry = this.#authorizeSnapshot(principal, request.snapshotId)
    const cohort = request.recallScope === undefined ? undefined : entry.rankings.get(request.recallScope)?.hits
    if (request.recallScope !== undefined && cohort === undefined) throw new RetrievalError('INVALID_REQUEST', '召回范围不存在或尚未完成。')
    const cohortIds = cohort === undefined ? undefined : new Set(cohort.map(hit => hit.documentId))
    const offset = Number(request.cursor ?? (request.recallScope !== undefined || request.refs !== undefined ? -1 : 0))
    const requestedRefs = request.refs && new Set(request.refs)
    const ids = request.ids ? [...request.ids] : []
    if (request.ids && cohortIds && request.ids.some(id => !cohortIds.has(entry.records[id]?.ticketId ?? '')))
      throw new RetrievalError('UNAUTHORIZED', '数值 ID 不属于当前召回范围。')
    let next = offset
    if (!request.ids) {
      if (cohortIds) {
        const start = offset < 0 ? 0 : offset + 1
        for (next = start; next < entry.records.length && ids.length < request.limit; next++) {
          const r = entry.records[next]!
          const ref = TicketCandidateRef(shortOpaque('cand', request.snapshotId, r.ticketId))
          if (cohortIds.has(r.ticketId) && (!requestedRefs || requestedRefs.has(ref))
            && (request.filters ?? []).every(f => matchesFilter(r, f))) ids.push(next)
        }
      } else if (requestedRefs) {
        next = offset < 0 ? 0 : offset + 1
        for (; next < entry.records.length && ids.length < request.limit; next++) {
          const r = entry.records[next]!
          if (requestedRefs.has(TicketCandidateRef(shortOpaque('cand', request.snapshotId, r.ticketId)))
            && (request.filters ?? []).every(f => matchesFilter(r, f))) ids.push(next)
        }
      } else for (; next < entry.records.length && ids.length < request.limit; next++) {
        const r = entry.records[next]!
        if ((request.filters ?? []).every(f => matchesFilter(r, f))) ids.push(next)
      }
    }
    let next_cursor: string | null = null
    if (!request.ids && ids.length === request.limit) {
      if (request.recallScope !== undefined) next_cursor = String(ids.at(-1))
      else if (!requestedRefs) next_cursor = String(next)
    }
    if (this.#ranker.readFeatureBlock) {
      const block = await this.#ranker.readFeatureBlock(rankingDocuments(ids.map(i=>entry.records[i]!),this.#documentProjection), options?.signal)
      this.#authorizeSnapshot(principal, request.snapshotId)
      const scores = await this.#featureScores(entry, ids, block.dense, block.dimensions, request.rankingQuery, options?.signal)
      return { ids, row_groups: ids.map(i => ticketGroupHashes(entry.records[i]!)), dense: block.dense, dimensions: block.dimensions, available: block.available,
        ...(scores ? { scores } : {}),
        feature_id: request.recallScope !== undefined ? sha256(stableJson({ index: block.embedding_id, recallScope: request.recallScope })) : block.embedding_id, next_cursor }
    }
    const refs = ids.map(i => {
      const r = entry.records[i]
      if (!r || !canRead(r, principal)) throw new RetrievalError('UNAUTHORIZED', '数值 ID 不属于当前授权范围。')
      const ref = TicketCandidateRef(shortOpaque('cand', request.snapshotId, r.ticketId)); entry.candidateRefs.set(ref, r); return ref
    })
    const rows = await this.readFeatures(principal, { snapshotId: request.snapshotId, candidateRefs: refs }, options)
    const byRef = new Map(rows.map(r => [r.ref, r])), dimensions = rows[0]?.vectors[0]?.length ?? 0
    const dense = Buffer.alloc(ids.length * dimensions * 4), available = Buffer.alloc(ids.length)
    refs.forEach((ref, i) => {
      const vector = byRef.get(ref)?.vectors[0]
      if (!vector?.length) return
      available[i] = 1
      vector.forEach((v, j) => dense.writeFloatLE(v, (i * dimensions + j) * 4))
    })
    const scores = await this.#featureScores(entry, ids, dense.toString('base64'), dimensions, request.rankingQuery, options?.signal)
    return { ids, row_groups: ids.map(i => ticketGroupHashes(entry.records[i]!)), dense: dense.toString('base64'), available: available.toString('base64'), dimensions,
      ...(scores ? { scores } : {}),
      feature_id: request.recallScope !== undefined ? sha256(stableJson({ index: entry.snapshot.indexVersion, recallScope: request.recallScope })) : entry.snapshot.indexVersion,
      next_cursor }
  }
  async featureAnchors(principal:TrustedPrincipalContext,request:Parameters<NonNullable<TicketRetrievalProvider['featureAnchors']>>[1],options?:ProviderCallOptions) {
    const block=await this.featureBlock(principal,{snapshotId:request.snapshotId,recallScope:request.recallScope,ids:[],limit:1},options)
    if(block.feature_id!==request.featureId) throw new RetrievalError('INVALID_REQUEST','Anchor feature identity differs from the actual completed recall scope')
    if(!this.#ranker.queryAnchors) throw new RetrievalError('PROVIDER_UNAVAILABLE','Pinned query anchors are unavailable')
    const anchors=await this.#ranker.queryAnchors(request.texts,options?.signal)
    this.#authorizeSnapshot(principal,request.snapshotId)
    const actual=sha256(stableJson({index:anchors.embedding_id,recallScope:request.recallScope}))
    if(actual!==block.feature_id || anchors.dimensions!==block.dimensions) throw new RetrievalError('PROVIDER_UNAVAILABLE','Anchor and feature block identities differ')
    return {...anchors,feature_id:block.feature_id,embedding_id:block.feature_id,
      profileIdentity:{...anchors.profileIdentity,base_embedding_id:anchors.embedding_id,recallScope:request.recallScope}}
  }
  async resolveFeatureIds(principal: TrustedPrincipalContext,
    request: Parameters<NonNullable<TicketRetrievalProvider['resolveFeatureIds']>>[1], options?: ProviderCallOptions) {
    const entry = this.#authorizeSnapshot(principal, request.snapshotId)
    const candidateRefs = request.ids.map(i => {
      const r = entry.records[i]
      if (!r || !canRead(r, principal)) throw new RetrievalError('UNAUTHORIZED', '数值 ID 不属于当前授权范围。')
      const ref = TicketCandidateRef(shortOpaque('cand', request.snapshotId, r.ticketId)); entry.candidateRefs.set(ref, r); return ref
    })
    return this.readCandidates(principal, { snapshotId: request.snapshotId, candidateRefs }, options)
  }
  async readCandidates(principal: TrustedPrincipalContext,
    request: { snapshotId: TicketSnapshotId; candidateRefs: readonly TicketCandidateRef[] }, options?: ProviderCallOptions): Promise<TicketCandidate[]> {
    options?.signal?.throwIfAborted()
    const entry = this.#authorizeSnapshot(principal, request.snapshotId)
    return request.candidateRefs.map(ref => {
      const r = entry.candidateRefs.get(ref)
      if (!r || !canRead(r, principal)) throw new RetrievalError('UNAUTHORIZED', '工单不属于授权全库。')
      return { ref, displayId: r.displayId, sourceVersion: r.sourceVersion, contentHash: r.contentHash,
        snapshotId: request.snapshotId, evidenceLevel: 'L1', projectionVersion: 2, rank: 0,
        title: r.title, summary: r.summary, summaryOrigin: overviewOrigin(r, 'summary'), titleOrigin: overviewOrigin(r, 'title'),
        l0: candidateL0(r), groupHashes: ticketGroupHashes(r), matchFragments: [], matchSignals: { channels: [], keywordTerms: [] } }
    })
  }
  async readDetails(principal: TrustedPrincipalContext, request: DetailReadRequest, options?: ProviderCallOptions): Promise<TicketDetailResult> {
    return projectDetails({ ...this.#authorizeSnapshot(principal, request.snapshotId), now: this.#now }, principal, request, options)
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
