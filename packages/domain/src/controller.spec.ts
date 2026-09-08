import { describe, expect, it } from 'vitest'
import {
  RetrievalError,
  type RetrievalErrorCode,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketSnapshotId,
  type RetrievalDecision,
  type RetrievalState,
  type TicketRetrievalProvider,
  type TicketRetrievalMode,
  type TicketSearchStage,
  type TicketSearchTrace,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { createTicketResultCollection } from './result.js'
import { EvidenceContextPolicy } from './context.js'
import { RetrievalController } from './controller.js'
import { InMemoryRetrievalEventJournal } from './journal.js'
import { foldRetrievalEvents } from './replay.js'

const NOW = new Date('2026-08-27T02:00:00.000Z')
const CANDIDATE_REF = TicketCandidateRef('cand-1')
const SECOND_CANDIDATE_REF = TicketCandidateRef('cand-2')
const THIRD_CANDIDATE_REF = TicketCandidateRef('cand-3')
const EVIDENCE_ID = TicketEvidenceId('evidence-1')

function searchTrace(
  stage: TicketSearchStage,
  requestedMode: TicketRetrievalMode,
  candidateRefs: readonly TicketCandidateRef[],
): TicketSearchTrace {
  return {
    stage,
    requestedMode,
    executedMode: requestedMode,
    strategyVersion: 'stub-hybrid-v1',
    channels: [
      { channel: 'keyword', implementation: 'stub-bm25f', version: 'stub-bm25f-v1', resultCount: candidateRefs.length, elapsedMs: 2 },
      {
        channel: 'vector', implementation: 'stub-dense', version: 'stub-dense-v1',
        model: 'stub-embedding', revision: 'stub-revision-v1', dimensions: 4,
        resultCount: candidateRefs.length, elapsedMs: 3,
      },
    ],
    fusion: {
      method: 'weighted_rrf', version: 'stub-rrf-v1', rankConstant: 60,
      keywordWeight: 0.5, vectorWeight: 0.5,
    },
    signals: candidateRefs.map((candidateRef, index) => ({
      candidateRef,
      finalRank: index + 1,
      fusedScore: 1 / (61 + index),
      channels: [
        { channel: 'keyword', rank: index + 1, score: 1 / (index + 1) },
        { channel: 'vector', rank: index + 1, score: 1 / (index + 1) },
      ],
    })),
  }
}

const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo',
  subjectId: 'support-user',
  entitlementVersion: 'entitlements-v1',
  purpose: 'ticket_retrieval',
  attributes: { group: ['support'] },
  issuedAt: '2026-08-27T00:00:00.000Z',
  expiresAt: '2026-08-28T00:00:00.000Z',
}

function provider(): TicketRetrievalProvider {
  return {
    providerId: 'stub-v1',
    resolve(request) {
      return {
        target: request.target,
        originalQuery: request.query,
        normalizedQuery: request.query.trim(),
        ...(request.requestedCount === undefined ? {} : { requestedCount: request.requestedCount }),
        countPolicy: request.countPolicy ?? (request.requestedCount === undefined ? 'adaptive' : 'explicit'),
        mode: request.mode ?? 'keyword',
        filters: request.filters ?? [],
        ambiguities: request.ambiguities ?? [],
        excludedTerms: [],
        semanticHints: [],
        compilerVersion: 'stub-query-v1',
      }
    },
    async openSnapshot() {
      return {
        snapshotId: TicketSnapshotId('snapshot-1'),
        shortId: 'snap-1',
        providerId: 'stub-v1',
        createdAt: NOW.toISOString(),
        expiresAt: '2026-08-28T00:00:00.000Z',
        sourceVersion: 'source-v1',
        indexVersion: 'index-v1',
        retrievalProfileVersion: 'stub-hybrid-v1',
        authorizationVersion: 'entitlements-v1',
        principalBindingHash: 'principal-binding',
        queryPolicyVersion: 'query-v1',
        fieldCatalog: [
          { key: 'problemDescription', label: 'problemDescription', valueKind: 'text', accessLevel: 'L2', filterOperators: [], sensitivity: 'source_controlled' },
        ],
        capabilities: {
          exhaustive: true,
          pagination: false,
          evidencePromotion: true,
          detailRead: true,
          exportRead: true,
          keywordSearch: true,
          denseSearch: true,
          hybridFusion: true,
          reranking: false,
        },
      }
    },
    async search(_principal, snapshotId, query, options) {
      return {
        snapshotId,
        queryFingerprint: 'query-fingerprint',
        candidates: [{
          ref: CANDIDATE_REF,
          displayId: 'INC-1',
          sourceVersion: 'source-v1',
          snapshotId,
          contentHash: 'content-hash-1',
          evidenceLevel: 'L2',
          rank: 1,
          title: '登录失败',
          summary: '验证码缓存异常导致登录失败。',
          l0: { category: '认证', priority: 'P1' },
          matchFragments: [{ field: 'title', text: '登录失败', truncated: false }],
        }],
        completeness: 'exhaustive',
        scanned: 1,
        returned: 1,
        elapsedMs: 7,
        appliedFilters: query.filters,
        warnings: [],
        trace: searchTrace(options.stage, query.mode, [CANDIDATE_REF]),
        boundary: {
          authorizedCorpusSize: 1,
          documentsAfterStructuredFilters: 1,
          documentsEligibleForKeywordChannel: 1,
          rankedHits: 1,
          resultPagesExhausted: true,
          semanticRecallKnown: false,
        },
      }
    },
    async readEvidence(_principal, request) {
      return {
        snapshotId: request.snapshotId,
        evidence: [{
          evidenceId: EVIDENCE_ID,
          candidateRef: CANDIDATE_REF,
          displayId: 'INC-1',
          sourceVersion: 'source-v1',
          contentHash: 'content-hash-1',
          field: 'problemDescription',
          text: '验证码缓存键未包含时区。',
          start: 0,
          end: '验证码缓存键未包含时区。'.length,
          estimatedTokens: 13,
          trust: 'untrusted_ticket_evidence',
          truncated: false,
        }],
        requestedCandidateRefs: request.candidateRefs,
        rejectedCandidateRefs: [],
        tokenBudget: request.tokenBudget,
        tokensUsed: 13,
        warnings: [],
      }
    },
    async readDetails(_principal, request) {
      return { snapshotId: request.snapshotId, details: [], rejectedCandidateRefs: request.candidateRefs, warnings: [] }
    },
    async status() {
      return { providerId: 'stub-v1', ready: true, readOnly: true, snapshotValid: true, warnings: [] }
    },
  }
}

function dynamicFacetProvider(completeness: 'bounded' | 'exhaustive' = 'exhaustive'): TicketRetrievalProvider {
  const base = provider()
  return {
    ...base,
    async openSnapshot(principal, options) {
      const snapshot = await base.openSnapshot(principal, options)
      return {
        ...snapshot,
        fieldCatalog: [
          ...snapshot.fieldCatalog,
          { key: 'source.queue', label: '来源队列', valueKind: 'keyword', accessLevel: 'L0', filterOperators: ['eq'], sensitivity: 'source_controlled' },
        ],
      }
    },
    async search(principal, snapshotId, query, options) {
      const page = await base.search(principal, snapshotId, query, options)
      const first = page.candidates[0]
      if (first === undefined) throw new Error('stub candidate missing')
      return {
        ...page,
        candidates: [
          { ...first, l0: { ...first.l0, additionalFields: [{ key: 'source.queue', label: '来源队列', value: 'billing', sourcePath: '$.queue' }] } },
          {
            ...first,
            ref: SECOND_CANDIDATE_REF,
            displayId: 'INC-2',
            contentHash: 'content-hash-2',
            rank: 2,
            l0: { ...first.l0, additionalFields: [{ key: 'source.queue', label: '来源队列', value: 'technical', sourcePath: '$.queue' }] },
          },
        ],
        completeness,
        scanned: 2,
        returned: 2,
        trace: searchTrace(options.stage, query.mode, [CANDIDATE_REF, SECOND_CANDIDATE_REF]),
        boundary: {
          authorizedCorpusSize: 2,
          documentsAfterStructuredFilters: 2,
          documentsEligibleForKeywordChannel: 2,
          rankedHits: 2,
          resultPagesExhausted: true,
          semanticRecallKnown: false,
        },
      }
    },
  }
}

function paginatedProvider(firstPage: {
  readonly completeness: 'bounded' | 'exhaustive'
  readonly nextCursor?: string
} = { completeness: 'bounded', nextCursor: 'cursor-page-2' }): TicketRetrievalProvider {
  const base = provider()
  return {
    ...base,
    async openSnapshot(principal, options) {
      const snapshot = await base.openSnapshot(principal, options)
      return { ...snapshot, capabilities: { ...snapshot.capabilities, pagination: true } }
    },
    async search(principal, snapshotId, query, options) {
      const page = await base.search(principal, snapshotId, query, options)
      if (options.cursor === undefined) {
        return {
          ...page,
          completeness: firstPage.completeness,
          ...(firstPage.nextCursor === undefined ? {} : { nextCursor: firstPage.nextCursor }),
          boundary: { ...page.boundary, resultPagesExhausted: firstPage.nextCursor === undefined },
        }
      }
      return {
        ...page,
        candidates: [],
        completeness: 'exhaustive',
        returned: 0,
        trace: searchTrace(options.stage, query.mode, []),
        boundary: { ...page.boundary, resultPagesExhausted: true },
      }
    },
  }
}

function accumulatingProvider(): TicketRetrievalProvider {
  const base = provider()
  return {
    ...base,
    async search(principal, snapshotId, query, options) {
      const page = await base.search(principal, snapshotId, query, options)
      const first = page.candidates[0]
      if (first === undefined) throw new Error('stub candidate missing')
      const candidate = options.stage === 'initial_hybrid'
        ? first
        : options.stage === 'repair_search' && query.mode === 'keyword'
          ? { ...first, ref: SECOND_CANDIDATE_REF, displayId: 'INC-2', contentHash: 'content-hash-2' }
          : { ...first, ref: THIRD_CANDIDATE_REF, displayId: 'INC-3', contentHash: 'content-hash-3' }
      return {
        ...page,
        candidates: [{ ...candidate, rank: 1 }],
        completeness: 'bounded',
        trace: searchTrace(options.stage, query.mode, [candidate.ref]),
      }
    },
  }
}

function deterministicIds(): () => string {
  let value = 0
  return () => `id-${value++}`
}

function rawFieldDeclaredProvider(reads: string[]): TicketRetrievalProvider {
  const base = provider()
  return {
    ...base,
    async openSnapshot(principal, options) {
      const snapshot = await base.openSnapshot(principal, options)
      return {
        ...snapshot,
        fieldCatalog: [
          ...snapshot.fieldCatalog,
          { key: 'source.raw', label: '原始对话', valueKind: 'raw_json', accessLevel: 'L3', filterOperators: [], sensitivity: 'source_controlled' },
        ],
      }
    },
    async readEvidence(principal, request, options) {
      reads.push(...request.fields)
      return base.readEvidence(principal, request, options)
    },
  }
}


function setup(source = provider(), config: ConstructorParameters<typeof RetrievalController>[3] = {}) {
  const ids = deterministicIds()
  const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
  const controller = new RetrievalController(source, journal, undefined, { now: () => NOW, id: ids, ...config })
  return { controller, journal }
}
function visible(controller: RetrievalController, state: RetrievalState): RetrievalState {
  return controller.recordContextSelection(state, controller.projectContext(state))
}
function accept(ref: TicketCandidateRef) {
  return { candidateRef: ref, verdict: 'accept' as const, evidenceRefs: [ref], reason: 'The delivered summary matches the fixture task.' }
}

describe('RetrievalController', () => {
  it('withdraws adopted judgments on emergency knowledge invalidation and rejects late branch writes', async () => {
    const { controller, journal } = setup()
    let state = visible(controller, await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录 验证码' }))
    state = controller.expertUpdate(state, 0, { kind: 'catalog', catalog: { status: 'empty', domains: [] } })
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [accept(CANDIDATE_REF)], gaps: [],
      action: { kind: 'delegate', assignments: [{ domainId: 'general', goal: '复核依据', scope: '验证码', candidateRefs: [CANDIDATE_REF] }] } })
    const taskId = state.expertTasks![0]!.id
    state = controller.expertUpdate(state, 0, { kind: 'task', taskId, patch: { status: 'running', knowledgeRefs: ['wiki:prior:entry@2'] } })
    const previousStateId = state.stateId
    state = controller.expertUpdate(state, 0, { kind: 'knowledge_invalidated', references: ['wiki:prior:entry@2'],
      catalog: { status: 'empty', domains: [], warning: '知识已停用' } })
    expect(state.selectedCandidateRefs).toEqual([])
    expect(state.judgments).toEqual([])
    expect(state.expertTasks![0]).toMatchObject({ status: 'failed' })
    expect(() => controller.expertUpdate(state, 0, { kind: 'task', taskId, patch: { status: 'running' } })).toThrow(/迟到/)
    expect(() => controller.expertUpdate(state, 0, { kind: 'finding', finding: { id: 'late', taskId, inputGeneration: 0,
      judgments: [accept(CANDIDATE_REF)], gaps: [], counterEvidenceRefs: [], nextAction: '完成' } })).toThrow(/不再运行/)
    await expect(controller.decide(PRINCIPAL, state, { stateId: previousStateId, judgments: [accept(CANDIDATE_REF)], gaps: [],
      action: { kind: 'finish', explanation: '旧判断' } })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })
  it('searches real hybrid candidates before model work and freezes a supported summary result with exact replay', async () => {
    const { controller, journal } = setup()
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录 验证码' })
    expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
    expect(state.budget).toMatchObject({ modelStepsUsed: 0, searchesUsed: 1, providerLatencyMs: 7, wallClockElapsedMs: 0 })
    state = visible(controller, state)
    expect(controller.projectContext(state).rendered).toContain('验证码缓存异常导致登录失败')
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId,
      judgments: [accept(CANDIDATE_REF)], gaps: [{ kind: 'coverage', status: 'resolved', evaluator: 'model', evidenceRefs: [CANDIDATE_REF], description: 'The shown candidate meets this task.' }], action: { kind: 'finish', explanation: 'The authorized summary is sufficient.' } })
    expect(state.termination).toBe('top_k_accepted')
    expect(state.frozenEvidence?.candidates[0]).toMatchObject({ displayId: 'INC-1', evidenceLevel: 'L1' })
    expect(state.frozenEvidence).toMatchObject({ semanticRecallKnown: false, resultPagesExhausted: true, complete: false })
    const events = journal.read(state.retrievalId)
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index))
    expect(foldRetrievalEvents(events, state.retrievalId)).toEqual(state)
  })

  it('rejects whole raw payload inspection even when the source field catalog declares raw data', async () => {
    const reads: string[] = []
    const { controller, journal } = setup(rawFieldDeclaredProvider(reads))
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = visible(controller, state)
    await expect(controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [],
      gaps: [{ kind: 'depth', status: 'open', evaluator: 'model', evidenceRefs: [CANDIDATE_REF], description: 'Need source details.' }],
      action: { kind: 'inspect', candidateRefs: [CANDIDATE_REF], fields: ['source.raw'] },
    })).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
    expect(reads).toEqual([])
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })

  it('keeps explicit result quantity and Provider page width independent for every task type', async () => {
    const windows: number[] = []; const base = provider()
    const { controller } = setup({ ...base, async search(principal, snapshotId, query, options) {
      windows.push(options.topK); return base.search(principal, snapshotId, query, options)
    } }, { searchTopK: 20 })
    const adaptive = await controller.start(PRINCIPAL, { target: 'cohort_collection', query: '登录', countPolicy: 'adaptive' })
    const explicit = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录', requestedCount: 200, countPolicy: 'explicit' })
    expect(adaptive.task).toMatchObject({ countPolicy: 'adaptive', completenessRequirement: 'top_k' })
    expect(adaptive.query.contract).toMatchObject({ schemaVersion: 8, resultPolicy: 'adaptive_top_k' })
    expect(explicit.task.requestedCount).toBe(200)
    expect(windows).toEqual([20, 20])
  })

  it('rejects corrupt event chains and unsupported historical schemas', async () => {
    const { controller, journal } = setup()
    const state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    const events = journal.read(state.retrievalId)
    expect(() => foldRetrievalEvents(events.map((event, index) => index === 1 ? { ...event, sequence: 4 } : event))).toThrow(/序列不连续/u)
    expect(() => foldRetrievalEvents(events.map(event => ({ ...event, schemaVersion: 4 })) as unknown as typeof events)).toThrow(/不支持检索事件版本 4/u)
  })

  it('stops explicitly on Provider identity mismatch instead of accepting escaped candidates', async () => {
    const base = provider()
    const { controller } = setup({ ...base, async search(principal, snapshotId, query, options) {
      return { ...await base.search(principal, snapshotId, query, options), snapshotId: TicketSnapshotId('other-snapshot') }
    } })
    const state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    expect(state).toMatchObject({ phase: 'stopped', termination: 'backend_error', candidates: [] })
  })

  it('preserves the provider failure identity behind a backend stop', async () => {
    const cases = [
      ['TIMEOUT', 'RAG 排名请求超时。'],
      ['PROVIDER_UNAVAILABLE', '本地 Hybrid 检索模型不可用。'],
      ['PROTOCOL_MISMATCH', 'RAG 排名服务返回了越界或无效结果。'],
    ] as const satisfies readonly (readonly [RetrievalErrorCode, string])[]
    for (const [code, message] of cases) {
      const base = provider()
      const { controller, journal } = setup({ ...base, async search() {
        throw new RetrievalError(code, message, { retryable: true })
      } })
      const state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
      expect(state).toMatchObject({ phase: 'stopped', termination: 'backend_error', stopErrorCode: code, stopExplanation: message })
      const events = journal.read(state.retrievalId)
      expect(events.find(event => event.type === 'retrieval/stopped')?.data)
        .toMatchObject({ reason: 'backend_error', errorCode: code })
      expect(foldRetrievalEvents(events, state.retrievalId)).toEqual(state)
    }
  })

  it('preserves the failure identity when a later search action times out', async () => {
    const base = provider()
    const { controller } = setup({ ...base, async search(principal, snapshotId, query, options) {
      if (options.stage === 'repair_search') throw new RetrievalError('TIMEOUT', 'RAG 排名请求超时。', { retryable: true })
      return base.search(principal, snapshotId, query, options)
    } })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = visible(controller, state)
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'search', mode: 'keyword', delta: { kind: 'add_terms', terms: ['缓存'] } } })
    expect(state).toMatchObject({ phase: 'stopped', termination: 'backend_error',
      stopErrorCode: 'TIMEOUT', stopExplanation: 'RAG 排名请求超时。' })
  })

  it('keeps searches available regardless of measured model steps and wall-clock time', async () => {
    const { controller } = setup(provider())
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = visible(controller, state)
    for (let step = 0; step < 20; step += 1) {
      state = controller.recordModelRequest(state, { estimatedInputTokens: 100, serializationBytes: 400, wallClockElapsedMs: 600_000 + step, accepted: true })
    }
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'search', mode: 'keyword', delta: { kind: 'add_terms', terms: ['缓存'] } } })
    expect(state.phase).not.toBe('stopped')
    expect(state.budget).toMatchObject({ modelStepsUsed: 20, searchesUsed: 2, wallClockElapsedMs: 600_019 })
  })

  it('stops a search beyond the Provider page ceiling and preserves valid unjudged candidates as undetermined', async () => {
    const { controller } = setup(provider(), { maxSearches: 1 })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = visible(controller, state)
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'search', mode: 'keyword', delta: { kind: 'add_terms', terms: ['缓存'] } } })
    expect(state.termination).toBe('budget_exhausted')
    expect(createTicketResultCollection(state)).toMatchObject({ tickets: [] })
    expect(createTicketResultCollection(state)).not.toHaveProperty('undeterminedCandidates')
    expect(state.candidates.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF])
  })

  it('asks from actual visible differences, preserves a free reply and excludes long waiting from online time', async () => {
    let clock = NOW
    const { controller, journal } = setup(dynamicFacetProvider(), { now: () => clock })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '账号问题' })
    const question: RetrievalDecision = { stateId: state.stateId, judgments: [],
      gaps: [{ kind: 'ambiguity', status: 'open', evaluator: 'model', evidenceRefs: [CANDIDATE_REF, SECOND_CANDIDATE_REF] }],
      action: { kind: 'clarify', question: '您要找计费队列还是技术支持队列？', facet: 'source.queue',
        candidateRefs: [CANDIDATE_REF, SECOND_CANDIDATE_REF], evidenceRefs: [CANDIDATE_REF, SECOND_CANDIDATE_REF] } }
    await expect(controller.decide(PRINCIPAL, state, question)).rejects.toThrow(/尚未收到/u)
    state = visible(controller, state)
    state = await controller.decide(PRINCIPAL, state, { ...question, stateId: state.stateId })
    expect(state).toMatchObject({ phase: 'awaiting_clarification', termination: 'needs_clarification' })
    clock = new Date(NOW.getTime() + 3 * 86_400_000)
    state = await controller.resumeClarification(PRINCIPAL, state, { accepted: true, answer: '应该是技术支持，但是也可能不确定' })
    expect(state.clarification?.answer).toBe('应该是技术支持，但是也可能不确定')
    expect(state.query.spec.filters).toEqual([])
    expect(state.executionClock).toEqual({ totalWaitingMs: 3 * 86_400_000 })
    expect(state.allowedActions.some(action => action.kind === 'assess')).toBe(true)
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })

  it('requires one typed delta or cursor and applies one atomic batch through the actual Provider', async () => {
    const observed: unknown[] = []; const base = provider()
    const { controller } = setup({ ...base, async search(principal, snapshotId, query, options) {
      observed.push(query.filters); return base.search(principal, snapshotId, query, options)
    } })
    let state = await controller.start(PRINCIPAL, { target: 'constrained_list', query: '副卡' })
    await expect(controller.search(PRINCIPAL, state, { mode: 'keyword' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(controller.search(PRINCIPAL, state, { mode: 'keyword', delta: { kind: 'add_terms', terms: ['缓存'] }, cursor: 'forged' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'search', mode: 'keyword', delta: { kind: 'batch', changes: [
        { kind: 'add_filter', filter: { field: 'createdAt', op: 'gte', value: '2026-07-01T00:00:00.000Z' } },
        { kind: 'add_filter', filter: { field: 'createdAt', op: 'lte', value: '2026-09-01T00:00:00.000Z' } },
        { kind: 'add_filter', filter: { field: 'region', op: 'eq', value: '上海' } },
      ] } } })
    expect(observed).toHaveLength(2)
    expect(observed[0]).toEqual([])
    expect(observed[1]).toEqual(state.query.confirmedConstraints)
    expect(state.query.confirmedConstraints).toHaveLength(3)
  })

  it('retains acquisition history and adjusts ranking for same-scope keyword and vector repairs', async () => {
    const { controller } = setup(accumulatingProvider())
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = visible(controller, state)
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId,
      judgments: [{ candidateRef: CANDIDATE_REF, verdict: 'exclude', evidenceRefs: [CANDIDATE_REF], reason: 'The summary shows the other business queue.' }], gaps: [],
      action: { kind: 'search', mode: 'keyword', delta: { kind: 'add_terms', terms: ['验证码'] } } })
    expect(state.candidates.map(candidate => candidate.ref)).toEqual([SECOND_CANDIDATE_REF, CANDIDATE_REF])
    expect(state.excludedCandidateRefs).toEqual([CANDIDATE_REF])
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'search', mode: 'dense', delta: { kind: 'semantic_hint', text: '缓存失效' } } })
    expect(state.candidateHistory.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF, SECOND_CANDIDATE_REF, THIRD_CANDIDATE_REF])
    expect(state.candidates.map(candidate => candidate.ref)).toEqual([SECOND_CANDIDATE_REF, THIRD_CANDIDATE_REF, CANDIDATE_REF])
  })

  it('cannot claim an explicit quantity is satisfied by a short exhausted prefix', async () => {
    const { controller } = setup()
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录', requestedCount: 3, countPolicy: 'explicit' })
    state = visible(controller, state)
    const proposed: RetrievalDecision = { stateId: state.stateId, judgments: [accept(CANDIDATE_REF)], gaps: [],
      action: { kind: 'finish', reason: 'satisfied', explanation: 'Only one relevant case exists in this query scope' } }
    await expect(controller.decide(PRINCIPAL, state, proposed)).rejects.toThrow(/数量或范围要求尚未满足/u)
    state = await controller.decide(PRINCIPAL, state, { ...proposed, action: { kind: 'finish', reason: 'incomplete', explanation: 'Requested three; this exhausted query returned one supported case.' } })
    expect(createTicketResultCollection(state)).toMatchObject({ stoppingReason: 'partial', tickets: [{ ref: CANDIDATE_REF }], resultPagesExhausted: true, semanticRecallKnown: false })
  })

  it('keeps exhaustive work open until ranking pages and candidate judgments are complete', async () => {
    const { controller } = setup(paginatedProvider())
    let state = await controller.start(PRINCIPAL, { target: 'cohort_collection', query: '登录', countPolicy: 'exhaustive' })
    state = visible(controller, state)
    const intent: RetrievalDecision = { stateId: state.stateId, judgments: [accept(CANDIDATE_REF)], gaps: [], action: { kind: 'finish', explanation: 'Done' } }
    await expect(controller.decide(PRINCIPAL, state, intent)).rejects.toThrow(/范围要求尚未满足/u)
    state = await controller.decide(PRINCIPAL, state, { ...intent, action: { kind: 'search', continueRanking: true } })
    expect(state.candidates.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF])
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [], action: { kind: 'finish', explanation: 'All available pages and candidates were checked' } })
    expect(createTicketResultCollection(state)).toMatchObject({ resultPagesExhausted: true, semanticRecallKnown: false, complete: false, tickets: [{ ref: CANDIDATE_REF }] })
  })

  it('keeps a safety stop honest and makes a repeated revoked-access presentation idempotent', async () => {
    let revoked = false; const base = provider()
    const { controller } = setup({ ...base, async status() { if (revoked) throw new RetrievalError('UNAUTHORIZED', 'revoked'); return base.status(PRINCIPAL) } })
    const initial = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    let state = controller.freezeForInterruption(initial, 'budget_exhausted')
    expect(createTicketResultCollection(state)).toMatchObject({ tickets: [], stoppingReason: 'budget_exhausted' })
    expect(state.candidates.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF])
    revoked = true
    state = await controller.reauthorize(PRINCIPAL, state)
    expect(state).toMatchObject({ termination: 'permission_blocked', candidates: [], promotedEvidence: [] })
    expect(await controller.reauthorize(PRINCIPAL, state)).toBe(state)
    expect(() => controller.projectContext(state)).toThrow(/尚未重新授权/u)
  })

  it('withdraws presentation authorization when a Provider fails without a structured error', async () => {
    let unavailable = false; const base = provider()
    const { controller, journal } = setup({ ...base,
      async status() { if (unavailable) throw new Error('internal transport failure'); return base.status(PRINCIPAL) },
    })
    const initial = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    unavailable = true
    const inaccessible = await controller.reauthorize(PRINCIPAL, initial)
    expect(inaccessible).toMatchObject({ accessValidation: 'required', termination: 'backend_error',
      stopExplanation: '工单数据源当前不可用。' })
    expect(() => controller.projectContext(inaccessible)).toThrow(/尚未重新授权/u)
    expect(await controller.reauthorize(PRINCIPAL, inaccessible)).toBe(inaccessible)
    expect(foldRetrievalEvents(journal.read(initial.retrievalId), initial.retrievalId)).toEqual(inaccessible)
  })
  it('accepts only delivered candidates and keeps a model decision valid through measurement-only revisions', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(dynamicFacetProvider(), journal, new EvidenceContextPolicy({ maxCandidates: 1 }), { now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '账号问题' })
    state = controller.recordContextSelection(state, controller.projectContext(state))
    const visibleStateId = state.stateId
    const input: RetrievalDecision = {
      stateId: visibleStateId,
      judgments: [{ candidateRef: SECOND_CANDIDATE_REF, verdict: 'accept', evidenceRefs: [SECOND_CANDIDATE_REF], reason: 'matches the requested queue' }],
      gaps: [], action: { kind: 'finish', reason: 'satisfied', explanation: 'Found a supported case' },
    }
    await expect(controller.decide(PRINCIPAL, state, input)).rejects.toThrow(/尚未收到/u)
    state = controller.recordModelRequest(state, { estimatedInputTokens: 100, serializationBytes: 400, wallClockElapsedMs: 1, accepted: true })
    state = controller.recordModelResponse(state, { modelLatencyMs: 4, outputTokens: 80, wallClockElapsedMs: 5 })
    state = await controller.decide(PRINCIPAL, state, { ...input, judgments: [{
      candidateRef: CANDIDATE_REF, verdict: 'accept', evidenceRefs: [CANDIDATE_REF], reason: 'the visible summary addresses this account problem',
    }] })
    const collection = createTicketResultCollection(state)
    expect(collection.tickets.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF])
    expect(collection).not.toHaveProperty('undeterminedCandidates')
    expect(state.candidates.map(candidate => candidate.ref)).toContain(SECOND_CANDIDATE_REF)
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })

  it('records controlled reads in authoritative evidence and requires actual model delivery before citing them', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, { now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '验证码' })
    state = controller.recordContextSelection(state, controller.projectContext(state))
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [],
      gaps: [{ kind: 'depth', status: 'open', evaluator: 'model', evidenceRefs: [CANDIDATE_REF], description: 'Need the actual failure cause' }],
      action: { kind: 'inspect', candidateRefs: [CANDIDATE_REF], fields: ['problemDescription'] },
    })
    expect(state.promotedEvidence[0]).toMatchObject({ evidenceId: EVIDENCE_ID, evidenceLevel: 'L2', readers: ['provider'] })
    const finish = (): RetrievalDecision => ({ stateId: state.stateId, judgments: [{ candidateRef: CANDIDATE_REF,
      verdict: 'accept', evidenceRefs: [EVIDENCE_ID], reason: 'The authorized body proves the cache key problem' }],
      gaps: [{ kind: 'depth', status: 'resolved', evaluator: 'model', evidenceRefs: [EVIDENCE_ID] }],
      action: { kind: 'finish', reason: 'satisfied', explanation: 'The actual body confirms the cause' } })
    await expect(controller.decide(PRINCIPAL, state, finish())).rejects.toThrow(/尚未收到/u)
    state = controller.recordContextSelection(state, controller.projectContext(state))
    state = await controller.decide(PRINCIPAL, state, finish())
    expect(state.frozenEvidence?.candidates[0]).toMatchObject({ evidenceLevel: 'L2', evidenceIds: [EVIDENCE_ID] })
    expect(createTicketResultCollection(state).evidence[0]?.readers).toContain('model')
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })

  it('keeps an authorized user detail read consistent with frozen evidence without claiming the model read it', async () => {
    const source = provider()
    const { controller, journal } = setup(source)
    let state = visible(controller, await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '验证码' }))
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [accept(CANDIDATE_REF)], gaps: [],
      action: { kind: 'finish', explanation: 'Summary establishes relevance; detailed handling remains available to the user.' } })
    const originalPack = state.frozenEvidence!
    const receipt = { readId: 'detail-1', retrievalId: state.retrievalId, snapshotShortId: state.snapshot!.shortId,
      candidateRefs: [CANDIDATE_REF], fields: ['problemDescription'], readAt: NOW.toISOString(), auditId: 'audit-1' }
    const result = await source.readEvidence(PRINCIPAL, { snapshotId: state.snapshot!.snapshotId,
      candidateRefs: receipt.candidateRefs, fields: receipt.fields, tokenBudget: 1000 })
    const candidate = state.candidates[0]!
    const detail = { candidateRef: candidate.ref, displayId: candidate.displayId, sourceVersion: candidate.sourceVersion,
      title: candidate.title, summary: candidate.summary, l0: candidate.l0,
      fields: { problemDescription: [result.evidence[0]!.text] }, unavailableFields: [] }
    const details = { snapshotId: state.snapshot!.snapshotId, details: [detail], evidence: result.evidence,
      rejectedCandidateRefs: [], warnings: [] }
    expect(() => controller.recordDetailRead(state, receipt, { ...details, evidence: [] })).toThrow(/缺少实际可见正文/u)
    expect(() => controller.recordDetailRead(state, receipt, { ...details, evidence: [
      { ...result.evidence[0]!, text: '替换过的正文', end: '替换过的正文'.length },
    ] })).toThrow(/实际可见字段/u)
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)

    state = controller.recordDetailRead(state, receipt, details)
    expect(state.promotedEvidence[0]).toMatchObject({ readers: ['provider', 'user'] })
    expect(state.modelVisibleEvidenceIds).toEqual([])
    expect(state.frozenEvidence).toEqual(originalPack)
    expect(originalPack.candidates[0]?.evidenceIds).toEqual([])
    expect(createTicketResultCollection(state).evidence).toEqual([])
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })

  it('retains new user constraints in state and replay when their immediate requalification fails', async () => {
    const source = dynamicFacetProvider()
    const { controller, journal } = setup({ ...source, async search(principal, snapshotId, query, options) {
      if (options.stage === 'repair_search') throw new RetrievalError('PROVIDER_UNAVAILABLE', '工单搜索当前无法完成。')
      return source.search(principal, snapshotId, query, options)
    } })
    const state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    const updated = await controller.applyUserFeedback(PRINCIPAL, state, { accepted: true, answer: '只看技术支持队列',
      filters: [{ field: 'source.queue', op: 'eq', value: '技术支持' }] })
    expect(updated).toMatchObject({ termination: 'backend_error', stopExplanation: '工单搜索当前无法完成。', candidates: [],
      query: { confirmedConstraints: [{ field: 'source.queue', op: 'eq', value: '技术支持' }] },
      userFeedback: [{ text: '只看技术支持队列' }] })
    expect(updated.candidateHistory.length).toBe(2)
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(updated)
  })

  it('does not commit a rejected action and can continue the same durable state', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, { now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录', filters: [{ field: 'region', op: 'eq', value: '上海' }] })
    state = controller.recordContextSelection(state, controller.projectContext(state))
    await expect(controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'search', mode: 'keyword', delta: { kind: 'remove_filter', field: 'region' } },
    })).rejects.toThrow(/移除或放宽/u)
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
    const finished = await controller.decide(PRINCIPAL, state, { stateId: state.stateId,
      judgments: [{ candidateRef: CANDIDATE_REF, verdict: 'accept', evidenceRefs: [CANDIDATE_REF], reason: 'the current eligible summary matches' }],
      gaps: [], action: { kind: 'finish', explanation: 'Supported result' } })
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(finished)
  })

  const MONTH_PENDING = '2026 年 7 月：时间表达尚不能可靠编译，请明确日期范围。'
  const JULY_FILTERS = [
    { field: 'resolvedAt', op: 'gte' as const, value: '2026-06-30T16:00:00.000Z' },
    { field: 'resolvedAt', op: 'lte' as const, value: '2026-07-31T15:59:59.999Z' },
  ]

  async function startMonthlyQuery(controller: RetrievalController) {
    return controller.start(PRINCIPAL, {
      target: 'constrained_list' as const,
      query: '找广东地区 2026 年 7 月已解决的副卡故障工单',
      filters: [
        { field: 'region', op: 'eq', value: '广东' },
        { field: 'status', op: 'eq', value: '已解决' },
      ],
      ambiguities: [{ kind: 'constraint' as const, text: MONTH_PENDING }],
    })
  }

  it('retires a pending constraint in one place when a repair declares the filters that resolve it', async () => {
    const { controller, journal } = setup(provider())
    let state = await startMonthlyQuery(controller)
    expect(state.query.unresolvedConstraints).toEqual([MONTH_PENDING])
    expect(state.query.contract?.userRequirements).toContainEqual(expect.objectContaining({
      text: '2026 年 7 月', status: 'unresolved', filters: [],
    }))
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'search', mode: 'keyword', delta: { kind: 'batch', changes: [
        { kind: 'add_filter', filter: JULY_FILTERS[0]!, resolves: '2026 年 7 月' },
        { kind: 'add_filter', filter: JULY_FILTERS[1]!, resolves: '2026 年 7 月' },
      ] } } })
    expect(state.query.unresolvedConstraints).toEqual([])
    expect(state.query.spec.ambiguities).toEqual([])
    expect(state.query.spec.filters).toEqual(expect.arrayContaining(JULY_FILTERS))
    expect(state.query.confirmedConstraints).toEqual(expect.arrayContaining(JULY_FILTERS))
    expect(state.query.contract?.ambiguities).toEqual([])
    expect(state.query.contract?.userRequirements).toContainEqual(expect.objectContaining({
      text: '2026 年 7 月', status: 'compiled', filters: JULY_FILTERS,
    }))
    expect(state.query.contract?.userRequirements).not.toContainEqual(expect.objectContaining({
      text: '2026 年 7 月', status: 'unresolved',
    }))
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })

  it('rejects a repair that claims to resolve a pending constraint which does not exist', async () => {
    const { controller, journal } = setup(provider())
    const state = await startMonthlyQuery(controller)
    await expect(controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'search', mode: 'keyword', delta: { kind: 'batch', changes: [
        { kind: 'add_filter', filter: JULY_FILTERS[0]!, resolves: '并不存在的待确认条件' },
      ] } } })).rejects.toThrow(/修复声明解决的待确认条件不存在/u)
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })

  it('offers a clarification exit for zero-candidate unresolved states and accepts no_result once answered', async () => {
    const base = provider()
    const emptyProvider: TicketRetrievalProvider = { ...base, async search(principal, snapshotId, query, options) {
      const page = await base.search(principal, snapshotId, query, options)
      return { ...page, candidates: [], returned: 0, scanned: 0,
        trace: searchTrace(options.stage, query.mode, []),
        boundary: { ...page.boundary, resultPagesExhausted: true } }
    } }
    const { controller, journal } = setup(emptyProvider)
    let state = await startMonthlyQuery(controller)
    expect(state.candidates).toEqual([])
    expect(state.allowedActions.some(action => action.kind === 'request_clarification')).toBe(true)

    await expect(controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'finish', reason: 'no_result', explanation: '范围内没有候选。' } }))
      .rejects.toThrow(/无结果需要当前查询页已用尽/u)
    await expect(controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'clarify', question: '您需要哪类故障工单？', facet: 'business_scope', candidateRefs: [], evidenceRefs: [] } }))
      .rejects.toThrow(/澄清问题必须引用具体的待确认条件/u)

    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'clarify', question: '您说的 2026 年 7 月是指解决时间还是创建时间？', facet: 'resolvedAt', candidateRefs: [], evidenceRefs: [] } })
    expect(state).toMatchObject({ phase: 'awaiting_clarification', termination: 'needs_clarification' })

    state = await controller.resumeClarification(PRINCIPAL, state, {
      accepted: true,
      answer: '解决时间在 2026 年 7 月 1 日到 7 月 31 日之间',
      filters: JULY_FILTERS,
      requirements: [{ text: '解决时间在 2026 年 7 月 1 日到 7 月 31 日之间', status: 'compiled', filters: JULY_FILTERS }],
    })
    expect(state.query.unresolvedConstraints).toEqual([])
    expect(state.query.spec.ambiguities).toEqual([])
    expect(state.query.contract?.ambiguities).toEqual([])
    expect(state.query.contract?.userRequirements).not.toContainEqual(expect.objectContaining({
      text: '2026 年 7 月', status: 'unresolved',
    }))
    expect(state.query.confirmedConstraints).toEqual(expect.arrayContaining(JULY_FILTERS))

    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [], gaps: [],
      action: { kind: 'finish', reason: 'no_result', explanation: '限定解决时间后当前查询没有候选。' } })
    expect(state.termination).toBe('no_result')
    expect(foldRetrievalEvents(journal.read(state.retrievalId), state.retrievalId)).toEqual(state)
  })

})
