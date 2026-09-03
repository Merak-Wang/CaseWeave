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
  type L3DetailsReadRequest,
  type TicketRetrievalRequest,
  type TicketRetrievalSpec,
  type TicketSearchPage,
  type TicketSearchOptions,
  type TicketSnapshot,
} from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/ticket-collection'
import { readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import type { QueryAnalysisResponse, TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'
import { installRetrievalRuntimeBudget } from './context-budget.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { RetrievalAgentService } from './service.js'
import { installRetrievalTools } from './tools.js'
import { testRetrievalPolicy } from '../../../tests/support/retrieval-policy.js'

const SIGNAL = new AbortController().signal
const POLICY = testRetrievalPolicy()

const QUERY_ANALYZER: TicketQueryAnalyzer = {
  async analyze(query: string): Promise<QueryAnalysisResponse> {
    const keyword = query.includes('副卡解绑后流量仍然共享') ? '副卡解绑后流量仍然共享'
      : query.includes('副卡解绑后流量共享') ? '副卡解绑后流量共享'
        : query.trim()
    const start = query.indexOf(keyword)
    return {
      protocolVersion: 'retrieval-agent.models.v1', requestId: 'fixture',
      analyzer: {
        engine: 'spacy', engineVersion: '3.8.7', pipeline: 'zh_core_web_sm-3.8.0',
        pipelineVersion: '3.8.0', lexiconVersion: 'telecom-query-phrases-v1', loaded: true,
        components: ['tagger', 'parser'],
      },
      language: 'zh', keywords: [keyword],
      candidates: [{ text: keyword, start, end: start + keyword.length, source: 'pos', pos: ['NOUN'] }],
      tokens: [{
        text: keyword, start, end: start + keyword.length, lemma: keyword, pos: 'NOUN', tag: 'NN',
        dep: 'ROOT', head: 0, isStop: false, entityType: '',
      }],
      entities: [], triples: [],
      ...(query.includes('两条') ? { requestedCount: 2 } : {}),
      elapsedMs: 1,
    }
  },
}

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
  readonly operations: string[] = []
  constructor(ctx: Context) { super(ctx, 'ticketPrincipalProvider') }

  resolve(request: { readonly operation: string }) {
    this.operations.push(request.operation)
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
      ...(request.requestedCount === undefined ? {} : { requestedCount: request.requestedCount }),
      countPolicy: request.countPolicy ?? (request.requestedCount === undefined ? 'adaptive' : 'explicit'),
      mode: request.mode ?? 'keyword',
      filters: request.filters ?? [],
      ambiguities: request.ambiguities ?? [],
      excludedTerms: [],
      semanticHints: [],
      compilerVersion: 'cordis-proxy-query-v1',
    }
  }

  openSnapshot(): Promise<TicketSnapshot> {
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
        l3DetailsRead: false,
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
      boundary: {
        authorizedCorpusSize: 0,
        documentsAfterStructuredFilters: 0,
        documentsEligibleForKeywordChannel: 0,
        rankedHits: 0,
        resultPagesExhausted: true,
        semanticRecallKnown: false,
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
        evidenceLevel: 'L2' as const,
        rank: 1,
        title: `工单 ${suffix}`,
        summary: `工单 ${suffix} 摘要`,
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
      boundary: {
        authorizedCorpusSize: 3,
        documentsAfterStructuredFilters: 3,
        documentsEligibleForKeywordChannel: 1,
        rankedHits: 1,
        resultPagesExhausted: true,
        semanticRecallKnown: false,
      },
    }
  }
}

class RawTicketProvider extends UnionTicketProvider {
  readonly l3Requests: L3DetailsReadRequest[] = []

  override async openSnapshot() {
    const snapshot = await super.openSnapshot()
    return {
      ...snapshot,
      fieldCatalog: [{
        key: 'source.raw', label: '原始载荷', valueKind: 'raw_json' as const, accessLevel: 'L3' as const,
        filterOperators: [], sensitivity: 'source_controlled' as const,
      }],
      capabilities: { ...snapshot.capabilities, l3DetailsRead: true },
    }
  }

  override async search(principal: unknown, snapshotId: TicketSnapshotId, query: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
    const page = await super.search(principal, snapshotId, query, options)
    if (query.mode !== 'hybrid' || page.candidates.length === 0) return page
    const secondRef = TicketCandidateRef('candidate-2')
    const second = {
      ...page.candidates[0]!, ref: secondRef, displayId: 'TKT-2', contentHash: 'hash-2', rank: 2,
      title: '工单 2', summary: '工单 2 摘要',
    }
    return {
      ...page,
      candidates: [...page.candidates, second], returned: 2,
      trace: {
        ...page.trace,
        signals: [...page.trace.signals, { candidateRef: secondRef, finalRank: 2, fusedScore: 0.5, channels: [] }],
      },
      boundary: { ...page.boundary, rankedHits: 2 },
    }
  }

  readL3Details(_principal: unknown, request: L3DetailsReadRequest) {
    this.l3Requests.push(request)
    return Promise.resolve({
      snapshotId: request.snapshotId,
      requestedCandidateRefs: [...request.candidateRefs],
      details: request.candidateRefs.map((candidateRef, index) => ({
        candidateRef,
        displayId: `TKT-${index + 1}`,
        sourceVersion: 'fixture-v1',
        contentHash: `hash-${index + 1}`,
        source: { datasetId: 'tickets', datasetVersion: 'v1', schemaVersion: 'raw-v1', recordId: `TKT-${index + 1}` },
        rawPayload: { ticket: `TKT-${index + 1}`, status: 'closed' },
        trust: 'untrusted_ticket_evidence' as const,
      })),
      warnings: [],
    })
  }
}

class FirstRequestAnswerAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = '当前标题与摘要已经足以回答。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('RetrievalAgentService Cordis binding', () => {
  it('does not let a natural-language first response end an active retrieval', async () => {
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
      await ctx.plugin(RetrievalAgentService, { policy: POLICY, maxContextTokens: 4_096 })
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
      installRetrievalTools(ctx, ctx.retrievalAgent, { maxFinishReminders: 1 })
      installRetrievalRuntimeBudget(ctx, ctx.retrievalAgent)
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })

      const adapter = new FirstRequestAnswerAdapter()
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

      expect(adapter.requests).toHaveLength(2)
      const request = adapter.requests[0]!
      expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'ticket_assess_state', 'ticket_bm25_search', 'ticket_rag_search',
      ]))
      expect(request.tools?.map(tool => tool.name)).not.toContain('ticket_read_details')
      expect(request.tools?.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
        'ticket_continue_ranking', 'ticket_expand_detail',
        'ticket_request_clarification', 'ticket_answer_clarification', 'ticket_state',
      ]))
      expect(request.messages.flatMap(message => message.content)
        .some(block => block.type === 'text' && block.text.includes('<ticket_knowledge_context>'))).toBe(true)
      expect(ctx.retrievalAgent.current(handle.agent)).toMatchObject({
        phase: 'stopped', termination: 'partial',
        task: { target: 'ranked_cases', countPolicy: 'adaptive', completenessRequirement: 'top_k' },
        budget: { modelStepsUsed: 2, successfulToolCalls: 0, failedToolCalls: 0 },
      })
      const requests = readRetrievalSessionEvents(handle.agent.session)
        .filter(event => event.type === 'retrieval/model-request-measured')
      expect(requests).toHaveLength(2)
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
      await ctx.plugin(RetrievalAgentService, { policy: POLICY })
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

  it('reauthorizes multiple current tickets through one atomic L3 provider call', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(RawTicketProvider)
      await ctx.plugin(RetrievalAgentService, { policy: POLICY })
      const agent = sessionAgent(Session.create(SessionId('raw-detail-agent')))
      let state = await ctx.retrievalAgent.start(agent, {
        target: 'ranked_cases', query: '副卡', requestedCount: 5,
      })

      const refs = state.candidates.map(candidate => candidate.ref)
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'continue', evaluator: 'model',
        selectedCandidateRefs: refs, excludedCandidateRefs: [],
        gaps: [{
          kind: 'depth', status: 'open', evaluator: 'model', evidenceRefs: refs,
          description: 'L2 摘要不足以核对原始处理记录。',
        }],
        nextAction: 'read_l3_details',
      })
      const detail = await ctx.retrievalAgent.readL3Details(agent, refs)

      expect(detail).toEqual({
        snapshotId: state.snapshot?.snapshotId,
        requestedCandidateRefs: refs,
        details: refs.map((candidateRef, index) => ({
          candidateRef,
          displayId: `TKT-${index + 1}`,
          sourceVersion: 'fixture-v1',
          contentHash: `hash-${index + 1}`,
          source: { datasetId: 'tickets', datasetVersion: 'v1', schemaVersion: 'raw-v1', recordId: `TKT-${index + 1}` },
          rawPayload: { ticket: `TKT-${index + 1}`, status: 'closed' },
          trust: 'untrusted_ticket_evidence',
        })),
        warnings: [],
      })
      expect(ctx.ticketRetrievalProvider).toMatchObject({
        l3Requests: [{
          snapshotId: state.snapshot?.snapshotId,
          candidateRefs: refs,
          purpose: 'model_ticket_load',
        }],
      })
      expect(ctx.ticketPrincipalProvider).toMatchObject({ operations: ['snapshot_open', 'l3_details_read'] })
      expect(readRetrievalSessionEvents(agent.session)).toContainEqual(expect.objectContaining({ type: 'retrieval/l3-details-read' }))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the selected model capacity by default instead of the obsolete 8192-token product limit', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService, { policy: POLICY })
      const session = Session.create(SessionId('context-admission-agent'))
      const agent = sessionAgent(session)
      await ctx.retrievalAgent.start(agent, { target: 'ranked_cases', query: '副卡' })

      await expect(ctx.retrievalAgent.admitModelRequest(agent, {
        estimatedInputTokens: 14_674, serializationBytes: 80_685, wallClockElapsedMs: 1,
        modelContextWindow: 1_000_000,
      })).resolves.toMatchObject({ accepted: true })
      await expect(ctx.retrievalAgent.admitModelRequest(agent, {
        estimatedInputTokens: 1_000_001, serializationBytes: 1_100, wallClockElapsedMs: 2,
        modelContextWindow: 1_000_000,
      })).resolves.toMatchObject({ accepted: false })

      expect(ctx.retrievalAgent.current(agent)).toMatchObject({
        phase: 'stopped', termination: 'budget_exhausted',
        budget: { modelStepsUsed: 1, totalInputTokens: 14_674, serializationBytes: 80_685 },
        frozenEvidence: { stoppingReason: 'budget_exhausted' },
      })
      expect(ctx.retrievalAgent.current(agent).frozenEvidence?.candidates.length).toBeGreaterThan(0)
      const requests = readRetrievalSessionEvents(session)
        .filter(event => event.type === 'retrieval/model-request-measured')
      expect(requests.map(event => event.data.accepted)).toEqual([true, false])
      expect(requests.at(-1)?.data).toMatchObject({
        modelContextWindow: 1_000_000,
        effectiveContextLimit: 1_000_000,
        rejectionReason: 'model_context',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps an explicit deployment context cap as a narrower operator override', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService, { policy: POLICY, maxContextTokens: 4_096 })
      const session = Session.create(SessionId('deployment-context-admission-agent'))
      const agent = sessionAgent(session)
      await ctx.retrievalAgent.start(agent, { target: 'ranked_cases', query: '副卡' })

      await expect(ctx.retrievalAgent.admitModelRequest(agent, {
        estimatedInputTokens: 4_097, serializationBytes: 1_100, wallClockElapsedMs: 2,
        modelContextWindow: 1_000_000,
      })).resolves.toMatchObject({ accepted: false })
      expect(readRetrievalSessionEvents(session)
        .findLast(event => event.type === 'retrieval/model-request-measured')?.data).toMatchObject({
        deploymentContextLimit: 4_096,
        effectiveContextLimit: 4_096,
        rejectionReason: 'deployment_context',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('persists an explicit budget_exhausted stop when the wall-clock hook fires', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService, { policy: POLICY, maxLatencyMs: 120_000 })
      const session = Session.create(SessionId('wall-clock-budget-agent'))
      const agent = sessionAgent(session)
      await ctx.retrievalAgent.start(agent, { target: 'ranked_cases', query: '副卡' })

      await expect(ctx.retrievalAgent.stopForWallClockBudget(agent)).resolves.toMatchObject({
        phase: 'stopped',
        termination: 'budget_exhausted',
      })
      expect(ctx.retrievalAgent.current(agent)).toMatchObject({
        phase: 'stopped',
        termination: 'budget_exhausted',
        frozenEvidence: { stoppingReason: 'budget_exhausted' },
      })
      expect(ctx.retrievalAgent.current(agent).frozenEvidence?.candidates.length).toBeGreaterThan(0)
      expect(readRetrievalSessionEvents(session).filter(event => event.type === 'retrieval/stopped').at(-1)?.data)
        .toMatchObject({ reason: 'budget_exhausted' })
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
      await ctx.plugin(RetrievalAgentService, { policy: POLICY })
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })

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
        target: 'ranked_cases', countPolicy: 'adaptive',
      })
      expect(contracted.data.queryContract).toMatchObject({
        schemaVersion: 7, resultPolicy: 'adaptive_top_k',
      })
      expect(contracted.data.queryContract).not.toHaveProperty('maxResults')
      expect(contracted.data.queryContract).not.toHaveProperty('resultLimit')
      expect(contracted.data.spec.normalizedQuery).toBe('副卡解绑后流量仍然共享')
      const snapshotText = snapshotMessage?.content.find(block => block.type === 'text')?.text
      expect(snapshotText).toBe(projected.data.selection.rendered)
      expect(projected.data.selection.rendered).toContain('<ticket_knowledge_context>')
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
      await ctx.plugin(RetrievalAgentService, { policy: POLICY })
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
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
      await ctx.plugin(RetrievalAgentService, { policy: POLICY })
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
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
      expect(state.query.spec.normalizedQuery).toBe('帮我找两条副卡解绑后流量共享的工单')
      expect(state.query.contract?.fastQuery).toMatchObject({
        rewriteApplied: false,
        keyword: { terms: ['副卡解绑后流量共享'], operator: 'and' },
        vector: { text: '帮我找两条副卡解绑后流量共享的工单' },
      })
      expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'continue', evaluator: 'model',
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'vector_search',
      })
      state = await ctx.retrievalAgent.search(agent, {
        mode: 'dense', delta: { kind: 'semantic_hint', text: '解绑后仍共享' },
      })
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'accept_current_top_k', evaluator: 'model',
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'accept_current_top_k',
      })

      expect(createTicketResultCollection(state)).toMatchObject({
        type: 'ticket_collection', complete: false, topKAccepted: true, stoppingReason: 'top_k_accepted',
        tickets: [{ displayId: 'TKT-3' }, { displayId: 'TKT-1' }],
      })
      expect(readRetrievalSessionEvents(session).map(event => event.type)).toContain('retrieval/knowledge-assessed')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('connects direct-user pre-step, RAG, and the structured assessment tool', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService, { policy: POLICY })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
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

      const repaired = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('rag-repair'),
        name: 'ticket_rag_search',
        arguments: { query: '解绑后仍共享' },
        agent,
      })
      expect(repaired).toMatchObject({ isError: false, value: { phase: 'assessed' } })
      expect(Buffer.byteLength(repaired.content.find(block => block.type === 'text')?.text ?? '', 'utf8')).toBeLessThan(4_096)
      expect(ctx.tools.schemas().map(tool => tool.name)).toContain('ticket_assess_state')
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
      await ctx.plugin(RetrievalAgentService, { policy: POLICY })
      const agent = {
        session: Session.create(SessionId('parallel-search-agent')),
      } as Agent
      let state = await ctx.retrievalAgent.start(agent, {
        target: 'ranked_cases',
        query: '副卡',
        requestedCount: 3,
      })

      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'continue', evaluator: 'model',
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'keyword_search',
      })
      state = await ctx.retrievalAgent.search(agent, {
        mode: 'keyword', delta: { kind: 'add_terms', terms: ['解绑'] },
      })
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'continue', evaluator: 'model',
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'vector_search',
      })
      state = await ctx.retrievalAgent.search(agent, {
        mode: 'dense', delta: { kind: 'semantic_hint', text: '解绑后仍共享' },
      })
      state = await ctx.retrievalAgent.assess(agent, {
        decision: 'accept_current_top_k', evaluator: 'model',
        selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
        gaps: [], nextAction: 'accept_current_top_k',
      })

      expect(state.candidateHistory.map(candidate => candidate.displayId)).toEqual(['TKT-1', 'TKT-2', 'TKT-3'])
      expect(state).toMatchObject({
        phase: 'stopped', termination: 'top_k_accepted',
        frozenEvidence: { complete: false, topKAccepted: true, resultPagesExhausted: true },
      })
      expect(ctx.ticketRetrievalProvider).toMatchObject({ modes: ['hybrid', 'keyword', 'dense'] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
