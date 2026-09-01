import { performance } from 'node:perf_hooks'
import {
  RetrievalError,
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
  type RetrievalRanker,
} from '@retrieval-agent/retrieval-ranking'
import { sha256, shortOpaque, stableJson } from './hash.js'
import { canRead, principalBinding } from './authorization.js'
import { evidenceFieldValues, LEGACY_FIELD_CATALOG } from './fields.js'
import { candidateL0, matchFragment, matchesFilter, rankingDocuments } from './search-projection.js'
import { tokenize, truncateToEstimatedTokens } from './text.js'

export interface LocalTicketProviderConfig {
  readonly providerId?: string
  readonly indexVersion?: string
  readonly queryPolicyVersion?: string
  readonly defaultRequestedCount?: number
  readonly maxRequestedCount?: number
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
  readonly #defaultRequestedCount: number
  readonly #maxRequestedCount: number
  readonly #snapshotTtlMs: number
  readonly #now: () => Date
  readonly #fieldCatalog: readonly TicketFieldDescriptor[]
  readonly #filterFields: ReadonlyMap<string, TicketFieldDescriptor>
  readonly #evidenceFields: ReadonlySet<string>
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
    this.#defaultRequestedCount = config.defaultRequestedCount ?? 5
    this.#maxRequestedCount = config.maxRequestedCount ?? 20
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
    this.#evidenceFields = new Set(this.#fieldCatalog.filter(field => field.accessLevel === 'L2').map(field => field.key))
    if (!Number.isSafeInteger(this.#defaultRequestedCount) || this.#defaultRequestedCount < 1) throw new TypeError('defaultRequestedCount must be positive')
    if (!Number.isSafeInteger(this.#maxRequestedCount) || this.#maxRequestedCount < this.#defaultRequestedCount) throw new TypeError('maxRequestedCount must cover the default')
    if (!Number.isSafeInteger(this.#snapshotTtlMs) || this.#snapshotTtlMs < 1) throw new TypeError('snapshotTtlMs must be positive')
  }

  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec {
    assertTicketRetrievalRequest(request)
    this.#assertFiltersSupported(request.filters ?? [])
    const requestedCount = Math.min(request.requestedCount ?? this.#defaultRequestedCount, this.#maxRequestedCount)
    const countPolicy = request.countPolicy ?? (request.requestedCount === undefined ? 'provider_default' : 'explicit')
    return {
      target: request.target,
      ...(request.retrievalIntent === undefined ? {} : { retrievalIntent: request.retrievalIntent }),
      originalQuery: request.query,
      normalizedQuery: (request.retrievalQuery ?? request.query).normalize('NFKC').trim().replace(/\s+/gu, ' '),
      requestedCount,
      countPolicy,
      mode: request.mode ?? this.#defaultMode,
      filters: [...request.filters ?? []],
      ...(request.queryContract?.logic === undefined
        ? {}
        : { requiredConcepts: request.queryContract.logic.requiredConcepts.map(concept => ({ ...concept, alternatives: [...concept.alternatives] })) }),
      ambiguities: [...request.ambiguities ?? []],
      excludedTerms: [],
      semanticHints: [],
      compilerVersion: COMPILER_VERSION,
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
    this.#snapshots.set(snapshotId, { snapshot, bindingHash, records, candidateRefs: new Map() })
    return snapshot
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
    if (!Number.isSafeInteger(options.topK) || options.topK < 1 || options.topK > this.#maxRequestedCount) throw new RetrievalError('INVALID_REQUEST', 'topK 无效。')
    if (!Number.isSafeInteger(options.maxScan) || options.maxScan < 1) throw new RetrievalError('INVALID_REQUEST', 'maxScan 无效。')
    const queryFingerprint = sha256(stableJson(query))
    const offset = this.#decodeCursor(options.cursor, snapshotId, queryFingerprint)
    const terms = tokenize(`${query.normalizedQuery} ${query.semanticHints.join(' ')} ${query.requiredConcepts?.flatMap(concept => concept.alternatives).join(' ') ?? ''}`)
    const filtered = entry.records.filter(record => query.filters.every(filter => matchesFilter(record, filter)))
    const documents = rankingDocuments(filtered)
    let ranked
    try {
      ranked = await this.#ranker.rank(documents, {
        text: query.normalizedQuery,
        semanticHints: query.semanticHints,
        excludedTerms: query.excludedTerms,
        ...(query.requiredConcepts === undefined ? {} : { requiredConcepts: query.requiredConcepts }),
        mode: query.mode,
      }, { maxScan: options.maxScan, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    } catch (error) {
      if (error instanceof RankingError && error.code === 'SCAN_LIMIT') {
        throw new RetrievalError('BUDGET_EXHAUSTED', '当前授权语料超过本地检索容量。', { cause: error })
      }
      if (error instanceof RankingError && error.code === 'HYBRID_UNAVAILABLE') {
        throw new RetrievalError('PROVIDER_UNAVAILABLE', '本地 Hybrid 检索模型不可用。', { retryable: true, cause: error })
      }
      throw error
    }
    const byId = new Map(filtered.map(record => [record.ticketId as string, record]))
    if (new Set(ranked.hits.map(hit => hit.documentId)).size !== ranked.hits.length
      || ranked.hits.some(hit => !byId.has(hit.documentId))) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '排名器返回了未授权或重复的文档。')
    }
    const pageHits = ranked.hits.slice(offset, offset + options.topK)
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
        rank: offset + index + 1,
        title: record.title,
        summary: record.summary,
        l0: candidateL0(record),
        matchFragments: [
          ...(titleFragment === undefined ? [] : [{ field: 'title' as const, ...titleFragment }]),
          ...(summaryFragment === undefined ? [] : [{ field: 'summary' as const, ...summaryFragment }]),
        ],
      }
    })
    const nextOffset = offset + candidates.length
    const hasNext = nextOffset < ranked.hits.length
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
    for (const field of request.fields) if (!this.#evidenceFields.has(field)) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了不允许的详情字段。')
    let remaining = request.tokenBudget
    let tokensUsed = 0
    const evidence: TicketEvidenceResult['evidence'][number][] = []
    const rejected: typeof request.candidateRefs[number][] = []
    for (const ref of request.candidateRefs) {
      abortIfNeeded(options)
      const record = entry.candidateRefs.get(ref)
      if (record === undefined || !canRead(record, principal)) {
        rejected.push(ref)
        continue
      }
      for (const field of request.fields) {
        for (const [part, value] of evidenceFieldValues(record, field).entries()) {
          if (remaining <= 0) break
          const selected = truncateToEstimatedTokens(value, remaining)
          if (selected.text.length === 0) continue
          const evidenceId = TicketEvidenceId(shortOpaque('ev', request.snapshotId, ref, field, String(part), record.contentHash))
          evidence.push({
            evidenceId,
            candidateRef: ref,
            displayId: record.displayId,
            sourceVersion: record.sourceVersion,
            contentHash: record.contentHash,
            field,
            text: selected.text,
            start: 0,
            end: selected.text.length,
            estimatedTokens: selected.tokens,
            trust: 'untrusted_ticket_evidence',
            truncated: selected.truncated,
          })
          remaining -= selected.tokens
          tokensUsed += selected.tokens
        }
      }
    }
    return {
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
    for (const field of request.fields) if (!this.#evidenceFields.has(field)) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了不允许的详情字段。')
    const details: TicketDetail[] = []
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
    return { snapshotId: request.snapshotId, details, rejectedCandidateRefs: rejected, warnings: [] }
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
