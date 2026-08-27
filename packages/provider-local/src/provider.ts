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
  type TicketFilter,
  type TicketL0,
  type TicketProviderStatus,
  type TicketRetrievalProvider,
  type TicketRetrievalRequest,
  type TicketRetrievalSpec,
  type TicketSearchOptions,
  type TicketSearchPage,
  type TicketSnapshot,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { sha256, shortOpaque, stableJson } from './hash.js'
import { estimateTokens, tokenize, truncateToEstimatedTokens } from './text.js'

export interface LocalTicketProviderConfig {
  readonly providerId?: string
  readonly indexVersion?: string
  readonly queryPolicyVersion?: string
  readonly defaultRequestedCount?: number
  readonly maxRequestedCount?: number
  readonly snapshotTtlMs?: number
  readonly now?: () => Date
}

interface SnapshotEntry {
  readonly snapshot: TicketSnapshot
  readonly bindingHash: string
  readonly records: readonly NormalizedTicketRecord[]
  readonly candidateRefs: Map<string, NormalizedTicketRecord>
}

const COMPILER_VERSION = 'retrieval-query-v1'
const FIELD_SET = new Set<TicketEvidenceField>([
  'problemDescription', 'conversationOrUpdates', 'resolutionSteps', 'rootCause', 'answer',
])

function abortIfNeeded(options?: ProviderCallOptions): void {
  if (options?.signal?.aborted === true) throw new RetrievalError('CANCELLED', '操作已取消。')
}

function principalBinding(principal: TrustedPrincipalContext): string {
  const attributes = Object.fromEntries(Object.entries(principal.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, [...new Set(values)].sort()]))
  return sha256(stableJson({
    tenantId: principal.tenantId,
    subjectId: principal.subjectId,
    entitlementVersion: principal.entitlementVersion,
    attributes,
  }))
}

function canRead(record: NormalizedTicketRecord, principal: TrustedPrincipalContext): boolean {
  if (record.tenantId !== principal.tenantId) return false
  if (record.piiRedactionStatus === 'unreviewed') return false
  if (record.allowedSubjectIds.length > 0 && !record.allowedSubjectIds.includes(principal.subjectId)) return false
  for (const [attribute, required] of Object.entries(record.requiredAttributes)) {
    const actual = principal.attributes[attribute] ?? []
    if (required.length > 0 && !required.some(value => actual.includes(value))) return false
  }
  return true
}

function l0(record: NormalizedTicketRecord): TicketL0 {
  return {
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
    ...(record.type === undefined ? {} : { type: record.type }),
    ...(record.category === undefined ? {} : { category: record.category }),
    ...(record.product === undefined ? {} : { product: record.product }),
    ...(record.component === undefined ? {} : { component: record.component }),
    ...(record.region === undefined ? {} : { region: record.region }),
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.priority === undefined ? {} : { priority: record.priority }),
    ...(record.language === undefined ? {} : { language: record.language }),
  }
}

function filterValue(record: NormalizedTicketRecord, field: TicketFilter['field']): string | readonly string[] | undefined {
  switch (field) {
    case 'type': return record.type
    case 'category': return record.category
    case 'priority': return record.priority
    case 'status': return record.status
    case 'language': return record.language
    case 'region': return record.region
    case 'product': return record.product
    case 'component': return record.component
    case 'createdAt': return record.createdAt
    case 'updatedAt': return record.updatedAt
    case 'resolvedAt': return record.resolvedAt
    case 'errorCodes': return record.errorCodes
    default: return field satisfies never
  }
}

function matchesFilter(record: NormalizedTicketRecord, filter: TicketFilter): boolean {
  const actual = filterValue(record, filter.field)
  if (filter.op === 'contains') return actual !== undefined && typeof actual !== 'string'
    && actual.some(value => value.toLocaleLowerCase() === filter.value.toLocaleLowerCase())
  if (typeof actual !== 'string') return filter.op === 'neq'
  if (filter.op === 'eq') return actual.toLocaleLowerCase() === filter.value.toLocaleLowerCase()
  if (filter.op === 'neq') return actual.toLocaleLowerCase() !== filter.value.toLocaleLowerCase()
  if (filter.op === 'gte') return actual >= filter.value
  if (filter.op === 'lte') return actual <= filter.value
  return false
}

function scoreRecord(record: NormalizedTicketRecord, spec: TicketRetrievalSpec): number {
  const terms = tokenize(`${spec.normalizedQuery} ${spec.semanticHints.join(' ')}`)
  if (terms.length === 0) return 0
  const excluded = new Set(spec.excludedTerms.flatMap(tokenize))
  const titleTokens = tokenize(record.title)
  const summaryTokens = tokenize(record.summary)
  const metadataTokens = tokenize([
    record.product, record.component, record.category, record.type, record.region, record.status,
    ...record.errorCodes,
  ].filter((value): value is string => value !== undefined).join(' '))
  if ([...excluded].some(term => titleTokens.includes(term) || summaryTokens.includes(term))) return 0
  const title = new Set(titleTokens)
  const summary = new Set(summaryTokens)
  const metadata = new Set(metadataTokens)
  let score = 0
  for (const term of terms) {
    if (title.has(term)) score += 3
    if (summary.has(term)) score += 1.5
    if (metadata.has(term)) score += 0.75
  }
  return score / Math.sqrt(Math.max(1, terms.length))
}

function fragment(text: string, terms: readonly string[]): { text: string; truncated: boolean } | undefined {
  const normalized = text.toLocaleLowerCase()
  const position = terms.map(term => normalized.indexOf(term.toLocaleLowerCase())).filter(index => index >= 0).sort((a, b) => a - b)[0]
  if (position === undefined) return undefined
  const start = Math.max(0, position - 40)
  const end = Math.min(text.length, position + 100)
  return { text: text.slice(start, end), truncated: start > 0 || end < text.length }
}

function fieldValues(record: NormalizedTicketRecord, field: TicketEvidenceField): readonly string[] {
  switch (field) {
    case 'problemDescription': return record.problemDescription === undefined ? [] : [record.problemDescription]
    case 'conversationOrUpdates': return record.conversationOrUpdates
    case 'resolutionSteps': return record.resolutionSteps
    case 'rootCause': return record.rootCause === undefined ? [] : [record.rootCause]
    case 'answer': return record.answer === undefined ? [] : [record.answer]
    default: return field satisfies never
  }
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
  readonly #snapshots = new Map<string, SnapshotEntry>()

  constructor(records: readonly NormalizedTicketRecord[], config: LocalTicketProviderConfig = {}) {
    this.providerId = config.providerId ?? 'local-fixture-v1'
    this.#records = [...records]
    this.#indexVersion = config.indexVersion ?? sha256(records.map(record => `${record.ticketId}:${record.contentHash}`).sort().join('\n'))
    this.#queryPolicyVersion = config.queryPolicyVersion ?? 'query-policy-v1'
    this.#defaultRequestedCount = config.defaultRequestedCount ?? 5
    this.#maxRequestedCount = config.maxRequestedCount ?? 20
    this.#snapshotTtlMs = config.snapshotTtlMs ?? 15 * 60_000
    this.#now = config.now ?? (() => new Date())
    if (!Number.isSafeInteger(this.#defaultRequestedCount) || this.#defaultRequestedCount < 1) throw new TypeError('defaultRequestedCount must be positive')
    if (!Number.isSafeInteger(this.#maxRequestedCount) || this.#maxRequestedCount < this.#defaultRequestedCount) throw new TypeError('maxRequestedCount must cover the default')
    if (!Number.isSafeInteger(this.#snapshotTtlMs) || this.#snapshotTtlMs < 1) throw new TypeError('snapshotTtlMs must be positive')
  }

  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec {
    assertTicketRetrievalRequest(request)
    const requestedCount = Math.min(request.requestedCount ?? this.#defaultRequestedCount, this.#maxRequestedCount)
    return {
      target: request.target,
      ...(request.retrievalIntent === undefined ? {} : { retrievalIntent: request.retrievalIntent }),
      originalQuery: request.query,
      normalizedQuery: request.query.normalize('NFKC').trim().replace(/\s+/gu, ' '),
      requestedCount,
      mode: request.mode ?? 'keyword',
      filters: [...request.filters ?? []],
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
      authorizationVersion: principal.entitlementVersion,
      principalBindingHash: bindingHash,
      queryPolicyVersion: this.#queryPolicyVersion,
      capabilities: {
        exhaustive: true,
        pagination: true,
        evidencePromotion: true,
        detailRead: true,
        exportRead: true,
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
    if (!Number.isSafeInteger(options.topK) || options.topK < 1 || options.topK > this.#maxRequestedCount) throw new RetrievalError('INVALID_REQUEST', 'topK 无效。')
    if (!Number.isSafeInteger(options.maxScan) || options.maxScan < 1) throw new RetrievalError('INVALID_REQUEST', 'maxScan 无效。')
    const queryFingerprint = sha256(stableJson(query))
    const offset = this.#decodeCursor(options.cursor, snapshotId, queryFingerprint)
    const terms = tokenize(`${query.normalizedQuery} ${query.semanticHints.join(' ')}`)
    const filtered = entry.records.filter(record => query.filters.every(filter => matchesFilter(record, filter)))
    const scan = filtered.slice(0, options.maxScan)
    const scored = scan
      .map(record => ({ record, score: scoreRecord(record, query) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.record.displayId.localeCompare(right.record.displayId))
    const pageRecords = scored.slice(offset, offset + options.topK)
    const candidates = pageRecords.map(({ record }, index): TicketCandidate => {
      const ref = TicketCandidateRef(shortOpaque('cand', snapshotId, record.ticketId))
      entry.candidateRefs.set(ref, record)
      const titleFragment = fragment(record.title, terms)
      const summaryFragment = fragment(record.summary, terms)
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
        l0: l0(record),
        matchFragments: [
          ...(titleFragment === undefined ? [] : [{ field: 'title' as const, ...titleFragment }]),
          ...(summaryFragment === undefined ? [] : [{ field: 'summary' as const, ...summaryFragment }]),
        ],
      }
    })
    const nextOffset = offset + candidates.length
    const boundedByScan = filtered.length > scan.length
    const hasNext = nextOffset < scored.length
    return {
      snapshotId,
      queryFingerprint,
      candidates,
      completeness: boundedByScan || hasNext ? 'bounded' : 'exhaustive',
      ...(hasNext ? { nextCursor: this.#encodeCursor(nextOffset, snapshotId, queryFingerprint) } : {}),
      scanned: scan.length,
      returned: candidates.length,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      appliedFilters: [...query.filters],
      warnings: boundedByScan ? ['scan_limit_reached'] : [],
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
    for (const field of request.fields) if (!FIELD_SET.has(field)) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了不允许的详情字段。')
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
        for (const [part, value] of fieldValues(record, field).entries()) {
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
    for (const field of request.fields) if (!FIELD_SET.has(field)) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了不允许的详情字段。')
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
        const values = fieldValues(record, field)
        if (values.length === 0) unavailableFields.push(field)
        else fields[field] = [...values]
      }
      details.push({
        candidateRef: ref,
        displayId: record.displayId,
        sourceVersion: record.sourceVersion,
        title: record.title,
        summary: record.summary,
        l0: l0(record),
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

export function evidenceTextCost(record: NormalizedTicketRecord, fields: readonly TicketEvidenceField[]): number {
  return fields.reduce((total, field) => total + fieldValues(record, field).reduce((sum, value) => sum + estimateTokens(value), 0), 0)
}
