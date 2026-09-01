import { describe, expect, it } from 'vitest'
import { testRetrievalPolicy } from '../../../tests/support/retrieval-policy.js'
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
const POLICY = testRetrievalPolicy()

function assessment(
  patch: Partial<RetrievalKnowledgeAssessment> = {},
): RetrievalKnowledgeAssessment {
  return {
    decision: 'continue',
    selectedCandidateRefs: [CANDIDATE_REF],
    excludedCandidateRefs: [],
    gaps: [],
    nextAction: 'promote',
    evaluator: 'model',
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

describe('RetrievalController', () => {
  it('runs a bounded search, evidence promotion, freeze, and exact event replay', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, new EvidenceContextPolicy({ estimateTokens: () => 1 }), { policy: POLICY,
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
    expect(state.budget).toMatchObject({ roundsUsed: 0, searchesUsed: 1, providerLatencyMs: 7, latencyMs: 0 })
    expect(state.allowedActions.map(item => item.kind)).toEqual(['assess', 'repair_search', 'promote', 'read_state'])
    expect(() => controller.freeze(state, [])).toThrowError(RetrievalError)

    state = await controller.assess(state, assessment({
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

    state = await controller.assess(state, assessment({
      decision: 'accept_current_top_k',
      gaps: [{ kind: 'depth', status: 'resolved', evidenceRefs: [EVIDENCE_ID], evaluator: 'model' }],
      nextAction: 'accept_current_top_k',
    }))
    state = controller.freeze(state, [CANDIDATE_REF])

    expect(state.termination).toBe('top_k_accepted')
    expect(state.frozenEvidence?.candidates[0]).toMatchObject({ displayId: 'INC-1', evidenceLevel: 'L2' })

    const events = journal.read(state.retrievalId)
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index))
    expect(foldRetrievalEvents(events, state.retrievalId)).toEqual(state)
  })

  it('rejects broken replay chains instead of accepting a partial state history', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, { policy: POLICY, now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    const events = [...journal.read(state.retrievalId)]
    const broken = events.map((event, index) => index === 1 ? { ...event, sequence: 4 } : event)
    expect(() => foldRetrievalEvents(broken, state.retrievalId)).toThrow(/序列不连续/u)
  })

  it('rejects pre-v5 event streams instead of silently treating missing runtime metrics as zero', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, { policy: POLICY, now: () => NOW, id: ids })
    const state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    const legacy = journal.read(state.retrievalId).map(event => ({ ...event, schemaVersion: 4 }))
    expect(() => foldRetrievalEvents(
      legacy as unknown as Parameters<typeof foldRetrievalEvents>[0],
      state.retrievalId,
    )).toThrow(/不支持检索事件版本 4/u)
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
    const controller = new RetrievalController(wrongSnapshotProvider, journal, undefined, { policy: POLICY, now: () => NOW, id: ids })
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
    const second = new RetrievalController(rejectedProvider, secondJournal, undefined, { policy: POLICY, now: () => NOW, id: secondIds })
    let state = await second.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = await second.assess(state, assessment({ nextAction: 'promote' }))
    await expect(second.promote(PRINCIPAL, state, [CANDIDATE_REF], ['problemDescription'], 20))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('requires an honest partial assessment when round or latency budgets are exhausted', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, { policy: POLICY,
      now: () => NOW,
      id: ids,
      maxRounds: 1,
      maxSearches: 3,
      maxPromotions: 3,
      maxLatencyMs: 5,
    })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = controller.recordModelRequest(state, {
      estimatedInputTokens: 100, serializationBytes: 400, wallClockElapsedMs: 0, accepted: true,
    })
    state = controller.recordModelResponse(state, { modelLatencyMs: 7, outputTokens: 10, wallClockElapsedMs: 7 })
    expect(state.budget.latencyMs).toBe(7)
    expect(state.budget).toMatchObject({ modelStepsUsed: 1, modelLatencyMs: 7, providerLatencyMs: 7 })
    expect(state.allowedActions.map(item => item.kind)).toEqual(['assess', 'repair_search', 'promote', 'read_state'])

    await expect(controller.assess(state, assessment({
      nextAction: 'promote',
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [CANDIDATE_REF], evaluator: 'model' }],
    }))).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    state = await controller.assess(state, assessment({
      decision: 'return_partial',
      nextAction: 'finish_partial',
      evaluator: 'system',
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [CANDIDATE_REF], evaluator: 'model' }],
    }))
    expect(state.allowedActions.map(item => item.kind)).toEqual(['freeze', 'read_state'])
    state = controller.freeze(state, [CANDIDATE_REF])
    expect(state.termination).toBe('budget_exhausted')
  })

  it('uses snapshot-declared dynamic L0 fields for candidate-difference clarification', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(dynamicFacetProvider(), journal, undefined, { policy: POLICY, now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '账号问题' })
    state = await controller.assess(state, assessment({
      decision: 'needs_clarification',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [{ kind: 'ambiguity', status: 'open', evidenceRefs: [CANDIDATE_REF, SECOND_CANDIDATE_REF], evaluator: 'model' }],
      nextAction: 'clarify',
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
    const controller = new RetrievalController(provider(), journal, undefined, { policy: POLICY,
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

    state = await controller.assess(state, assessment({ nextAction: 'keyword_search' }))
    const repaired = await controller.search(PRINCIPAL, state, {
      mode: 'keyword',
      delta: { kind: 'add_terms', terms: ['验证码'] },
    })
    expect(repaired.query.spec.normalizedQuery).toBe('登录 验证码')
    expect(repaired.query.spec.mode).toBe('keyword')
    expect(repaired.lastPage?.trace.stage).toBe('repair_search')
    expect(repaired.budget.searchesUsed).toBe(2)

    state = await controller.assess(repaired, assessment({ nextAction: 'vector_search' }))
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
    const controller = new RetrievalController(accumulatingProvider(), journal, undefined, { policy: POLICY,
      now: () => NOW,
      id: ids,
      maxSearches: 3,
    })
    let state = await controller.start(PRINCIPAL, {
      target: 'ranked_cases',
      query: '登录',
      requestedCount: 3,
    })

    state = await controller.assess(state, assessment({ nextAction: 'keyword_search' }))
    state = await controller.search(PRINCIPAL, state, {
      mode: 'keyword',
      delta: { kind: 'add_terms', terms: ['验证码'] },
    })
    expect(state.candidateHistory.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF, SECOND_CANDIDATE_REF])
    expect(state.candidates.map(candidate => candidate.ref)).toEqual([SECOND_CANDIDATE_REF, CANDIDATE_REF])

    state = await controller.assess(state, assessment({
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
    expect(await controller.finalizeExhaustedEmptyResult(state)).toBe(state)

    state = await controller.assess(state, assessment({
      decision: 'accept_current_top_k',
      selectedCandidateRefs: [SECOND_CANDIDATE_REF, THIRD_CANDIDATE_REF, CANDIDATE_REF],
      nextAction: 'accept_current_top_k',
    }))
    state = controller.freeze(state, state.selectedCandidateRefs)
    expect(state).toMatchObject({
      phase: 'stopped',
      termination: 'top_k_accepted',
      frozenEvidence: { complete: false, topKAccepted: true, resultPagesExhausted: true },
    })
  })

  it('returns the model-selected partial collection when repair search makes no progress', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(dynamicFacetProvider('bounded'), journal, undefined, { policy: POLICY,
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
    state = await controller.assess(state, assessment({ nextAction: 'keyword_search' }))
    state = await controller.search(PRINCIPAL, state, {
      mode: 'keyword',
      delta: { kind: 'add_terms', terms: ['验证码'] },
    })

    state = await controller.assess(state, assessment({
      decision: 'return_partial',
      selectedCandidateRefs: [CANDIDATE_REF, SECOND_CANDIDATE_REF],
      nextAction: 'finish_partial',
      evaluator: 'system',
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
    const controller = new RetrievalController(paginatedProvider(), journal, undefined, { policy: POLICY,
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
    expect(state.allowedActions.map(action => action.kind)).toContain('search_next')
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'unknown', evaluator: 'system' }))
    expect(state.progress.resolvedGaps).not.toContain('coverage')
    await expect(controller.assess(state, assessment({
      decision: 'accept_current_top_k',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [],
      nextAction: 'accept_current_top_k',
    }))).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    expect(await controller.finalizeExhaustedEmptyResult(state)).toBe(state)

    state = await controller.assess(state, assessment({
      decision: 'return_partial',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [],
      nextAction: 'finish_partial',
      evaluator: 'system',
    }))
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'unknown', evaluator: 'system' }))
    expect(() => controller.freeze(state, [CANDIDATE_REF], 'top_k_accepted'))
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
    }), journal, undefined, { policy: POLICY, now: () => NOW, id: ids })
    const state = await controller.start(PRINCIPAL, { target: 'cohort_collection', query: '登录' })

    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'unknown', evaluator: 'system' }))
    await expect(controller.assess(state, assessment({
      decision: 'accept_current_top_k',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [],
      nextAction: 'accept_current_top_k',
    }))).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
  })

  it('keeps semantic recall unknown even after the exact result pages are exhausted', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(paginatedProvider(), journal, undefined, { policy: POLICY,
      now: () => NOW,
      id: ids,
      maxSearches: 3,
    })
    let state = await controller.start(PRINCIPAL, { target: 'cohort_collection', query: '登录' })
    expect(state.allowedActions.map(action => action.kind)).toEqual(['assess', 'search_next', 'repair_search', 'promote', 'read_state'])
    state = await controller.assess(state, assessment({ nextAction: 'continue_ranking' }))
    expect(state.allowedActions.map(action => action.kind)).toContain('search_next')
    state = await controller.continueRanking(PRINCIPAL, state)

    expect(state.lastPage).toMatchObject({ completeness: 'exhaustive' })
    expect(state.lastPage?.nextCursor).toBeUndefined()
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'unknown', evaluator: 'system' }))
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'boundary', status: 'resolved', evaluator: 'system' }))

    expect(await controller.finalizeExhaustedEmptyResult(state)).toBe(state)
    state = await controller.assess(state, assessment({
      decision: 'return_partial',
      nextAction: 'finish_partial',
      evaluator: 'system',
    }))
    state = controller.freeze(state, state.selectedCandidateRefs)
    expect(state).toMatchObject({ termination: 'partial', frozenEvidence: { complete: false, stoppingReason: 'partial', resultPagesExhausted: true, semanticRecallKnown: false } })
  })

  it('presents a useful current Top-K without freezing the retrieval or discarding the Provider cursor', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(paginatedProvider(), journal, undefined, { policy: POLICY,
      now: () => NOW, id: ids, maxSearches: 3,
    })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '副卡 跨域' })
    state = await controller.assess(state, assessment({
      decision: 'present_current_top_k',
      nextAction: 'present_current_top_k',
    }))

    expect(state).toMatchObject({
      phase: 'assessed', termination: 'active',
      lastAssessment: { decision: 'present_current_top_k' },
      lastPage: { nextCursor: 'cursor-page-2' },
    })
    expect(state.allowedActions.map(action => action.kind)).toEqual([
      'assess', 'search_next', 'repair_search', 'promote', 'read_state',
    ])
    expect(() => controller.freeze(state, state.selectedCandidateRefs))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))

    state = await controller.continueRanking(PRINCIPAL, state)
    expect(state.lastPage?.nextCursor).toBeUndefined()
    expect(state.lastPage?.boundary?.resultPagesExhausted).toBe(true)
  })

  it('does not equate a nonempty count prefix with knowledge sufficiency and freezes the assessed selection', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(dynamicFacetProvider('bounded'), journal, undefined, { policy: POLICY, now: () => NOW, id: ids })
    let state = await controller.start(PRINCIPAL, {
      target: 'ranked_cases',
      query: '账号问题',
      requestedCount: 1,
    })

    expect(state.candidates.map(candidate => candidate.ref)).toEqual([CANDIDATE_REF, SECOND_CANDIDATE_REF])
    expect(await controller.finalizeExhaustedEmptyResult(state)).toBe(state)
    state = await controller.assess(state, assessment({
      decision: 'accept_current_top_k',
      selectedCandidateRefs: [SECOND_CANDIDATE_REF],
      nextAction: 'accept_current_top_k',
    }))
    const finalized = controller.freeze(state, state.selectedCandidateRefs)
    expect(finalized).toMatchObject({
      phase: 'stopped',
      termination: 'top_k_accepted',
      gaps: expect.arrayContaining([expect.objectContaining({ kind: 'coverage', status: 'unknown', evaluator: 'system' })]),
      frozenEvidence: {
        complete: false,
        topKAccepted: true,
        resultPagesExhausted: true,
        resultMayBeIncomplete: true,
        candidates: [{ ref: SECOND_CANDIDATE_REF }],
        remainingGaps: [expect.objectContaining({ kind: 'coverage', status: 'unknown' })],
      },
    })
    expect(createTicketResultCollection(finalized)).toMatchObject({
      complete: false,
      decisionFinalized: true,
      topKAccepted: true,
      resultPagesExhausted: true,
      resultMayBeIncomplete: true,
      nextPageAvailable: false,
      remainingGapKinds: ['coverage'],
    })
    expect(finalized.provenance).not.toHaveProperty('model')
    expect(await controller.finalizeExhaustedEmptyResult(finalized)).toBe(finalized)

    const incompleteIds = deterministicIds()
    const incomplete = new RetrievalController(paginatedProvider({ completeness: 'bounded' }), new InMemoryRetrievalEventJournal({
      now: () => NOW,
      eventId: incompleteIds,
    }), undefined, { policy: POLICY, now: () => NOW, id: incompleteIds })
    const incompleteState = await incomplete.start(PRINCIPAL, {
      target: 'ranked_cases',
      query: '登录',
      requestedCount: 2,
    })
    expect(incompleteState.candidates).toHaveLength(1)
    expect(incompleteState.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'unknown' }))
    expect(await incomplete.finalizeExhaustedEmptyResult(incompleteState)).toBe(incompleteState)
  })

  it('returns an incomplete budget-exhausted collection when exhaustive paging cannot continue', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(paginatedProvider(), journal, undefined, { policy: POLICY,
      now: () => NOW,
      id: ids,
      maxRounds: 1,
      maxSearches: 4,
    })
    let state = await controller.start(PRINCIPAL, { target: 'cohort_collection', query: '登录' })
    state = controller.recordModelRequest(state, {
      estimatedInputTokens: 100, serializationBytes: 400, wallClockElapsedMs: 0, accepted: true,
    })
    expect(state.gaps).toContainEqual(expect.objectContaining({ kind: 'coverage', status: 'unknown' }))
    expect(state.allowedActions.map(action => action.kind)).toEqual(['assess', 'search_next', 'repair_search', 'promote', 'read_state'])

    await expect(controller.assess(state, assessment({
      nextAction: 'continue_ranking',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [],
    }))).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    state = await controller.assess(state, assessment({
      decision: 'return_partial',
      nextAction: 'finish_partial',
      evaluator: 'system',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [],
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
      remainingGapKinds: ['coverage', 'boundary'],
    })
  })
})
