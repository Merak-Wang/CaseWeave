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
import { describe, expect, it, vi } from 'vitest'
import {
  RetrievalError,
  TicketCandidateRef,
  TicketEvidenceId,
  type EvidenceReadRequest,
  TicketSnapshotId,
  type TicketRetrievalRequest,
  type TicketRetrievalSpec,
  type TicketSearchPage,
  type TicketSearchOptions,
  type TicketSnapshot,
} from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/domain/result'
import { readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import { foldRetrievalEvents } from '@retrieval-agent/domain'
import type { QueryAnalysisResponse, TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'
import { installRetrievalRuntimeBudget } from './context-budget.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { RetrievalAgentService } from './service.js'
import { installRetrievalTools } from './tools.js'

const SIGNAL = new AbortController().signal

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

class TwoCandidateTicketProvider extends UnionTicketProvider {
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
  it('keeps a working state larger than 8K under the requested 256K ceiling and respects smaller model windows', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      const session = Session.create(SessionId('large-working-context'))
      const agent = sessionAgent(session)
      session.append('request/context', { provider: 'mock', model: 'model', contextWindow: 1_000_000 })
      const query = '副卡解绑。' + '保留处理记录与原始业务要求。'.repeat(800)
      await ctx.retrievalAgent.start(agent, { target: 'ranked_cases', query })
      await expect(ctx.retrievalAgent.projectContext(agent, 8000)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
      const selection = await ctx.retrievalAgent.projectContext(agent)
      expect(selection.tokenBudget).toBe(262_144)
      expect(selection.estimatedTokens).toBeGreaterThan(8000)
      expect(selection.rendered).toContain(query)
      expect(ctx.retrievalAgent.current(agent).phase).not.toBe('stopped')
      session.append('request/context', { provider: 'mock', model: 'smaller-model', contextWindow: 32_768 })
      expect(ctx.retrievalAgent.workingContextBudget(agent)).toBeLessThan(32_768)
      expect(ctx.retrievalAgent.workingContextBudget(agent)).toBeGreaterThan(8000)
      await expect(ctx.retrievalAgent.projectContext(agent, 25)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
    } finally { await ctx.fiber.dispose() }
  })

  it('automatically retries an unstructured model response before explicit failure while retaining unjudged candidates', async () => {
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
      // This exercises protocol repair, with a declared 32K request envelope. The
      // separate 4K admission test below owns the insufficient-capacity behavior.
      await ctx.plugin(RetrievalAgentService, { maxContextTokens: 32_768 })
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
      installRetrievalTools(ctx, ctx.retrievalAgent)
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

      expect(adapter.requests).toHaveLength(3)
      // 用户输入在 pre-step 提前落库后不能被 DSH 重复追加；快照是 plugin 来源，不计入。
      expect(handle.agent.session.events
        .filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('"kind":"user"')))
        .toHaveLength(1)
      const request = adapter.requests[0]!
      expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'ticket_decide',
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
        budget: { modelStepsUsed: 3, successfulToolCalls: 0, failedToolCalls: 0 },
      })
      const requests = readRetrievalSessionEvents(handle.agent.session)
        .filter(event => event.type === 'retrieval/model-request-measured')
      expect(requests).toHaveLength(3)
      expect(requests[0]?.data).toMatchObject({ accepted: true })
      expect(requests[0]?.data.estimatedInputTokens).toBeLessThanOrEqual(32_768)
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

  it('reauthorizes multiple current tickets in one controlled detail read and rejects raw fields', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(PublicEvidenceProvider)
      await ctx.plugin(RetrievalAgentService)
      const agent = sessionAgent(Session.create(SessionId('controlled-detail-agent')))
      let state = await ctx.retrievalAgent.start(agent, {
        target: 'ranked_cases', query: '副卡', requestedCount: 5,
      })

      const refs = state.candidates.map(candidate => candidate.ref)
      await ctx.retrievalAgent.projectContext(agent)
      state = await ctx.retrievalAgent.decide(agent, {
        stateId: ctx.retrievalAgent.current(agent).stateId, judgments: [],
        gaps: [{
          kind: 'depth', status: 'open', evaluator: 'model', evidenceRefs: refs,
          description: '标题和摘要不足以核对解绑处理过程。',
        }],
        action: { kind: 'inspect', candidateRefs: refs, fields: ['resolution'] },
      })
      expect(state.promotedEvidence).toEqual(refs.map((candidateRef, index) => expect.objectContaining({
          candidateRef,
          evidenceId: `evidence-${candidateRef}-resolution`,
          displayId: `TKT-${index + 1}`,
          sourceVersion: 'fixture-v1',
          contentHash: `hash-${index + 1}`,
          snapshotId: state.snapshot?.snapshotId,
          field: 'resolution', evidenceLevel: 'L2', readers: ['provider'],
          text: '经核对，副卡解绑延迟同步，重新同步后共享关系解除。',
          trust: 'untrusted_ticket_evidence',
        })))
      expect(ctx.ticketRetrievalProvider).toMatchObject({
        evidenceRequests: [{
          snapshotId: state.snapshot?.snapshotId,
          candidateRefs: refs,
          fields: ['resolution'],
        }],
      })
      expect(ctx.ticketPrincipalProvider).toMatchObject({ operations: ['snapshot_open', 'evidence_read'] })
      expect(readRetrievalSessionEvents(agent.session)).toContainEqual(expect.objectContaining({ type: 'retrieval/evidence-promoted' }))
      const context = await ctx.retrievalAgent.projectContext(agent)
      expect(context.includedEvidenceIds).toEqual(state.promotedEvidence.map(evidence => evidence.evidenceId))
      const visible = ctx.retrievalAgent.current(agent)
      await expect(ctx.retrievalAgent.decide(agent, {
        stateId: visible.stateId, judgments: [],
        gaps: [{ kind: 'depth', status: 'open', evaluator: 'model', evidenceRefs: refs, description: '仍需核对处理过程。' }],
        action: { kind: 'inspect', candidateRefs: refs, fields: ['source.raw'] },
      })).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
      expect((ctx.ticketRetrievalProvider as unknown as PublicEvidenceProvider).evidenceRequests).toHaveLength(1)
      expect(ctx.retrievalAgent.current(agent).promotedEvidence).toEqual(visible.promotedEvidence)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the selected model capacity by default instead of the obsolete 8192-token product limit', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
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
      expect(createTicketResultCollection(ctx.retrievalAgent.current(agent))).not.toHaveProperty('undeterminedCandidates')
      expect(ctx.retrievalAgent.current(agent).candidates.length).toBeGreaterThan(0)
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
      await ctx.plugin(RetrievalAgentService, { maxContextTokens: 4_096 })
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

  it('keeps measured model steps and wall-clock time observational instead of terminating the task', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      const session = Session.create(SessionId('observed-not-terminated-agent'))
      const agent = sessionAgent(session)
      const started = await ctx.retrievalAgent.start(agent, { target: 'ranked_cases', query: '副卡' })
      expect(started.phase).not.toBe('stopped')

      for (let step = 0; step < 10; step += 1) {
        await expect(ctx.retrievalAgent.admitModelRequest(agent, {
          estimatedInputTokens: 1_000, serializationBytes: 1_100,
          wallClockElapsedMs: 600_000 + step,
        })).resolves.toEqual({ accepted: true })
      }

      const current = ctx.retrievalAgent.current(agent)
      expect(current.phase).not.toBe('stopped')
      expect(current.termination).toBe('active')
      expect(current.budget).toMatchObject({ modelStepsUsed: 10, wallClockElapsedMs: 600_009 })
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
        schemaVersion: 8, resultPolicy: 'adaptive_top_k',
      })
      expect(contracted.data.queryContract).not.toHaveProperty('maxResults')
      expect(contracted.data.queryContract).not.toHaveProperty('resultLimit')
      expect(contracted.data.spec.normalizedQuery).toBe('副卡解绑后流量仍然共享')
      const snapshotText = snapshotMessage?.content.find(block => block.type === 'text')?.text
      expect(snapshotText).toBe(projected.data.selection.rendered)
      expect(projected.data.selection.rendered).toContain('<ticket_knowledge_context>')
      expect(ctx.retrievalAgent.current(agent).query.original).toBe(rawQuery)

      const nextDirect = createUserMessage({
        content: [{ type: 'text', text: '新任务：第二次查询' }],
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
        .map(event => event.data.spec.originalQuery)).toEqual([rawQuery, '新任务：第二次查询'])
      expect(ctx.retrievalAgent.current(agent).query.original).toBe('新任务：第二次查询')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('persists the accepted user message before a slow first ranking completes', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StubPrincipalProvider)
      let releaseSearch!: () => void
      const gate = new Promise<void>(resolve => { releaseSearch = resolve })
      class GatedTicketProvider extends UnionTicketProvider {
        override async search(principal: unknown, snapshotId: TicketSnapshotId, query: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
          await gate
          return super.search(principal, snapshotId, query, options)
        }
      }
      await ctx.plugin(GatedTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
      const session = Session.create(SessionId('slow-first-pass-visibility'))
      const agent = sessionAgent(session)
      const direct = createUserMessage({
        content: [{ type: 'text', text: '帮我找副卡解绑的工单' }],
        source: { kind: 'user' },
      })

      let settled = false
      const pending = agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [direct], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [direct] }),
      ).then(decision => { settled = true; return decision })

      // 首轮 Hybrid 排名仍被 Provider 阻塞期间，用户输入必须已经在 Session 表面可见。
      for (let flush = 0; flush < 20 && !settled; flush += 1) {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (session.events.some(event => event.type === 'user/message')) break
      }
      expect(settled).toBe(false)
      expect(session.events
        .filter(event => event.type === 'user/message')
        .map(event => event.data)).toEqual([direct])

      releaseSearch()
      const decision = await pending
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('pre-step unexpectedly rejected')
      // 返回给 DSH 的只剩快照；用户消息不重复落库。
      expect(decision.messages).toHaveLength(1)
      expect(decision.messages[0]?.source).toMatchObject({
        kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
      })
      expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
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
      await ctx.plugin(RetrievalAgentService)
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
      // 用户消息在首轮检索前已落库；返回给 DSH 的只剩知识状态快照。
      expect(decision.messages).toHaveLength(1)
      expect(decision.messages[0]?.source).toMatchObject({
        kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
      })
      const persistedUser = session.events.filter(event => event.type === 'user/message')
      expect(persistedUser.map(event => event.data)).toEqual([direct])
      const firstRetrievalSeq = session.events.find(event => event.type.startsWith('retrieval/'))?.seq
      expect(persistedUser[0]?.seq).toBeLessThan(firstRetrievalSeq ?? -1)

      let state = ctx.retrievalAgent.current(agent)
      expect(state.task).toMatchObject({ target: 'ranked_cases', requestedCount: 2, countPolicy: 'explicit' })
      expect(state.query.spec.normalizedQuery).toBe('帮我找两条副卡解绑后流量共享的工单')
      expect(state.query.contract?.fastQuery).toMatchObject({
        rewriteApplied: false,
        keyword: { terms: ['副卡解绑后流量共享'], operator: 'and' },
        vector: { text: '帮我找两条副卡解绑后流量共享的工单' },
      })
      expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
      state = await ctx.retrievalAgent.decide(agent, {
        stateId: state.stateId, judgments: [],
        gaps: [{ kind: 'coverage', status: 'open', evaluator: 'model', evidenceRefs: [TicketCandidateRef('candidate-1')], description: '当前只有一条，还缺一条相同业务案例。' }],
        action: { kind: 'search', mode: 'dense', delta: { kind: 'semantic_hint', text: '解绑后仍共享' } },
      })
      await ctx.retrievalAgent.projectContext(agent)
      state = await ctx.retrievalAgent.decide(agent, {
        stateId: ctx.retrievalAgent.current(agent).stateId,
        judgments: ['candidate-3', 'candidate-1'].map(ref => ({
          candidateRef: TicketCandidateRef(ref), verdict: 'accept' as const,
          evidenceRefs: [ref], reason: '已核对当前可见标题和摘要，支持要求的副卡解绑场景。',
        })), gaps: [], action: { kind: 'finish', reason: 'satisfied', explanation: '两条工单都符合副卡解绑场景，满足明确数量要求。' },
      })

      expect(createTicketResultCollection(state)).toMatchObject({
        type: 'ticket_collection', complete: false, topKAccepted: true, stoppingReason: 'top_k_accepted',
        tickets: [{ displayId: 'TKT-3' }, { displayId: 'TKT-1' }],
      })
      expect(readRetrievalSessionEvents(session).map(event => event.type)).toContain('retrieval/decision-submitted')
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
      await ctx.plugin(RetrievalAgentService)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
      installRetrievalTools(ctx, ctx.retrievalAgent)

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
        name: 'ticket_decide',
        arguments: { state_id: ctx.retrievalAgent.current(agent).stateId, judgments: [],
          semantic_gaps: [gap('coverage', ['c1'], '仍需要同类工单')],
          action: { kind: 'search', query: '解绑后仍共享' } },
        agent,
      })
      expect(repaired.isError, JSON.stringify(repaired)).toBe(false)
      expect(repaired.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('ticket_knowledge_context') })]))
      expect(ctx.tools.schemas().map(tool => tool.name)).toContain('ticket_decide')
      expect(ctx.ticketRetrievalProvider).toMatchObject({ modes: ['hybrid', 'dense'] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes judgment-and-action decisions and lets Harness freeze the selected collection', async () => {
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

      await ctx.retrievalAgent.projectContext(agent)
      state = await ctx.retrievalAgent.decide(agent, {
        stateId: ctx.retrievalAgent.current(agent).stateId, judgments: [],
        gaps: [{ kind: 'coverage', status: 'open', evaluator: 'model', evidenceRefs: [TicketCandidateRef('candidate-1')], description: '目前一条，还需要更多解绑案例。' }],
        action: { kind: 'search', mode: 'keyword', delta: { kind: 'add_terms', terms: ['解绑'] } },
      })
      await ctx.retrievalAgent.projectContext(agent)
      state = await ctx.retrievalAgent.decide(agent, {
        stateId: ctx.retrievalAgent.current(agent).stateId, judgments: [],
        gaps: [{ kind: 'coverage', status: 'open', evaluator: 'model', evidenceRefs: [TicketCandidateRef('candidate-2')], description: '已有两个候选，还需要一个共享关系案例。' }],
        action: { kind: 'search', mode: 'dense', delta: { kind: 'semantic_hint', text: '解绑后仍共享' } },
      })
      await ctx.retrievalAgent.projectContext(agent)
      state = await ctx.retrievalAgent.decide(agent, {
        stateId: ctx.retrievalAgent.current(agent).stateId,
        judgments: ['candidate-1', 'candidate-2', 'candidate-3'].map(ref => ({
          candidateRef: TicketCandidateRef(ref), verdict: 'accept' as const,
          evidenceRefs: [ref], reason: '当前可见工单标题和摘要符合副卡解绑后的共享问题。',
        })), gaps: [], action: { kind: 'finish', reason: 'satisfied', explanation: '三条工单符合任务要求。' },
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

  it('keeps persisted revisions linear when projection and metering meet an in-flight search', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      const agent = sessionAgent(Session.create(SessionId('queued-projection-agent')))
      const started = await ctx.retrievalAgent.start(agent, {
        target: 'ranked_cases', query: '副卡', requestedCount: 3,
      })

      // The keyword fixture sleeps inside the queued mutation; projection and
      // tool metering must queue behind it instead of writing sibling edges.
      const searching = ctx.retrievalAgent.search(agent, {
        mode: 'keyword', delta: { kind: 'add_terms', terms: ['解绑'] },
      })
      const [state, selection] = await Promise.all([
        searching,
        await ctx.retrievalAgent.projectContext(agent),
        ctx.retrievalAgent.recordToolCall(agent, { success: true, serializationBytes: 128 }),
      ])
      expect(state.revision).toBeGreaterThan(started.revision)
      expect(selection.includedCandidateRefs.length).toBeGreaterThan(0)

      const events = readRetrievalSessionEvents(agent.session)
        .filter(event => event.retrievalId === state.retrievalId)
      expect(events.filter(event => event.type === 'retrieval/context-projected')).toHaveLength(1)
      const folded = foldRetrievalEvents(events)
      expect(folded?.revision).toBe(ctx.retrievalAgent.current(agent).revision)
      expect(folded?.stateId).toBe(ctx.retrievalAgent.current(agent).stateId)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})


class PublicEvidenceProvider extends TwoCandidateTicketProvider {
  readonly evidenceRequests: EvidenceReadRequest[] = []
  revoked = false
  override async openSnapshot(): Promise<TicketSnapshot> {
    const snapshot = await super.openSnapshot()
    return { ...snapshot, fieldCatalog: [
      { key: 'region', label: '地域', valueKind: 'text' as const, accessLevel: 'L0' as const, filterOperators: ['eq' as const], sensitivity: 'non_sensitive' as const },
      { key: 'resolution', label: '处理过程', valueKind: 'text' as const, accessLevel: 'L2' as const, filterOperators: [], sensitivity: 'source_controlled' as const },
    ], capabilities: { ...snapshot.capabilities, evidencePromotion: true, detailRead: true } }
  }
  override async search(principal: unknown, snapshotId: TicketSnapshotId, query: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
    const initial = await super.search(principal, snapshotId, { ...query, mode: 'hybrid' }, options)
    const candidates = initial.candidates.map((candidate, index) => ({ ...candidate,
      title: index === 0 ? '北京副卡共享流量' : '上海副卡解绑后流量共享',
      summary: index === 0 ? '业务范围为北京' : '业务范围为上海，处理过程需深读',
      l0: { region: index === 0 ? '北京' : '上海' },
    })).filter(candidate => !query.filters.some(filter => filter.field === 'region' && candidate.l0.region !== filter.value))
    return { ...initial, candidates, returned: candidates.length, queryFingerprint: JSON.stringify(query.filters), appliedFilters: query.filters,
      trace: { ...initial.trace, requestedMode: query.mode, executedMode: query.mode,
        signals: initial.trace.signals.filter(signal => candidates.some(candidate => candidate.ref === signal.candidateRef)) },
      boundary: { ...initial.boundary, documentsAfterStructuredFilters: candidates.length, rankedHits: candidates.length } }
  }
  async status() { return { providerId: this.providerId, ready: true, readOnly: true as const, snapshotValid: true, sourceVersion: 'fixture-v1', warnings: [] } }
  async readEvidence(_principal: unknown, request: EvidenceReadRequest) {
    this.evidenceRequests.push(request)
    return { snapshotId: request.snapshotId, requestedCandidateRefs: request.candidateRefs,
      rejectedCandidateRefs: this.revoked ? request.candidateRefs : [], tokenBudget: request.tokenBudget, tokensUsed: request.fields.length ? 10 : 0,
      evidence: this.revoked ? [] : request.candidateRefs.flatMap(ref => request.fields.map(field => ({
        evidenceId: TicketEvidenceId(`evidence-${ref}-${field}`), candidateRef: ref,
        displayId: `TKT-${String(ref).split('-').at(-1)}`, sourceVersion: 'fixture-v1', contentHash: `hash-${String(ref).split('-').at(-1)}`,
        field, text: '经核对，副卡解绑延迟同步，重新同步后共享关系解除。', start: 0, end: '经核对，副卡解绑延迟同步，重新同步后共享关系解除。'.length, estimatedTokens: 10,
        trust: 'untrusted_ticket_evidence' as const, truncated: false,
      }))), warnings: [] }
  }
}
class TimingOutTicketProvider extends PublicEvidenceProvider {
  override async search(): Promise<TicketSearchPage> {
    throw new RetrievalError('TIMEOUT', 'RAG 排名请求超时。', { retryable: true })
  }
}
class ExpiringSnapshotProvider extends PublicEvidenceProvider {
  expired = false
  override async status() {
    return {
      providerId: this.providerId, ready: true, readOnly: true as const,
      snapshotValid: !this.expired, sourceVersion: 'fixture-v1', warnings: [],
    }
  }
}

async function publicSetup(query = '帮我找副卡工单', Provider: typeof PublicEvidenceProvider = PublicEvidenceProvider) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(StubPrincipalProvider)
  await ctx.plugin(Provider)
  await ctx.plugin(RetrievalAgentService)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
  installRetrievalTools(ctx, ctx.retrievalAgent)
  const agent = sessionAgent(Session.create(SessionId(`public-acceptance-${Math.random()}`)))
  const message = async (text: string, turn = 1) => {
    const direct = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    return await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [direct], turn, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [direct] }))
  }
  await message(query)
  const decide = (action: unknown, judgments: unknown[] = [], semantic_gaps: unknown[] = []) => ctx.tools.execute({
    signal: SIGNAL, callId: CallId(`decision-${Math.random()}`), name: 'ticket_decide', agent,
    arguments: { state_id: ctx.retrievalAgent.current(agent).stateId, judgments, semantic_gaps, action },
  })
  return { ctx, agent, message, decide }
}
const accept = (alias: string) => ({ candidate_alias: alias, verdict: 'accept', evidence_aliases: [alias], reason: '可见标题和摘要支持当前副卡业务要求。' })
const gap = (kind: string, aliases: string[], description: string) => ({ kind, status: 'open', evidence_aliases: aliases, description })

describe('public knowledge-state acceptance A1-A8', () => {
  it('A2 applies an active user supplement to the same task before the next model request', async () => {
    const { ctx, agent, message, decide } = await publicSetup()
    try {
      const before = ctx.retrievalAgent.current(agent)
      const reply = await message('只看上海的工单，重点核对解绑后的同步处理', 2)
      const after = ctx.retrievalAgent.current(agent)
      expect(after.retrievalId).toBe(before.retrievalId)
      expect(after.candidates.map(candidate => candidate.displayId)).toEqual(['TKT-2'])
      expect(after.userFeedback?.at(-1)?.text).toBe('只看上海的工单，重点核对解绑后的同步处理')
      expect(after.query.spec.filters).toContainEqual({ field: 'region', op: 'eq', value: '上海' })
      expect(JSON.stringify(reply)).toContain('重点核对解绑后的同步处理')
      expect(readRetrievalSessionEvents(agent.session)).toContainEqual(expect.objectContaining({ type: 'retrieval/user-feedback-received' }))
      const replayed = ctx.retrievalAgent.current(sessionAgent(agent.session))
      expect(replayed.userFeedback).toEqual(after.userFeedback)
      expect((await decide({ kind: 'search', mode: 'keyword', changes: [{ type: 'remove_filter', field: 'region' }] }, [], [gap('constraint', ['c2'], '尝试扩大地域')])).isError).toBe(true)
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '补充条件下上海案例匹配。' }, [accept('c2')])).isError).toBe(false)
      expect(createTicketResultCollection(ctx.retrievalAgent.current(agent)).tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
    } finally { await ctx.fiber.dispose() }
  })
  it('A7 restarts retrieval with the merged query and confirmed conditions when the snapshot expires mid-session', async () => {
    const { ctx, agent, message } = await publicSetup('帮我找副卡工单', ExpiringSnapshotProvider)
    try {
      await message('只看上海的工单，重点核对解绑后的同步处理', 2)
      const confirmed = ctx.retrievalAgent.current(agent)
      expect(confirmed.query.spec.filters).toContainEqual({ field: 'region', op: 'eq', value: '上海' })
      ;(ctx.ticketRetrievalProvider as unknown as ExpiringSnapshotProvider).expired = true

      const reply = await message('日期范围是 2026-07-01 到 2026-07-31，其他条件不变', 3)
      const restarted = ctx.retrievalAgent.current(agent)
      expect(restarted.retrievalId).not.toBe(confirmed.retrievalId)
      expect(restarted.termination).not.toBe('snapshot_invalid')
      expect(restarted.query.original).toContain('帮我找副卡工单')
      expect(restarted.query.original).toContain('日期范围是 2026-07-01 到 2026-07-31')
      expect(restarted.query.confirmedConstraints).toContainEqual({ field: 'region', op: 'eq', value: '上海' })
      const createdRange = restarted.query.confirmedConstraints.filter(filter => filter.field === 'createdAt')
      expect(createdRange.map(filter => filter.op).sort()).toEqual(['gte', 'lte'])
      expect(new Date(createdRange.find(filter => filter.op === 'gte')!.value).getTime())
        .toBeLessThan(Date.UTC(2026, 6, 15))
      expect(new Date(createdRange.find(filter => filter.op === 'lte')!.value).getTime())
        .toBeGreaterThan(Date.UTC(2026, 6, 15))
      expect(restarted.candidates.map(candidate => candidate.displayId)).toEqual(['TKT-2'])
      const replayed = ctx.retrievalAgent.current(sessionAgent(agent.session))
      expect(replayed.retrievalId).toBe(restarted.retrievalId)
      expect(replayed.query.confirmedConstraints).toContainEqual({ field: 'region', op: 'eq', value: '上海' })
      expect(JSON.stringify(reply)).toContain('<ticket_knowledge_context>')

      // 快照失效后明确的“新任务”不再被旧快照挡住，也不会并入原查询。
      await message('新任务：查找宽带故障工单', 4)
      const fresh = ctx.retrievalAgent.current(agent)
      expect(fresh.retrievalId).not.toBe(restarted.retrievalId)
      expect(fresh.termination).not.toBe('snapshot_invalid')
      expect(fresh.query.original).toContain('宽带故障')
      expect(fresh.query.original).not.toContain('帮我找副卡工单')
    } finally { await ctx.fiber.dispose() }
  })
  it('A7 restarts retrieval from user input when a restored session replays an expired snapshot', async () => {
    const { ctx, agent, message } = await publicSetup('帮我找副卡工单', ExpiringSnapshotProvider)
    try {
      await message('只看上海的工单，重点核对解绑后的同步处理', 2)
      const confirmed = ctx.retrievalAgent.current(agent)
      ;(ctx.ticketRetrievalProvider as unknown as ExpiringSnapshotProvider).expired = true

      const replayed = sessionAgent(agent.session)
      const direct = createUserMessage({ content: [{ type: 'text', text: '日期范围是 2026-07-01 到 2026-07-31，其他条件不变' }], source: { kind: 'user' } })
      const reply = await agentEvents(ctx, replayed).waterfall('agent/pre-step',
        { messages: [direct], turn: 3, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [direct] }))

      const restarted = ctx.retrievalAgent.current(replayed)
      expect(restarted.retrievalId).not.toBe(confirmed.retrievalId)
      expect(restarted.termination).not.toBe('snapshot_invalid')
      expect(restarted.query.original).toContain('帮我找副卡工单')
      expect(restarted.query.original).toContain('日期范围是 2026-07-01 到 2026-07-31')
      expect(restarted.query.confirmedConstraints).toContainEqual({ field: 'region', op: 'eq', value: '上海' })
      expect(restarted.candidates.map(candidate => candidate.displayId)).toEqual(['TKT-2'])
      expect(JSON.stringify(reply)).toContain('<ticket_knowledge_context>')
    } finally { await ctx.fiber.dispose() }
  })
  it('A5 recognizes cancellation and an explicit new task during active retrieval', async () => {
    const { ctx, agent, message } = await publicSetup()
    try {
      const firstId = ctx.retrievalAgent.current(agent).retrievalId
      await message('新任务：找上海副卡工单', 2)
      const next = ctx.retrievalAgent.current(agent)
      expect(next.retrievalId).not.toBe(firstId)
      expect(next.candidates.map(candidate => candidate.displayId)).toEqual(['TKT-2'])
      const cancelled = await message('取消', 3)
      expect(cancelled).toEqual({ kind: 'enter', messages: [] })
      expect(ctx.retrievalAgent.current(agent).termination).toBe('cancelled')
    } finally { await ctx.fiber.dispose() }
  })
  it('A5 applies a user quantity correction and rechecks earlier semantic judgments', async () => {
    const { ctx, agent, message, decide } = await publicSetup('帮我找2条副卡工单')
    try {
      await decide({ kind: 'clarify', question: '需要两个地区的案例，还是只选一个？', candidate_aliases: ['c1', 'c2'], evidence_aliases: ['c1', 'c2'] }, [accept('c1')], [gap('ambiguity', ['c1', 'c2'], '需明确结果数量和业务范围')])
      expect(ctx.retrievalAgent.current(agent).selectedCandidateRefs).toHaveLength(1)
      await message('只要1条，优先解绑后的共享问题', 2)
      const updated = ctx.retrievalAgent.current(agent)
      expect(updated.task).toMatchObject({ countPolicy: 'explicit', requestedCount: 1 })
      expect(updated.query.contract).toMatchObject({ resultPolicy: 'explicit_top_k', resultLimit: 1 })
      expect(updated.selectedCandidateRefs).toEqual([])
      expect(updated.judgments).toEqual([])
      expect(updated.candidates).toHaveLength(2)
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '按新数量和业务范围确认解绑案例。' }, [accept('c2')])).isError).toBe(false)
      expect(createTicketResultCollection(ctx.retrievalAgent.current(agent)).tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
    } finally { await ctx.fiber.dispose() }
  })
  it('A5 distinguishes an explicit withdrawal of exhaustive scope from an ordinary reply', async () => {
    const { ctx, agent, message, decide } = await publicSetup('帮我找全部副卡工单')
    try {
      expect(ctx.retrievalAgent.current(agent).task.countPolicy).toBe('exhaustive')
      await message('重点看解绑现象', 2)
      expect(ctx.retrievalAgent.current(agent).task.countPolicy).toBe('exhaustive')
      await message('不要全部，只需要有参考价值的案例', 3)
      expect(ctx.retrievalAgent.current(agent).task.countPolicy).toBe('adaptive')
      expect(ctx.retrievalAgent.current(agent).query.contract?.resultPolicy).toBe('adaptive_top_k')
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '此解绑案例有参考价值。' }, [accept('c2')])).isError).toBe(false)
      expect(createTicketResultCollection(ctx.retrievalAgent.current(agent))).not.toHaveProperty('undeterminedCandidates')
      expect(ctx.retrievalAgent.current(agent).candidates.map(ticket => ticket.displayId)).toContain('TKT-1')
    } finally { await ctx.fiber.dispose() }
  })
  it('A5 reopens a finished task for feedback without retaining its previous confirmation or replacing its identity', async () => {
    const { ctx, agent, message, decide } = await publicSetup()
    try {
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '原摘要符合要求。' }, [accept('c2')])).isError).toBe(false)
      const before = ctx.retrievalAgent.current(agent)
      const originalResult = createTicketResultCollection(before)
      await message('这条不相关，请重新核对解绑后的共享问题', 2)
      const reviewing = ctx.retrievalAgent.current(agent)
      expect(reviewing.retrievalId).toBe(before.retrievalId)
      expect(reviewing.phase).toBe('assessed')
      expect(reviewing.selectedCandidateRefs).toEqual([])
      expect(reviewing.excludedCandidateRefs).toEqual([])
      expect(reviewing.frozenEvidence).toBeUndefined()
      expect(reviewing.stopExplanation).toBeUndefined()
      expect(reviewing.userFeedback?.at(-1)?.text).toContain('这条不相关')
      expect(() => createTicketResultCollection(reviewing)).toThrow(/尚未结束/u)
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '结合摘要复核后保留原判断。' }, [accept('c2')])).isError).toBe(false)
      const after = ctx.retrievalAgent.current(agent)
      const revised = createTicketResultCollection(after)
      expect(revised.tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
      expect(revised.resultRevision).not.toBe(originalResult.resultRevision)
      expect(originalResult.tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
      expect(ctx.retrievalAgent.current(sessionAgent(agent.session))).toMatchObject({
        retrievalId: before.retrievalId, selectedCandidateRefs: after.selectedCandidateRefs,
        frozenEvidence: after.frozenEvidence,
      })
    } finally { await ctx.fiber.dispose() }
  })

  it('A2 filters out historical candidates from final collection after condition narrowing', async () => {
    const { ctx, agent, decide } = await publicSetup()
    try {
      const repaired = await decide({ kind: 'search', mode: 'keyword', changes: [{ type: 'add_filter', field: 'region', op: 'eq', value: '上海' }] }, [], [gap('constraint', ['c1', 'c2'], '当前只需要上海范围')])
      expect(repaired.isError).toBe(false)
      const narrowed = ctx.retrievalAgent.current(agent)
      expect(narrowed.candidateHistory).toHaveLength(2)
      expect(narrowed.candidates.map(candidate => candidate.displayId)).toEqual(['TKT-2'])
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '上海工单满足要求。' }, [accept('c2')])).isError).toBe(false)
      expect(createTicketResultCollection(ctx.retrievalAgent.current(agent)).tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
    } finally { await ctx.fiber.dispose() }
  })
  it('A1 applies explicit region in the first real Provider search from natural language', async () => {
    const { ctx, agent, decide } = await publicSetup('帮我找上海的副卡工单')
    try {
      const state = ctx.retrievalAgent.current(agent)
      expect(state.lastPage?.appliedFilters).toContainEqual({ field: 'region', op: 'eq', value: '上海' })
      expect(state.candidates.map(candidate => candidate.displayId)).toEqual(['TKT-2'])
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '首轮上海工单满足要求。' }, [accept('c1')])).isError).toBe(false)
      expect(createTicketResultCollection(ctx.retrievalAgent.current(agent)).tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
    } finally { await ctx.fiber.dispose() }
  })
  it('A5 persists a visible question and resumes the same retrieval through a direct user message', async () => {
    const { ctx, agent, message, decide } = await publicSetup()
    try {
      const asked = await decide({ kind: 'clarify', question: '北京和上海的案例都需要吗？', candidate_aliases: ['c1', 'c2'], evidence_aliases: ['c1', 'c2'] }, [], [gap('ambiguity', ['c1', 'c2'], '候选地域存在差异')])
      expect(asked.isError).toBe(false)
      const before = ctx.retrievalAgent.current(agent)
      expect(before.clarification?.question).toBe('北京和上海的案例都需要吗？')
      expect(before.termination).toBe('needs_clarification')
      expect(asked.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('北京和上海的案例都需要吗') })]))
      await message('只看上海的工单', 2)
      const after = ctx.retrievalAgent.current(agent)
      expect(after.retrievalId).toBe(before.retrievalId)
      expect(after.termination).not.toBe('needs_clarification')
      expect(after.clarification?.answer).toBe('只看上海的工单')
      expect(after.query.spec.filters).not.toContainEqual(expect.objectContaining({ value: '只看上海的工单' }))
      expect(after.query.spec.filters).toContainEqual({ field: 'region', op: 'eq', value: '上海' })
      expect(after.candidates.map(candidate => candidate.displayId)).toEqual(['TKT-2'])
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '按补充范围完成。' }, [accept('c2')])).isError).toBe(false)
      expect(createTicketResultCollection(ctx.retrievalAgent.current(agent)).tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
    } finally { await ctx.fiber.dispose() }
  })
  it('A3 accepts relevant evidence and excludes a business mismatch without automatic acceptance', async () => {
    const { ctx, agent, decide } = await publicSetup()
    try {
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '只有上海解绑案例匹配。' }, [accept('c2'), { candidate_alias: 'c1', verdict: 'exclude', evidence_aliases: ['c1'], reason: '北京共享场景没有解绑现象。' }])).isError).toBe(false)
      const collection = createTicketResultCollection(ctx.retrievalAgent.current(agent))
      expect(collection.tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
      expect(collection).not.toHaveProperty('undeterminedCandidates')
    } finally { await ctx.fiber.dispose() }
  })
  it('A4 updates controlled evidence, frozen references and replay in the same state', async () => {
    const { ctx, agent, decide } = await publicSetup()
    try {
      // A previous focused summary read must not hide another ticket's newly requested source.
      expect((await decide({ kind: 'inspect', candidate_aliases: ['c1'], fields: [], history: true })).isError).toBe(false)
      const read = await ctx.tools.execute({ signal: SIGNAL, callId: CallId('focused-source-read'), name: 'ticket_read', agent,
        arguments: { state_id: ctx.retrievalAgent.current(agent).stateId, candidate_aliases: ['c2'], fields: ['resolution'], reason: '核对处理结果' } })
      expect(read.isError).toBe(false)
      const state = ctx.retrievalAgent.current(agent)
      expect(state.gaps.filter(g => g.evaluator === 'model')).toEqual([])
      expect(state.promotedEvidence).toHaveLength(1)
      expect(state.promotedEvidence[0]).toMatchObject({ field: 'resolution', readers: ['provider', 'model'], evidenceLevel: 'L2' })
      expect(read.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('重新同步') })]))
      expect((await decide({ kind: 'finish', reason: 'satisfied', explanation: '处理过程已核对。' }, [{ ...accept('c2'), evidence_aliases: ['e1'] }])).isError).toBe(false)
      const finished = ctx.retrievalAgent.current(agent)
      expect(finished.frozenEvidence?.candidates[0]?.evidenceIds).toEqual([state.promotedEvidence[0]!.evidenceId])
      const replayedAgent = sessionAgent(agent.session)
      const replayed = ctx.retrievalAgent.current(replayedAgent)
      expect(createTicketResultCollection(replayed).evidence.map(evidence => evidence.evidenceId)).toEqual([state.promotedEvidence[0]!.evidenceId])
    } finally { await ctx.fiber.dispose() }
  })
  it('A7 retains valid unjudged candidates when the model cannot finish, and explains the stop', async () => {
    const { ctx, agent } = await publicSetup()
    try {
      for (let i = 0; i < 3; i++) await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
      const collection = createTicketResultCollection(ctx.retrievalAgent.current(agent))
      expect(collection.tickets).toEqual([])
      expect(collection).not.toHaveProperty('undeterminedCandidates')
      expect(ctx.retrievalAgent.current(agent).candidates.map(ticket => ticket.displayId)).toEqual(['TKT-1', 'TKT-2'])
      expect(collection.explanation).toContain('未提交')
    } finally { await ctx.fiber.dispose() }
  })
  it('A7 reauthorizes a waiting task and prevents revoked historical content from resuming', async () => {
    const { ctx, agent, message, decide } = await publicSetup()
    try {
      await decide({ kind: 'clarify', question: '需要哪一个地区？', candidate_aliases: ['c1', 'c2'], evidence_aliases: ['c1', 'c2'] }, [], [gap('ambiguity', ['c1', 'c2'], '地域不明')])
      ;(ctx.ticketRetrievalProvider as unknown as PublicEvidenceProvider).revoked = true
      await message('上海', 2)
      const state = ctx.retrievalAgent.current(agent)
      expect(state.termination).toBe('permission_blocked')
      expect(createTicketResultCollection(state).tickets).toEqual([])
      expect(createTicketResultCollection(state)).not.toHaveProperty('undeterminedCandidates')
    } finally { await ctx.fiber.dispose() }
  })
  it('A7 keeps a ranking deadline distinguishable instead of masking it as a generic source failure', async () => {
    const { ctx, agent } = await publicSetup('帮我找副卡工单', TimingOutTicketProvider)
    try {
      const state = ctx.retrievalAgent.current(agent)
      expect(state).toMatchObject({ phase: 'stopped', termination: 'backend_error',
        stopErrorCode: 'TIMEOUT', stopExplanation: 'RAG 排名请求超时。' })
      expect(createTicketResultCollection(state).explanation).toBe('RAG 排名请求超时。')
      expect(readRetrievalSessionEvents(agent.session))
        .toContainEqual(expect.objectContaining({ type: 'retrieval/stopped',
          data: expect.objectContaining({ reason: 'backend_error', errorCode: 'TIMEOUT' }) }))
      const replayed = ctx.retrievalAgent.current(sessionAgent(agent.session))
      expect(replayed).toMatchObject({ stopErrorCode: 'TIMEOUT', stopExplanation: 'RAG 排名请求超时。' })
    } finally { await ctx.fiber.dispose() }
  })
})

class KnowledgeLoopAdapter extends LlmAdapter {
  readonly submitted: string[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value)
      ? value.flatMap(strings) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
    const text = [...strings(options.messages), options.system ?? ''].join('\n')
    const headers = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)].map(match => JSON.parse(match[1]!))
    const header = headers.findLast(value => value.knowledgeState?.stateId !== undefined)
    if (header === undefined) throw new Error('Model request omitted current state identity')
    const state_id = header.knowledgeState.stateId as string
    this.submitted.push(state_id)
    if (!options.tools?.some(tool => tool.name === 'ticket_decide')) throw new Error('Public model request lost ticket_decide')
    const turn = this.submitted.length
    const action = turn === 1 ? { kind: 'clarify', question: '只看上海还是也包含北京？', candidate_aliases: ['c1', 'c2'], evidence_aliases: ['c1', 'c2'] }
      : turn === 2 ? { kind: 'inspect', candidate_aliases: ['c2'], fields: ['resolution'] }
      : { kind: 'finish', reason: 'satisfied', explanation: '当前上海案例处理过程已核对。' }
    const args = { state_id, action,
      judgments: turn === 3 ? [{ ...accept('c2'), evidence_aliases: ['e1'] }] : [],
      semantic_gaps: turn === 1 ? [gap('ambiguity', ['c1', 'c2'], '需要用户确认地域')]
        : turn === 2 ? [gap('depth', ['c2'], '摘要缺少实际处理过程')] : [],
    }
    const block = { type: 'tool-call' as const, id: CallId(`loop-${turn}`), name: 'ticket_decide', arguments: JSON.stringify(args) }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 60 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class PersistentRepairAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly repairTurns: number, private readonly jumpMsPerTurn = 0) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value)
      ? value.flatMap(strings) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
    const text = [...strings(options.messages), options.system ?? ''].join('\n')
    const headers = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)].map(match => JSON.parse(match[1]!))
    const state_id = headers.findLast(header => header.knowledgeState?.stateId !== undefined)?.knowledgeState.stateId
    if (typeof state_id !== 'string') throw new Error('Model did not receive a current knowledge-state token')
    const turn = this.requests.length
    if (this.jumpMsPerTurn > 0) vi.setSystemTime(Date.now() + this.jumpMsPerTurn)
    const args = turn > this.repairTurns
      ? { state_id, judgments: [accept('c2')], semantic_gaps: [],
        action: { kind: 'finish', reason: 'satisfied', explanation: '可见候选摘要已满足任务。' } }
      : { state_id, judgments: [], semantic_gaps: [],
        action: { kind: 'search', mode: 'keyword', changes: [{ type: 'add_terms', terms: [`缓存${turn}`] }] } }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`persist-${turn}`), name: 'ticket_decide', arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 60 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

describe('actual DSH message and ToolRuntime loop with a deterministic model adapter', () => {
  it('uses only the model-delivered state token through clarification reply, search, inspect and finish', async () => {
    const ctx = new Context()
    const toolErrors: unknown[] = []
    let dispose: (() => Promise<void>) | undefined
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime)
      ctx.on('tools/result', (_exec, result) => { if (result.isError) toolErrors.push(result.content) })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(TokenMeter)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(PublicEvidenceProvider)
      await ctx.plugin(RetrievalAgentService)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
      installRetrievalTools(ctx, ctx.retrievalAgent)
      installRetrievalRuntimeBudget(ctx, ctx.retrievalAgent)
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      class RecoverableAnswerAdapter extends KnowledgeLoopAdapter {
        proseSent = false
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          if (!this.proseSent) {
            this.proseSent = true
            yield { type: 'block-end', index: 0, block: { type: 'text', text: '已分析，还未提交结构化结果。' } }
            yield { type: 'finish', reason: { kind: 'stop' } }; return
          }
          yield* super.stream(options)
        }
      }
      const adapter = new RecoverableAnswerAdapter()
      ctx.llm.registerAdapter(['knowledge-loop'], adapter)
      const handle = await ctx.agents.create({ sessionId: SessionId('knowledge-actual-loop'), agentOptions: { provider: 'knowledge-loop', model: 'deterministic-fixture' } })
      dispose = handle.dispose
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我找副卡解绑的工单' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const waiting = ctx.retrievalAgent.current(handle.agent)
      expect(waiting.termination).toBe('needs_clarification')
      // Only the clock advances: the trusted fixture Provider keeps this snapshot valid.
      // A long human wait must not consume the 120-second online execution allowance.
      const resumedAt = Date.now() + 365 * 24 * 60 * 60 * 1000
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(resumedAt)
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '只看上海的工单' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const final = ctx.retrievalAgent.current(handle.agent)
      expect(final.retrievalId).toBe(waiting.retrievalId)
      expect(final.termination, JSON.stringify(toolErrors)).toBe('top_k_accepted')
      expect(adapter.submitted).toHaveLength(3)
      expect(createTicketResultCollection(final).tickets.map(ticket => ticket.displayId)).toEqual(['TKT-2'])
      expect(final.promotedEvidence[0]?.readers).toContain('model')
      expect(final.budget.failedToolCalls).toBe(0)
      expect(final.budget.wallClockElapsedMs).toBeLessThan(10_000)
    } finally { vi.useRealTimers(); if (dispose !== undefined) await dispose(); await ctx.fiber.dispose() }
  })

  it('keeps admitting model steps beyond the legacy round cap until the task is semantically finished', async () => {
    const ctx = new Context()
    const toolErrors: unknown[] = []
    let dispose: (() => Promise<void>) | undefined
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime)
      ctx.on('tools/result', (_exec, result) => { if (result.isError) toolErrors.push(result.content) })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(TokenMeter)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
      installRetrievalTools(ctx, ctx.retrievalAgent)
      installRetrievalRuntimeBudget(ctx, ctx.retrievalAgent)
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      const adapter = new PersistentRepairAdapter(10)
      ctx.llm.registerAdapter(['persistent-repair'], adapter)
      const handle = await ctx.agents.create({ sessionId: SessionId('persistent-repair-loop'), agentOptions: { provider: 'persistent-repair', model: 'deterministic-fixture' } })
      dispose = handle.dispose
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我找副卡解绑的工单' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()

      const final = ctx.retrievalAgent.current(handle.agent)
      expect(adapter.requests, JSON.stringify(toolErrors)).toHaveLength(11)
      expect(final.termination).toBe('top_k_accepted')
      expect(final.budget).toMatchObject({ modelStepsUsed: 11, searchesUsed: 11 })
    } finally { if (dispose !== undefined) await dispose(); await ctx.fiber.dispose() }
  })

  it('keeps admitting model requests beyond the legacy wall-clock cap while still measuring elapsed time', async () => {
    const ctx = new Context()
    let dispose: (() => Promise<void>) | undefined
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(TokenMeter)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(UnionTicketProvider)
      await ctx.plugin(RetrievalAgentService)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
      installRetrievalTools(ctx, ctx.retrievalAgent)
      installRetrievalRuntimeBudget(ctx, ctx.retrievalAgent)
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      const adapter = new PersistentRepairAdapter(2, 61_000)
      ctx.llm.registerAdapter(['slow-repair'], adapter)
      const handle = await ctx.agents.create({ sessionId: SessionId('wall-clock-observational-loop'), agentOptions: { provider: 'slow-repair', model: 'deterministic-fixture' } })
      dispose = handle.dispose
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我找副卡解绑的工单' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()

      const final = ctx.retrievalAgent.current(handle.agent)
      expect(adapter.requests).toHaveLength(3)
      expect(final.termination).toBe('top_k_accepted')
      expect(final.budget.wallClockElapsedMs).toBeGreaterThanOrEqual(122_000)
    } finally { vi.useRealTimers(); if (dispose !== undefined) await dispose(); await ctx.fiber.dispose() }
  })
})


describe('public DSH restoration authorization boundary', () => {
  it('reauthorizes restored evidence before any new model request after permission revocation', async () => {
    class ReadThenWaitAdapter extends LlmAdapter {
      readonly requests: GenerateOptions[] = []
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(options)
        const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value)
          ? value.flatMap(strings) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
        const text = [...strings(options.messages), options.system ?? ''].join('\n')
        const headers = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)]
          .map(match => JSON.parse(match[1]!))
        const state_id = headers.findLast(header => header.knowledgeState?.stateId !== undefined)?.knowledgeState.stateId
        if (typeof state_id !== 'string') throw new Error('Model did not receive a current knowledge-state token')
        const inspect = this.requests.length === 1
        const args = {
          state_id, judgments: [],
          semantic_gaps: inspect ? [gap('depth', ['c2'], '需要处理过程核实原因')]
            : [gap('ambiguity', ['c1', 'c2'], '需要用户确认地区范围')],
          action: inspect ? { kind: 'inspect', candidate_aliases: ['c2'], fields: ['resolution'] }
            : { kind: 'clarify', question: '只看上海的案例吗？', candidate_aliases: ['c1', 'c2'], evidence_aliases: ['c1', 'c2'] },
        }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`restore-seed-${this.requests.length}`), name: 'ticket_decide', arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    const ctx = new Context()
    const disposers: (() => Promise<void>)[] = []
    const restorationToolErrors: unknown[] = []
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime)
      ctx.on('tools/result', (_exec, result) => { if (result.isError) restorationToolErrors.push(result.content) })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(TokenMeter)
      await ctx.plugin(StubPrincipalProvider)
      await ctx.plugin(PublicEvidenceProvider)
      await ctx.plugin(RetrievalAgentService)
      installAutomaticRetrievalStart(ctx, ctx.retrievalAgent, { analyzer: QUERY_ANALYZER })
      installRetrievalTools(ctx, ctx.retrievalAgent)
      installRetrievalRuntimeBudget(ctx, ctx.retrievalAgent)
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      const adapter = new ReadThenWaitAdapter()
      ctx.llm.registerAdapter(['restored-access'], adapter)
      const source = await ctx.agents.create({ sessionId: SessionId('restoration-access-source'), agentOptions: { provider: 'restored-access', model: 'fixture' } })
      disposers.push(source.dispose)
      source.agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我找副卡工单' }], source: { kind: 'user' } }))
      await source.agent.whenIdle()
      const before = ctx.retrievalAgent.current(source.agent)
      expect(before.termination, JSON.stringify(restorationToolErrors)).toBe('needs_clarification')
      expect(before.promotedEvidence[0]?.text).toContain('重新同步后共享关系解除')
      const seed = source.agent.session.events
      const priorRequests = adapter.requests.length
      expect(priorRequests).toBe(2)
      await source.dispose()
      ;(ctx.ticketRetrievalProvider as unknown as PublicEvidenceProvider).revoked = true
      const restored = await ctx.agents.create({ sessionId: SessionId('restoration-access-restored'), seed, agentOptions: { provider: 'restored-access', model: 'fixture' } })
      disposers.push(restored.dispose)
      restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: '只看上海的工单' }], source: { kind: 'user' } }))
      await restored.agent.whenIdle()
      const final = ctx.retrievalAgent.current(restored.agent)
      expect(final.retrievalId).toBe(before.retrievalId)
      expect(final.termination).toBe('permission_blocked')
      expect(final.candidates).toEqual([])
      expect(final.promotedEvidence).toEqual([])
      const resumedRequests = adapter.requests.slice(priorRequests)
      expect(JSON.stringify(resumedRequests)).not.toContain('上海副卡解绑后流量共享')
      expect(JSON.stringify(resumedRequests)).not.toContain('重新同步后共享关系解除')
      expect(resumedRequests).toEqual([])
    } finally {
      for (const dispose of disposers.reverse()) await dispose()
      await ctx.fiber.dispose()
    }
  })
})
