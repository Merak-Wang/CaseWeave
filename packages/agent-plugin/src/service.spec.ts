import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  CallId,
  createUserMessage,
  LlmAdapter,
  default as LlmRuntime,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
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
import { installRetrievalRuntimeBudget } from './context-budget.js'
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

class FirstRequestAssessmentAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const id = CallId('first-request-assessment')
    const argumentsText = JSON.stringify({ outcome: { verdict: 'sufficient' } })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'ticket_assess_state', argumentsDelta: argumentsText }
    yield {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id, name: 'ticket_assess_state', arguments: argumentsText },
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

describe('RetrievalAgentService Cordis binding', () => {
  it('completes through the public DSH loop with state and assessment available in the first request', async () => {
    const ctx = new Context()
    let disposeAgent: (() => Promise<void>) | undefined
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(TokenMeter)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService, { maxContextTokens: 4_096 })
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { adaptiveMaxResults: 20 })
      installRetrievalTools(ctx, ctx.retrievalAgent)
      installRetrievalRuntimeBudget(ctx, ctx.retrievalAgent)
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })

      const adapter = new FirstRequestAssessmentAdapter()
      ctx.llm.registerAdapter(['fixture-loop'], adapter)
      const handle = await ctx.agents.create({
        sessionId: SessionId('public-first-request-path'),
        agentOptions: { provider: 'fixture-loop', model: 'fixture-model' },
      })
      disposeAgent = handle.dispose
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '帮我找找副卡有关工单' }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()

      expect(adapter.requests).toHaveLength(1)
      const request = adapter.requests[0]!
      expect(request.tools?.map(tool => tool.name)).toEqual(['ticket_assess_state'])
      expect(request.messages.flatMap(message => message.content)
        .some(block => block.type === 'text' && block.text.includes('<retrieval_state>'))).toBe(true)
      expect(ctx.retrievalAgent.current(handle.agent)).toMatchObject({
        phase: 'stopped', termination: 'sufficient',
        frozenEvidence: { complete: false, topKAccepted: true, sourceExhausted: false },
        budget: { modelStepsUsed: 1, successfulToolCalls: 1, failedToolCalls: 0 },
      })
      const requests = readRetrievalSessionEvents(handle.agent.session)
        .filter(event => event.type === 'retrieval/model-request-measured')
      expect(requests).toHaveLength(1)
      expect(requests[0]?.data).toMatchObject({ accepted: true })
      expect(requests[0]?.data.estimatedInputTokens).toBeLessThanOrEqual(4_096)
      expect(handle.agent.session.events.filter(event => event.type === 'request/header')).toHaveLength(1)
    } finally {
      if (disposeAgent !== undefined) await disposeAgent()
      await ctx.fiber.dispose()
    }
  })

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

  it('admits 4096-token requests and rejects the next request above the hard context limit', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService, { maxContextTokens: 4_096 })
      const session = Session.create(SessionId('context-admission-agent'))
      const agent = sessionAgent(session)
      await ctx.retrievalAgent.start(agent, { target: 'ranked_cases', query: '副卡' })

      await expect(ctx.retrievalAgent.admitModelRequest(agent, {
        estimatedInputTokens: 4_096, serializationBytes: 1_000, wallClockElapsedMs: 1,
      })).resolves.toMatchObject({ accepted: true })
      await expect(ctx.retrievalAgent.admitModelRequest(agent, {
        estimatedInputTokens: 4_097, serializationBytes: 1_100, wallClockElapsedMs: 2,
      })).resolves.toMatchObject({ accepted: false })

      expect(ctx.retrievalAgent.current(agent)).toMatchObject({
        phase: 'stopped', termination: 'budget_exhausted',
        budget: { modelStepsUsed: 1, totalInputTokens: 4_096, serializationBytes: 1_000 },
      })
      expect(readRetrievalSessionEvents(session)
        .filter(event => event.type === 'retrieval/model-request-measured')
        .map(event => event.data.accepted)).toEqual([true, false])
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
        type: 'ticket_collection', complete: false, topKAccepted: true, stoppingReason: 'sufficient',
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
          outcome: { verdict: 'continue', next: { type: 'vector_search' } },
        },
        agent,
      })
      expect(firstAssessment).toMatchObject({ isError: false, value: { phase: 'assessed' } })
      const firstAssessmentText = firstAssessment.content.find(block => block.type === 'text')?.text ?? ''
      expect(Buffer.byteLength(firstAssessmentText, 'utf8')).toBeLessThan(4_096)
      expect(firstAssessmentText).not.toContain('candidate-1')
      expect(firstAssessmentText).not.toContain('fieldCatalog')

      const repaired = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('vector-repair'),
        name: 'ticket_vector_search',
        arguments: { semantic_hint: '解绑后仍共享' },
        agent,
      })
      expect(repaired).toMatchObject({ isError: false, value: { phase: 'assessed' } })
      expect(Buffer.byteLength(repaired.content.find(block => block.type === 'text')?.text ?? '', 'utf8')).toBeLessThan(4_096)

      state = ctx.retrievalAgent.current(agent)
      const terminal = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('assess-finish'),
        name: 'ticket_assess_state',
        arguments: { outcome: { verdict: 'sufficient' } },
        agent,
      })

      expect(terminal).toMatchObject({
        isError: false,
        concludesTurn: true,
        value: {
          type: 'ticket_collection', complete: false, topKAccepted: true, stoppingReason: 'sufficient',
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
      expect(state).toMatchObject({
        phase: 'stopped', termination: 'sufficient',
        frozenEvidence: { complete: false, topKAccepted: true, sourceExhausted: false },
      })
      expect(ctx.ticketRetrievalProvider).toMatchObject({ modes: ['hybrid', 'keyword', 'dense'] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
