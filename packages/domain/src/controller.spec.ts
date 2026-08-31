import { describe, expect, it } from 'vitest'
import {
  RetrievalError,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketId,
  TicketSnapshotId,
  type RetrievalKnowledgeAssessment,
  type TicketRetrievalProvider,
  type TicketRetrievalMode,
  type TicketSearchStage,
  type TicketSearchTrace,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/ticket-collection'
import { EvidenceContextPolicy } from './context.js'
import { RetrievalController, type RetrievalSearchInput } from './controller.js'
import { InMemoryRetrievalEventJournal } from './journal.js'
import { foldRetrievalEvents } from './replay.js'

const NOW = new Date('2026-08-27T02:00:00.000Z')
const CANDIDATE_REF = TicketCandidateRef('cand-1')
const SECOND_CANDIDATE_REF = TicketCandidateRef('cand-2')
const THIRD_CANDIDATE_REF = TicketCandidateRef('cand-3')
const EVIDENCE_ID = TicketEvidenceId('evidence-1')

function assessment(
  patch: Partial<RetrievalKnowledgeAssessment> = {},
): RetrievalKnowledgeAssessment {
  return {
    decision: 'continue',
    coverage: 0.5,
    candidateQuality: 0.7,
    selectedCandidateRefs: [CANDIDATE_REF],
    excludedCandidateRefs: [],
    gaps: [],
    nextAction: 'promote',
    stop: false,
    ...patch,
  }
}

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
        requestedCount: request.requestedCount ?? 3,
        countPolicy: request.countPolicy ?? (request.requestedCount === undefined ? 'provider_default' : 'explicit'),
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
          evidenceLevel: 'L1',
          rank: 1,
          title: '登录失败',
          summary: '验证码缓存失效',
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
          end: 13,
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
        }
      }
      return {
        ...page,
        candidates: [],
        completeness: 'exhaustive',
        returned: 0,
        trace: searchTrace(options.stage, query.mode, []),
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

describe('RetrievalController', () => {
  it('runs a bounded search, evidence promotion, freeze, and exact event replay', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, new EvidenceContextPolicy({ estimateTokens: () => 1 }), {
      now: () => NOW,
      id: ids,
      maxRounds: 4,
      maxSearches: 2,
      maxPromotions: 1,
      maxEvidenceTokens: 50,
    })

    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录 验证码', requestedCount: 3 })
    expect(state.phase).toBe('assessed')
    expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
    expect(state.budget).toMatchObject({ roundsUsed: 1, searchesUsed: 1 })
    expect(state.allowedActions.map(item => item.kind)).toEqual(['assess', 'read_state'])
    expect(() => controller.freeze(state, [])).toThrowError(RetrievalError)

    state = controller.assess(state, assessment({
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [CANDIDATE_REF], evaluator: 'model' }],
      model: 'fixture-model',
    }))
    await expect(controller.promote(PRINCIPAL, state, [TicketCandidateRef('forged')], ['problemDescription'], 20))
      .rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
    state = await controller.promote(PRINCIPAL, state, [CANDIDATE_REF], ['problemDescription'], 20)

    const context = controller.projectContext(state, 20)
    expect(context.includedCandidateRefs).toEqual([CANDIDATE_REF])
    expect(context.includedEvidenceIds).toEqual([EVIDENCE_ID])
    expect(context.rendered).toContain('<untrusted_ticket_evidence>')

    state = controller.assess(state, assessment({
      decision: 'sufficient',
      coverage: 1,
      candidateQuality: 1,
      gaps: [{ kind: 'depth', status: 'resolved', evidenceRefs: [EVIDENCE_ID], evaluator: 'model' }],
      nextAction: 'finish',
      stop: true,
    }))
    state = controller.freeze(state, [CANDIDATE_REF])

    expect(state.termination).toBe('sufficient')
    expect(state.frozenEvidence?.candidates[0]).toMatchObject({ displayId: 'INC-1', evidenceLevel: 'L2' })

    const events = journal.read(state.retrievalId)
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index))
    expect(foldRetrievalEvents(events, state.retrievalId)).toEqual(state)
  })

  it('rejects broken replay chains instead of accepting a partial state history', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, { now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    const events = [...journal.read(state.retrievalId)]
    const broken = events.map((event, index) => index === 1 ? { ...event, sequence: 4 } : event)
    expect(() => foldRetrievalEvents(broken, state.retrievalId)).toThrow(/序列不连续/u)
  })

  it('rejects provider data that escapes the requested snapshot or evidence allowlist', async () => {
    const ids = deterministicIds()
    const base = provider()
    const wrongSnapshotProvider: TicketRetrievalProvider = {
      ...base,
      async search(principal, snapshotId, query, options) {
        return { ...await base.search(principal, snapshotId, query, options), snapshotId: TicketSnapshotId('other-snapshot') }
      },
    }
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(wrongSnapshotProvider, journal, undefined, { now: () => NOW, id: ids })
    const started = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    expect(started).toMatchObject({ phase: 'stopped', termination: 'backend_error', candidates: [] })

    const rejectedProvider: TicketRetrievalProvider = {
      ...base,
      async readEvidence(_principal, request) {
        return {
          snapshotId: request.snapshotId,
          evidence: [],
          requestedCandidateRefs: request.candidateRefs,
          rejectedCandidateRefs: request.candidateRefs,
          tokenBudget: request.tokenBudget,
          tokensUsed: 0,
          warnings: ['authorization_changed'],
        }
      },
    }
    const secondIds = deterministicIds()
    const secondJournal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: secondIds })
    const second = new RetrievalController(rejectedProvider, secondJournal, undefined, { now: () => NOW, id: secondIds })
    let state = await second.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = second.assess(state, assessment({ nextAction: 'promote' }))
    await expect(second.promote(PRINCIPAL, state, [CANDIDATE_REF], ['problemDescription'], 20))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('requires an honest partial assessment when round or latency budgets are exhausted', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, {
      now: () => NOW,
      id: ids,
      maxRounds: 1,
      maxSearches: 3,
      maxPromotions: 3,
      maxLatencyMs: 5,
    })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    expect(state.budget.latencyMs).toBe(7)
    expect(state.allowedActions.map(item => item.kind)).toEqual(['assess', 'read_state'])

    expect(() => controller.assess(state, assessment({
      nextAction: 'promote',
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [CANDIDATE_REF], evaluator: 'model' }],
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    state = controller.assess(state, assessment({
      decision: 'partial',
      nextAction: 'finish',
      stop: true,
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [CANDIDATE_REF], evaluator: 'model' }],
    }))
    expect(state.allowedActions.map(item => item.kind)).toEqual(['freeze', 'read_state'])
    state = controller.freeze(state, [CANDIDATE_REF])
    expect(state.termination).toBe('partial')
  })

  it('uses snapshot-declared dynamic L0 fields for candidate-difference clarification', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(dynamicFacetProvider(), journal, undefined, { now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '账号问题' })
    state = controller.assess(state, assessment({
      decision: 'needs_clarification',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [{ kind: 'ambiguity', status: 'open', evidenceRefs: [CANDIDATE_REF, SECOND_CANDIDATE_REF], evaluator: 'model' }],
      nextAction: 'clarify',
      stop: false,
    }))

    expect(() => controller.requestClarification(
      state,
      'problemDescription',
      '您要找哪一类问题？',
      [CANDIDATE_REF, SECOND_CANDIDATE_REF],
    )).toThrow(/未由当前授权快照声明为 L0/u)

    state = controller.requestClarification(
      state,
      'source.queue',
      '您要找计费队列还是技术支持队列？',
      [CANDIDATE_REF, SECOND_CANDIDATE_REF],
    )
    expect(state.phase).toBe('awaiting_clarification')
    expect(state.clarification).toMatchObject({ facet: 'source.queue' })

    state = controller.answerClarification(state, { accepted: true, answer: 'technical' })
    expect(state.query.spec.filters).toContainEqual({ field: 'source.queue', op: 'eq', value: 'technical' })
  })

  it('requires exactly one typed delta or cursor for every search after the automatic first round', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, {
      now: () => NOW,
      id: ids,
      maxSearches: 3,
    })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })

    await expect(controller.search(PRINCIPAL, state, { mode: 'keyword' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(controller.search(PRINCIPAL, state, {
      mode: 'keyword',
      delta: { kind: 'add_terms', terms: ['验证码'] },
      cursor: 'forged-cursor',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(controller.search(PRINCIPAL, state, {
      mode: 'hybrid',
      delta: { kind: 'add_terms', terms: ['验证码'] },
    } as unknown as RetrievalSearchInput)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    state = controller.assess(state, assessment({ nextAction: 'keyword_search' }))
    const repaired = await controller.search(PRINCIPAL, state, {
      mode: 'keyword',
      delta: { kind: 'add_terms', terms: ['验证码'] },
    })
    expect(repaired.query.spec.normalizedQuery).toBe('登录 验证码')
    expect(repaired.query.spec.mode).toBe('keyword')
    expect(repaired.lastPage?.trace.stage).toBe('repair_search')
    expect(repaired.budget.searchesUsed).toBe(2)

    state = controller.assess(repaired, assessment({ nextAction: 'vector_search' }))
    const dense = await controller.search(PRINCIPAL, state, {
      mode: 'dense',
      delta: { kind: 'semantic_hint', text: '缓存失效' },
    })
    expect(dense.query.spec.mode).toBe('dense')
    expect(dense.query.spec.semanticHints).toEqual(['缓存失效'])
    expect(dense.lastPage?.trace).toMatchObject({ stage: 'repair_search', requestedMode: 'dense', executedMode: 'dense' })
  })

  it('keeps immutable candidate history while later repair evidence can revise the active ranking', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(accumulatingProvider(), journal, undefined, {
      now: () => NOW,
      id: ids,
      maxSearches: 3,
    })
    let state = await controller.start(PRINCIPAL, {
      target: 'ranked_cases',
      query: '登录',
      requestedCount: 3,
    })

    state = controller.assess(state, assessment({ nextAction: 'keyword_search' }))
    state = await controller.search(PRINCIPAL, state, {
      mode: 'keyword',
      delta: { kind: 'add_terms', terms: ['验证码'] },
    })
    expect(state.candidateHistory.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF, SECOND_CANDIDATE_REF])
    expect(state.candidates.map(candidate => candidate.ref)).toEqual([SECOND_CANDIDATE_REF, CANDIDATE_REF])

    state = controller.assess(state, assessment({
      selectedCandidateRefs: [SECOND_CANDIDATE_REF],
      nextAction: 'vector_search',
    }))
    state = await controller.search(PRINCIPAL, state, {
      mode: 'dense',
      delta: { kind: 'semantic_hint', text: '缓存失效' },
    })
    expect(state.candidateHistory.map(candidate => candidate.ref)).toEqual([
      CANDIDATE_REF, SECOND_CANDIDATE_REF, THIRD_CANDIDATE_REF,
    ])
    expect(state.candidates.map(candidate => candidate.ref)).toEqual([
      SECOND_CANDIDATE_REF, THIRD_CANDIDATE_REF, CANDIDATE_REF,
    ])
    expect(state.candidates.map(candidate => candidate.rank)).toEqual([1, 2, 3])
    expect(controller.finalizeExhaustedEmptyResult(state)).toBe(state)

    state = controller.assess(state, assessment({
      decision: 'sufficient',
      coverage: 1,
      candidateQuality: 0.9,
      selectedCandidateRefs: [SECOND_CANDIDATE_REF, THIRD_CANDIDATE_REF, CANDIDATE_REF],
      nextAction: 'finish',
      stop: true,
    }))
    state = controller.freeze(state, state.selectedCandidateRefs)
    expect(state).toMatchObject({
      phase: 'stopped',
      termination: 'sufficient',
      frozenEvidence: { complete: true },
    })
  })

  it('returns the model-selected partial collection when repair search makes no progress', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(dynamicFacetProvider('bounded'), journal, undefined, {
      now: () => NOW,
      id: ids,
      maxSearches: 4,
      noProgressLimit: 1,
    })
    let state = await controller.start(PRINCIPAL, {
      target: 'ranked_cases',
      query: '登录',
      requestedCount: 20,
    })
    state = controller.assess(state, assessment({ nextAction: 'keyword_search' }))
    state = await controller.search(PRINCIPAL, state, {
      mode: 'keyword',
      delta: { kind: 'add_terms', terms: ['验证码'] },
    })

    state = controller.assess(state, assessment({
      decision: 'partial',
      selectedCandidateRefs: [CANDIDATE_REF, SECOND_CANDIDATE_REF],
      nextAction: 'finish',
      stop: true,
    }))
    state = controller.freeze(state, state.selectedCandidateRefs)
    expect(state).toMatchObject({
      phase: 'stopped',
      termination: 'partial',
      frozenEvidence: { complete: false, stoppingReason: 'partial' },
    })
    expect(createTicketResultCollection(state).tickets.map(candidate => candidate.ref)).toEqual([
      CANDIDATE_REF,
      SECOND_CANDIDATE_REF,
    ])
  })

  it('keeps exhaustive coverage open and rejects complete assessment or freeze while a cursor remains', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(paginatedProvider(), journal, undefined, {
      now: () => NOW,
      id: ids,
      maxSearches: 3,
    })
    let state = await controller.start(PRINCIPAL, {
      target: 'cohort_collection',
      query: '登录',
      requestedCount: 20,
    })

    expect(state.lastPage).toMatchObject({ completeness: 'bounded', nextCursor: 'cursor-page-2' })
    expect(state.allowedActions.map(action => action.kind)).not.toContain('search_next')
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'open', evaluator: 'system' }))
    expect(state.progress.resolvedGaps).not.toContain('coverage')
    expect(() => controller.assess(state, assessment({
      decision: 'sufficient',
      coverage: 1,
      candidateQuality: 1,
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: state.gaps,
      nextAction: 'finish',
      stop: true,
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    expect(controller.finalizeExhaustedEmptyResult(state)).toBe(state)

    state = controller.assess(state, assessment({
      decision: 'partial',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [],
      nextAction: 'finish',
      stop: true,
    }))
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'open', evaluator: 'system' }))
    expect(() => controller.freeze(state, [CANDIDATE_REF], 'sufficient'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))

    state = controller.freeze(state, [CANDIDATE_REF])
    expect(state).toMatchObject({ termination: 'partial', frozenEvidence: { complete: false, stoppingReason: 'partial' } })
  })

  it.each([
    { label: 'the Provider reports a bounded terminal page', completeness: 'bounded' as const },
    { label: 'the Provider reports exhaustive but still issues a cursor', completeness: 'exhaustive' as const, nextCursor: 'cursor-page-2' },
  ])('keeps exhaustive coverage open when $label', async ({ completeness, nextCursor }) => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(paginatedProvider({
      completeness,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }), journal, undefined, { now: () => NOW, id: ids })
    const state = await controller.start(PRINCIPAL, { target: 'cohort_collection', query: '登录' })

    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'open', evaluator: 'system' }))
    expect(() => controller.assess(state, assessment({
      decision: 'sufficient',
      coverage: 1,
      candidateQuality: 1,
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: state.gaps,
      nextAction: 'finish',
      stop: true,
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
  })

  it('allows an exhaustive collection to become complete only after the terminal page removes the cursor', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(paginatedProvider(), journal, undefined, {
      now: () => NOW,
      id: ids,
      maxSearches: 3,
    })
    let state = await controller.start(PRINCIPAL, { target: 'cohort_collection', query: '登录' })
    expect(state.allowedActions.map(action => action.kind)).toEqual(['assess', 'read_state'])
    state = controller.assess(state, assessment({ nextAction: 'continue_ranking' }))
    expect(state.allowedActions.map(action => action.kind)).toContain('search_next')
    state = await controller.continueRanking(PRINCIPAL, state)

    expect(state.lastPage).toMatchObject({ completeness: 'exhaustive' })
    expect(state.lastPage?.nextCursor).toBeUndefined()
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'resolved', evaluator: 'system' }))
    expect(state.progress.resolvedGaps).toContain('coverage')

    expect(controller.finalizeExhaustedEmptyResult(state)).toBe(state)
    state = controller.assess(state, assessment({
      decision: 'sufficient',
      coverage: 1,
      candidateQuality: 1,
      nextAction: 'finish',
      stop: true,
    }))
    state = controller.freeze(state, state.selectedCandidateRefs)
    expect(state).toMatchObject({ termination: 'sufficient', frozenEvidence: { complete: true, stoppingReason: 'sufficient' } })
  })

  it('does not equate a nonempty count prefix with knowledge sufficiency and freezes the assessed selection', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(dynamicFacetProvider('bounded'), journal, undefined, { now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, {
      target: 'ranked_cases',
      query: '账号问题',
      requestedCount: 1,
    })

    expect(state.candidates.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF, SECOND_CANDIDATE_REF])
    expect(controller.finalizeExhaustedEmptyResult(state)).toBe(state)
    state = controller.assess(state, assessment({
      decision: 'sufficient',
      coverage: 1,
      candidateQuality: 0.9,
      selectedCandidateRefs: [SECOND_CANDIDATE_REF],
      nextAction: 'finish',
      stop: true,
    }))
    const finalized = controller.freeze(state, state.selectedCandidateRefs)
    expect(finalized).toMatchObject({
      phase: 'stopped',
      termination: 'sufficient',
      frozenEvidence: {
        complete: true,
        candidates: [{ ref: SECOND_CANDIDATE_REF }],
      },
    })
    expect(finalized.provenance).not.toHaveProperty('model')
    expect(controller.finalizeExhaustedEmptyResult(finalized)).toBe(finalized)

    const incompleteIds = deterministicIds()
    const incomplete = new RetrievalController(paginatedProvider({ completeness: 'bounded' }), new InMemoryRetrievalEventJournal({
      now: () => NOW,
      eventId: incompleteIds,
    }), undefined, { now: () => NOW, id: incompleteIds })
    const incompleteState = await incomplete.start(PRINCIPAL, {
      target: 'ranked_cases',
      query: '登录',
      requestedCount: 2,
    })
    expect(incompleteState.candidates).toHaveLength(1)
    expect(incompleteState.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'open' }))
    expect(incomplete.finalizeExhaustedEmptyResult(incompleteState)).toBe(incompleteState)
  })

  it('returns an incomplete budget-exhausted collection when exhaustive paging cannot continue', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(paginatedProvider(), journal, undefined, {
      now: () => NOW,
      id: ids,
      maxRounds: 1,
      maxSearches: 4,
    })
    let state = await controller.start(PRINCIPAL, { target: 'cohort_collection', query: '登录' })
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'open' }))
    expect(state.allowedActions.map(action => action.kind)).toEqual(['assess', 'read_state'])

    expect(() => controller.assess(state, assessment({
      nextAction: 'continue_ranking',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: state.gaps,
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    state = controller.assess(state, assessment({
      decision: 'partial',
      nextAction: 'finish',
      stop: true,
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: state.gaps,
    }))
    expect(state.allowedActions.map(action => action.kind)).toEqual(['freeze', 'read_state'])
    state = controller.freeze(state, [CANDIDATE_REF])

    const result = createTicketResultCollection(state)
    expect(state).toMatchObject({
      termination: 'budget_exhausted',
      frozenEvidence: { complete: false, stoppingReason: 'budget_exhausted' },
    })
    expect(result).toMatchObject({
      type: 'ticket_collection',
      stoppingReason: 'budget_exhausted',
      complete: false,
      tickets: [{ ref: CANDIDATE_REF }],
      remainingGapKinds: ['coverage'],
    })
  })
})
