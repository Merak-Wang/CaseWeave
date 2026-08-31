import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  TicketCandidateRef,
  TicketSnapshotId,
  type TicketRetrievalRequest,
  type TicketRetrievalSpec,
  type TicketSearchPage,
  type TicketSearchOptions,
} from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/ticket-collection'
import { readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { RetrievalAgentService } from './service.js'
import { installRetrievalTools } from './tools.js'

const SIGNAL = new AbortController().signal

function sessionAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(SIGNAL),
    whenIdle: () => Promise.resolve(),
  }
}

class StubPrincipalProvider extends Service {
  constructor(ctx: Context) { super(ctx, 'ticketPrincipalProvider') }

  resolve() {
    return Promise.resolve({
      tenantId: 'demo',
      subjectId: 'development-admin',
      entitlementVersion: 'development-admin-v1',
      purpose: 'ticket_retrieval' as const,
      attributes: { group: ['admin'], role: ['administrator'], environment: ['development'] },
      issuedAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-08-28T00:00:00.000Z',
    })
  }
}

class StubTicketProvider extends Service {
  readonly providerId = 'cordis-proxy-stub-v1'

  constructor(ctx: Context) { super(ctx, 'ticketRetrievalProvider') }

  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec {
    return {
      target: request.target,
      originalQuery: request.query,
      normalizedQuery: (request.retrievalQuery ?? request.query).trim(),
      requestedCount: request.requestedCount ?? 5,
      countPolicy: request.countPolicy ?? (request.requestedCount === undefined ? 'provider_default' : 'explicit'),
      mode: request.mode ?? 'keyword',
      filters: request.filters ?? [],
      ambiguities: request.ambiguities ?? [],
      excludedTerms: [],
      semanticHints: [],
      compilerVersion: 'cordis-proxy-query-v1',
    }
  }

  openSnapshot() {
    return Promise.resolve({
      snapshotId: TicketSnapshotId('cordis-proxy-snapshot'),
      shortId: 'proxy-snapshot',
      providerId: this.providerId,
      createdAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-08-28T00:00:00.000Z',
      sourceVersion: 'fixture-v1',
      indexVersion: 'fixture-index-v1',
      retrievalProfileVersion: 'fixture-hybrid-v1',
      authorizationVersion: 'development-admin-v1',
      principalBindingHash: 'principal-binding',
      queryPolicyVersion: 'cordis-proxy-query-v1',
      fieldCatalog: [],
      capabilities: {
        exhaustive: true,
        pagination: false,
        evidencePromotion: false,
        detailRead: false,
        exportRead: false,
        keywordSearch: true as const,
        denseSearch: true,
        hybridFusion: true,
        reranking: false,
      },
    })
  }

  search(_principal: unknown, snapshotId: TicketSnapshotId, query: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
    return Promise.resolve({
      snapshotId,
      queryFingerprint: 'cordis-proxy-query-fingerprint',
      candidates: [],
      completeness: 'exhaustive' as const,
      scanned: 0,
      returned: 0,
      elapsedMs: 1,
      appliedFilters: query.filters,
      warnings: [],
      trace: {
        stage: options.stage,
        requestedMode: query.mode,
        executedMode: query.mode,
        strategyVersion: 'fixture-hybrid-v1',
        channels: [
          { channel: 'keyword' as const, implementation: 'fixture-bm25f', version: 'fixture-bm25f-v1', resultCount: 0, elapsedMs: 1 },
          {
            channel: 'vector' as const, implementation: 'fixture-dense', version: 'fixture-dense-v1',
            model: 'fixture-embedding', revision: 'fixture-revision-v1', dimensions: 4,
            resultCount: 0, elapsedMs: 0,
          },
        ],
        fusion: {
          method: 'weighted_rrf' as const,
          version: 'fixture-rrf-v1',
          rankConstant: 60,
          keywordWeight: 0.5,
          vectorWeight: 0.5,
        },
        signals: [],
      },
    })
  }
}

class UnionTicketProvider extends StubTicketProvider {
  readonly modes: string[] = []

  override async search(_principal: unknown, snapshotId: TicketSnapshotId, query: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
    this.modes.push(String(query.mode))
    if (query.mode === 'keyword') await new Promise(resolve => setTimeout(resolve, 20))
    const suffix = query.mode === 'hybrid' ? '1' : query.mode === 'keyword' ? '2' : '3'
    const ref = TicketCandidateRef(`candidate-${suffix}`)
    return {
      snapshotId,
      queryFingerprint: `query-${suffix}`,
      candidates: [{
        ref,
        displayId: `TKT-${suffix}`,
        sourceVersion: 'fixture-v1',
        snapshotId,
        contentHash: `hash-${suffix}`,
        evidenceLevel: 'L1' as const,
        rank: 1,
        title: `工单 ${suffix}`,
        summary: `摘要 ${suffix}`,
        l0: {},
        matchFragments: [{ field: 'title' as const, text: `工单 ${suffix}`, truncated: false }],
      }],
      completeness: 'bounded' as const,
      scanned: 3,
      returned: 1,
      elapsedMs: 1,
      appliedFilters: query.filters,
      warnings: [],
      trace: {
        stage: options.stage,
        requestedMode: query.mode,
        executedMode: query.mode,
        strategyVersion: 'fixture-union-v1',
        channels: [],
        signals: [{
          candidateRef: ref,
          finalRank: 1,
          fusedScore: 1,
          channels: [],
        }],
      },
    }
  }
}

describe('RetrievalAgentService Cordis binding', () => {
  it('starts through the context trace proxy without private-brand failures', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(StubTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      const agent = {
        session: Session.create(SessionId('cordis-proxy-agent')),
      } as Agent

      const state = await ctx.retrievalAgent.start(agent, {
        target: 'ranked_cases',
        query: '副卡',
        requestedCount: 5,
      })

      expect(state.phase).toBe('stopped')
      expect(state.termination).toBe('no_result')
      expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
      expect(state.budget.searchesUsed).toBe(1)
      expect(ctx.retrievalAgent.current(agent).stateId).toBe(state.stateId)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts from accepted raw text and returns an exhausted empty first pass without a model request', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(StubTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { adaptiveMaxResults: 20 })

      const session = Session.create(SessionId('automatic-pre-step'))
      const agent = sessionAgent(session)
      const rawQuery = '  副卡解绑后流量仍然共享\n'
      const direct = createUserMessage({
        content: [{ type: 'text', text: rawQuery }],
        source: { kind: 'user' },
      })
      const downstreamContext = createUserMessage({
        content: [{ type: 'text', text: 'downstream context' }],
        source: { kind: 'plugin', plugin: 'downstream-test' },
      })

      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [direct], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [direct, downstreamContext] }),
      )

      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('pre-step unexpectedly rejected')
      expect(decision.messages).toEqual([])
      const persistedMessages = session.events
        .filter(event => event.type === 'user/message')
        .map(event => event.data)
      expect(persistedMessages[0]).toEqual(direct)
      expect(persistedMessages[2]).toEqual(downstreamContext)
      const snapshotMessage = persistedMessages[1]
      expect(snapshotMessage?.source).toMatchObject({
        kind: 'plugin',
        plugin: 'retrieval-agent',
        form: 'snapshot',
      })

      const events = readRetrievalSessionEvents(session)
      const contracted = events.find(event => event.type === 'retrieval/query-contracted')
      const projected = events.find(event => event.type === 'retrieval/context-projected')
      expect(contracted?.type).toBe('retrieval/query-contracted')
      expect(projected?.type).toBe('retrieval/context-projected')
      if (contracted?.type !== 'retrieval/query-contracted' || projected?.type !== 'retrieval/context-projected') {
        throw new Error('automatic retrieval did not persist its contract and context')
      }
      expect(contracted.data.spec.originalQuery).toBe(rawQuery)
      expect(contracted.data.contract).toMatchObject({
        target: 'ranked_cases', requestedCount: 20, countPolicy: 'adaptive',
      })
      expect(contracted.data.spec.normalizedQuery).toBe('副卡解绑后流量仍然共享')
      const snapshotText = snapshotMessage?.content.find(block => block.type === 'text')?.text
      expect(snapshotText).toBe(projected.data.selection.rendered)
      expect(projected.data.selection.rendered).toContain('<retrieval_state>')
      expect(ctx.retrievalAgent.current(agent).query.original).toBe(rawQuery)

      const nextDirect = createUserMessage({
        content: [{ type: 'text', text: '第二次查询' }],
        source: { kind: 'user' },
      })
      const nextDecision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [nextDirect], turn: 2, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [nextDirect] }),
      )
      expect(nextDecision.kind).toBe('enter')
      if (nextDecision.kind !== 'enter') throw new Error('second pre-step unexpectedly rejected')
      expect(nextDecision.messages).toEqual([])
      expect(readRetrievalSessionEvents(session)
        .filter(event => event.type === 'retrieval/query-contracted')
        .map(event => event.data.spec.originalQuery)).toEqual([rawQuery, '第二次查询'])
      expect(ctx.retrievalAgent.current(agent).query.original).toBe('第二次查询')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not start a retrieval for a direct message rejected downstream', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(StubTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { adaptiveMaxResults: 20 })
      const session = Session.create(SessionId('rejected-pre-step'))
      const agent = sessionAgent(session)
      const direct = createUserMessage({ content: [{ type: 'text', text: '不应启动' }], source: { kind: 'user' } })

      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [direct], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'reject' as const }),
      )

      expect(decision).toEqual({ kind: 'reject' })
      expect(ctx.retrievalAgent.currentOrUndefined(agent)).toBeUndefined()
      expect(readRetrievalSessionEvents(session)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('takes a natural-language count through the public pre-step path to a Harness-owned ticket collection', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { adaptiveMaxResults: 20 })
      const session = Session.create(SessionId('natural-product-path'))
      const agent = sessionAgent(session)
      const direct = createUserMessage({
        content: [{ type: 'text', text: '帮我找两条副卡解绑后流量共享的工单' }],
        source: { kind: 'user' },
      })

      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [direct], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [direct] }),
      )
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('natural product entry unexpectedly rejected')
      expect(decision.messages).toHaveLength(2)

      let state = ctx.retrievalAgent.current(agent)
      expect(state.task).toMatchObject({ target: 'ranked_cases', requestedCount: 2, countPolicy: 'explicit' })
      expect(state.query.spec.normalizedQuery).toBe('副卡解绑后流量共享')
      expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'continue', coverage: 0.5, candidateQuality: 0.7,
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'vector_search', stop: false,
      })
      state = await ctx.retrievalAgent.search(agent, {
        mode: 'dense', delta: { kind: 'semantic_hint', text: '解绑后仍共享' },
      })
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'sufficient', coverage: 0.9, candidateQuality: 0.9,
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'finish', stop: true,
      })

      expect(createTicketResultCollection(state)).toMatchObject({
        type: 'ticket_collection', complete: true, stoppingReason: 'sufficient',
        tickets: [{ displayId: 'TKT-3' }, { displayId: 'TKT-1' }],
      })
      expect(readRetrievalSessionEvents(session).map(event => event.type)).toContain('retrieval/knowledge-assessed')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('connects direct-user pre-step, registered tools, repair search, and the terminal collection in one path', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { adaptiveMaxResults: 20 })
      installRetrievalTools(ctx, ctx.retrievalAgent, { maxFinishReminders: 3 })

      const session = Session.create(SessionId('registered-tool-product-path'))
      const agent = sessionAgent(session)
      const direct = createUserMessage({
        content: [{ type: 'text', text: '帮我找两条副卡解绑后流量共享的工单' }],
        source: { kind: 'user' },
      })
      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [direct], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [direct] }),
      )
      expect(decision.kind).toBe('enter')

      let state = ctx.retrievalAgent.current(agent)
      const firstAssessment = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('assess-initial'),
        name: 'ticket_assess_state',
        arguments: {
          decision: 'continue', coverage: 0.5, candidate_quality: 0.7,
          selected_candidate_refs: state.candidates.map(candidate => candidate.ref),
          excluded_candidate_refs: [], gaps: [], next_action: 'vector_search', stop: false,
        },
        agent,
      })
      expect(firstAssessment).toMatchObject({ isError: false, value: { phase: 'assessed' } })

      const repaired = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('vector-repair'),
        name: 'ticket_vector_search',
        arguments: { semantic_hint: '解绑后仍共享' },
        agent,
      })
      expect(repaired).toMatchObject({ isError: false, value: { phase: 'assessed' } })

      state = ctx.retrievalAgent.current(agent)
      const terminal = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('assess-finish'),
        name: 'ticket_assess_state',
        arguments: {
          decision: 'sufficient', coverage: 0.9, candidate_quality: 0.9,
          selected_candidate_refs: state.candidates.map(candidate => candidate.ref),
          excluded_candidate_refs: [], gaps: [], next_action: 'finish', stop: true,
        },
        agent,
      })

      expect(terminal).toMatchObject({
        isError: false,
        concludesTurn: true,
        value: {
          type: 'ticket_collection', complete: true, stoppingReason: 'sufficient',
          tickets: [{ displayId: 'TKT-3' }, { displayId: 'TKT-1' }],
        },
      })
      expect(ctx.ticketRetrievalProvider).toMatchObject({ modes: ['hybrid', 'dense'] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes the assessed search loop and lets Harness freeze the selected collection', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      const agent = {
        session: Session.create(SessionId('parallel-search-agent')),
      } as Agent
      let state = await ctx.retrievalAgent.start(agent, {
        target: 'ranked_cases',
        query: '副卡',
        requestedCount: 3,
      })

      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'continue', coverage: 0.4, candidateQuality: 0.5,
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'keyword_search', stop: false,
      })
      state = await ctx.retrievalAgent.search(agent, {
        mode: 'keyword', delta: { kind: 'add_terms', terms: ['解绑'] },
      })
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'continue', coverage: 0.6, candidateQuality: 0.7,
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'vector_search', stop: false,
      })
      state = await ctx.retrievalAgent.search(agent, {
        mode: 'dense', delta: { kind: 'semantic_hint', text: '解绑后仍共享' },
      })
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'sufficient', coverage: 1, candidateQuality: 0.9,
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'finish', stop: true,
      })

      expect(state.candidateHistory.map(candidate => candidate.displayId)).toEqual(['TKT-1', 'TKT-2', 'TKT-3'])
      expect(state).toMatchObject({ phase: 'stopped', termination: 'sufficient', frozenEvidence: { complete: true } })
      expect(ctx.ticketRetrievalProvider).toMatchObject({ modes: ['hybrid', 'keyword', 'dense'] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
