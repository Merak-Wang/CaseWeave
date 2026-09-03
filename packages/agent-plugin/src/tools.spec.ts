import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { agentEvents, assembleContextFor, Inbox } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  TicketSnapshotId,
  type RetrievalActionKind,
  type RetrievalKnowledgeAssessment,
  type RetrievalState,
  TicketCandidateRef,
  type TicketQueryDelta,
} from '@retrieval-agent/contracts'
import type { RetrievalToolApplication } from './tools.js'
import { installRetrievalTools, visibleRetrievalTools } from './tools.js'

const SIGNAL = new AbortController().signal

function fakeAgent(id = 'tool-agent', onSteer: () => void = () => {}): Agent {
  const session = Session.create(SessionId(id))
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send() {}, followup() {}, steer() { onSteer() }, inject() {}, cancel() {},
    runMaintenance: task => task(SIGNAL),
    whenIdle: () => Promise.resolve(),
  }
}

function stateWithActions(kinds: readonly RetrievalActionKind[]): RetrievalState {
  return {
    retrievalId: 'retrieval-tools',
    stateId: 'state-retrieval-tools-1',
    revision: 1,
    phase: 'assessed',
    termination: 'active',
    task: {
      target: 'ranked_cases', requestedCount: 5, countPolicy: 'explicit',
      answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'top_k',
    },
    query: { original: '副卡', spec: { mode: 'hybrid', normalizedQuery: '副卡' } },
    candidates: [],
    candidateHistory: [],
    rankingHistory: [],
    excludedCandidateRefs: [],
    selectedCandidateRefs: [],
    promotedEvidence: [],
    gaps: [],
    allowedActions: kinds.map(kind => ({ kind, candidateAllowlist: [], fieldAllowlist: [], maxTokens: 0 })),
    budget: {
      maxRounds: 8, maxSearches: 4, maxPromotions: 3, maxEvidenceTokens: 1_500, maxLatencyMs: 120_000,
      roundsUsed: 0, searchesUsed: 1, promotionsUsed: 0, evidenceTokensUsed: 0, latencyMs: 0,
    },
    progress: {
      newCandidateRefs: [], newEvidenceIds: [], rankOverlap: 1,
      newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0,
    },
  } as unknown as RetrievalState
}

function stateWithDetail(): RetrievalState {
  const refs = ['candidate-1', 'candidate-2'] as TicketCandidateRef[]
  const allowedActions = stateWithActions(['repair_search', 'read_l3_details']).allowedActions.map(action =>
    action.kind === 'read_l3_details'
      ? { ...action, candidateAllowlist: refs, fieldAllowlist: ['source.raw'] }
      : action)
  return {
    ...stateWithActions(['repair_search', 'read_l3_details']),
    allowedActions,
    candidates: refs.map((ref, index) => ({
      ref, displayId: `TKT-${index + 1}`, title: `标题 ${index + 1}`, summary: `摘要 ${index + 1}`,
    })),
    candidateHistory: refs.map((ref, index) => ({
      ref, displayId: `TKT-${index + 1}`, title: `标题 ${index + 1}`, summary: `摘要 ${index + 1}`,
    })),
    snapshot: {
      capabilities: { detailRead: true, l3DetailsRead: true },
      fieldCatalog: [{ key: 'source.raw', accessLevel: 'L3', valueKind: 'raw_json' }],
    },
  } as unknown as RetrievalState
}

function continuingState(): RetrievalState {
  return {
    ...stateWithActions(['search_next']),
    lastPage: { nextCursor: 'provider-owned' },
  } as unknown as RetrievalState
}

function stoppedState(): RetrievalState {
  return {
    retrievalId: 'retrieval-tools',
    phase: 'stopped',
    termination: 'no_result',
    task: { target: 'ranked_cases' },
    query: { original: '副卡' },
    candidates: [],
    candidateHistory: [],
    excludedCandidateRefs: [],
    selectedCandidateRefs: [],
    promotedEvidence: [],
    gaps: [],
    allowedActions: [],
    budget: {
      maxRounds: 8, maxSearches: 4, maxPromotions: 3, maxEvidenceTokens: 1_500, maxLatencyMs: 120_000,
      roundsUsed: 0, searchesUsed: 1, promotionsUsed: 0, evidenceTokensUsed: 0, latencyMs: 0,
    },
  } as unknown as RetrievalState
}

interface SearchCall {
  readonly mode: 'keyword' | 'dense'
  readonly delta: TicketQueryDelta
}

function stubApplication(searchCalls: SearchCall[], continuationCalls: string[] = []): RetrievalToolApplication {
  const stopped = stoppedState()
  return {
    contextTokenBudget: 1_500,
    modelContextTokenLimit: () => undefined,
    currentOrUndefined: () => undefined,
    current: () => stateWithDetail(),
    projectContext: () => ({ rendered: '<ticket_knowledge_context>{}</ticket_knowledge_context>' }),
    search: (_agent, input) => {
      searchCalls.push(input)
      return Promise.resolve(input.mode === 'dense' ? continuingState() : stopped)
    },
    continueRanking: () => {
      continuationCalls.push('continued')
      return Promise.resolve(stopped)
    },
    assess: () => Promise.resolve(continuingState()),
    readL3Details: (_agent, refs) => Promise.resolve({
      snapshotId: TicketSnapshotId('snapshot-1'),
      requestedCandidateRefs: refs,
      details: refs.map((ref, index) => ({
        candidateRef: ref,
        displayId: `TKT-${index + 1}`,
        sourceVersion: 'source-v1',
        contentHash: `hash-${index + 1}`,
        source: { datasetId: 'tickets', datasetVersion: 'v1', schemaVersion: 'raw-v1', recordId: `TKT-${index + 1}` },
        rawPayload: { conversation: [`用户：故障${index + 1}`, `客服：已处理${index + 1}`] },
        trust: 'untrusted_ticket_evidence' as const,
      })),
      warnings: [],
    }),
    recordToolCall: () => Promise.resolve(stopped),
  }
}

async function mountedTools(searchCalls: SearchCall[] = [], continuationCalls: string[] = []) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  installRetrievalTools(ctx, stubApplication(searchCalls, continuationCalls))
  return ctx
}

describe('retrieval tool surface', () => {
  it('registers one batch detail tool, search, and structured retrieval completion', async () => {
    const ctx = await mountedTools()
    try {
      const registered = ctx.tools.schemas().map(tool => tool.name)
      expect(registered).toEqual([
        'ticket_assess_state', 'ticket_bm25_search', 'ticket_rag_search', 'ticket_read_details',
      ])
      expect(registered).not.toEqual(expect.arrayContaining([
        'ticket_continue_ranking', 'ticket_expand_detail',
        'ticket_request_clarification', 'ticket_answer_clarification', 'ticket_state',
      ]))
      expect(ctx.tools.schemas().every(tool => !JSON.stringify(tool.parameters).includes('cursor'))).toBe(true)
      const assessment = ctx.tools.schemas().find(tool => tool.name === 'ticket_assess_state')
      const keywordSearch = ctx.tools.schemas().find(tool => tool.name === 'ticket_bm25_search')
      expect(JSON.stringify(assessment?.parameters)).not.toContain('keep_aliases')
      expect(JSON.stringify(assessment?.parameters)).not.toContain('exclude_new_aliases')
      expect(JSON.stringify(assessment?.parameters)).toContain('coverage')
      expect(keywordSearch?.description).toContain('Provider-side hard conditions')
      expect(JSON.stringify(keywordSearch?.parameters)).toContain('changes')
      expect(JSON.stringify(keywordSearch?.parameters)).toContain('add_filter')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps assessment in per-round context and keeps Provider continuation model-hidden', async () => {
    expect([...visibleRetrievalTools(undefined)]).toEqual([
      'ticket_bm25_search', 'ticket_rag_search', 'ticket_assess_state',
    ])
    expect([...visibleRetrievalTools(stoppedState())]).toEqual([])
    expect(visibleRetrievalTools(stateWithActions(['assess', 'read_state']))).toEqual(new Set([
      'ticket_assess_state',
    ]))
    expect(visibleRetrievalTools(stateWithActions(['repair_search', 'search_next']))).toEqual(new Set([
      'ticket_bm25_search', 'ticket_rag_search',
    ]))
    expect(visibleRetrievalTools(stateWithDetail())).toEqual(new Set([
      'ticket_bm25_search', 'ticket_rag_search', 'ticket_read_details',
    ]))

    const application = stubApplication([])
    application.currentOrUndefined = () => stateWithDetail()
    let projections = 0
    application.projectContext = () => ({
      rendered: `<ticket_knowledge_context>{"round":${++projections}}</ticket_knowledge_context>`,
    })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    installRetrievalTools(ctx, application)
    try {
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(fakeAgent('knowledge-context')))
      expect(assembly.contexts.map(context => context.text).join('\n')).toContain('<ticket_knowledge_context>')
      const policy = assembly.sections.map(section => section.text).join('\n')
      expect(policy).toContain('semantic reviewer')
      expect(policy).toContain('Harness owns authorization')
      expect(policy).not.toContain('Top 15')
      expect(policy).not.toContain('requested count')
      const nextAssembly = await ctx.systemPrompt.assemble(assembleContextFor(fakeAgent('next-knowledge-context')))
      expect(nextAssembly.contexts.map(context => context.text).join('\n')).toContain('"round":2')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns a machine-readable recovery payload under the renamed BM25 tool', async () => {
    const ctx = await mountedTools()
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('bm25-invalid'),
        name: 'ticket_bm25_search',
        arguments: { delta_kind: 'add_terms', terms: ['副卡'] },
        agent: fakeAgent('invalid-tool-call'),
      })
      expect(result.isError).toBe(true)
      const text = result.content.find(block => block.type === 'text')?.text ?? ''
      expect(JSON.parse(text)).toMatchObject({
        type: 'retrieval_tool_error',
        tool: 'ticket_bm25_search',
        code: expect.any(String),
        repairExample: { changes: [{ type: 'replace_terms', terms: ['副卡', '跨域'] }] },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('batches BM25 terms and structured conditions into one Provider search', async () => {
    const calls: SearchCall[] = []
    const continuations: string[] = []
    const ctx = await mountedTools(calls, continuations)
    const agent = fakeAgent('tool-execution')
    try {
      await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('bm25-1'),
        name: 'ticket_bm25_search',
        arguments: { changes: [
          { type: 'add_terms', terms: ['副卡'] },
          { type: 'add_filter', field: 'createdAt', op: 'gte', value: '2026-07-01T00:00:00.000Z' },
          { type: 'add_filter', field: 'createdAt', op: 'lte', value: '2026-09-01T00:00:00.000Z' },
          { type: 'add_filter', field: 'status', op: 'eq', value: 'resolved' },
          { type: 'add_filter', field: 'region', op: 'eq', value: '华东' },
        ] },
        agent,
      })
      await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('rag-1'),
        name: 'ticket_rag_search',
        arguments: { query: '解绑后流量仍共享' },
        agent,
      })

      expect(calls).toEqual([
        { mode: 'keyword', delta: { kind: 'batch', changes: [
          { kind: 'add_terms', terms: ['副卡'] },
          { kind: 'add_filter', filter: { field: 'createdAt', op: 'gte', value: '2026-07-01T00:00:00.000Z' } },
          { kind: 'add_filter', filter: { field: 'createdAt', op: 'lte', value: '2026-09-01T00:00:00.000Z' } },
          { kind: 'add_filter', filter: { field: 'status', op: 'eq', value: 'resolved' } },
          { kind: 'add_filter', filter: { field: 'region', op: 'eq', value: '华东' } },
        ] } },
        { mode: 'dense', delta: { kind: 'rewrite_semantic_query', text: '解绑后流量仍共享' } },
      ])
      expect(continuations).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('advances exactly one Provider page when 102 remain before rebuilding knowledge state', async () => {
    const pending = {
      ...stateWithDetail(),
      task: {
        target: 'cohort_collection', countPolicy: 'exhaustive',
        answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'exhaustive',
      },
      allowedActions: stateWithActions(['assess', 'search_next']).allowedActions,
      lastPage: {
        nextCursor: 'provider-owned', completeness: 'bounded', boundary: { resultPagesExhausted: false },
        trace: { channels: [] },
      },
    } as unknown as RetrievalState
    const nextPage = {
      ...pending,
      lastPage: {
        nextCursor: 'provider-owned-2', completeness: 'bounded', boundary: { resultPagesExhausted: false },
        trace: { channels: [] },
      },
    } as unknown as RetrievalState
    const exhausted = {
      ...nextPage,
      allowedActions: stateWithActions(['assess']).allowedActions,
      lastPage: {
        completeness: 'exhaustive', boundary: { resultPagesExhausted: true }, trace: { channels: [] },
      },
    } as unknown as RetrievalState
    const continuations: string[] = []
    const assessments: RetrievalKnowledgeAssessment[] = []
    let current = pending
    const application = stubApplication([], continuations)
    application.current = () => current
    application.currentOrUndefined = () => current
    application.assess = (_agent, assessment) => {
      assessments.push(assessment)
      current = pending
      return Promise.resolve(current)
    }
    application.continueRanking = () => {
      continuations.push('continued')
      current = continuations.length >= 102 ? exhausted : {
        ...nextPage,
        lastPage: { ...nextPage.lastPage, nextCursor: `provider-owned-${continuations.length + 1}` },
      } as RetrievalState
      return Promise.resolve(current)
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    installRetrievalTools(ctx, application)
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('assess-continue-ranking'),
        name: 'ticket_assess_state',
        arguments: { outcome: { verdict: 'continue', next: { type: 'continue_ranking' } } },
        agent: fakeAgent('assessment-tool-call'),
      })

      expect(result).toMatchObject({ isError: false })
      expect(continuations).toEqual(['continued'])
      expect(assessments).toEqual([
        expect.objectContaining({ decision: 'continue', evaluator: 'model', nextAction: 'continue_ranking' }),
      ])
      expect(current.lastPage?.nextCursor).toBe('provider-owned-2')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns an exhausted final page for a fresh assessment instead of freezing in the same action', async () => {
    const pending = {
      ...stateWithDetail(),
      task: {
        target: 'cohort_collection', countPolicy: 'exhaustive',
        answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'exhaustive',
      },
      allowedActions: stateWithActions(['assess', 'search_next']).allowedActions,
      lastPage: {
        nextCursor: 'provider-owned', completeness: 'bounded', boundary: { resultPagesExhausted: false },
        trace: { channels: [] },
      },
    } as unknown as RetrievalState
    const exhausted = {
      ...pending,
      allowedActions: stateWithActions(['assess']).allowedActions,
      lastPage: {
        completeness: 'exhaustive', boundary: { resultPagesExhausted: true }, trace: { channels: [] },
      },
    } as unknown as RetrievalState
    const assessments: RetrievalKnowledgeAssessment[] = []
    let current = pending
    const application = stubApplication([])
    application.current = () => current
    application.currentOrUndefined = () => current
    application.assess = (_agent, assessment) => {
      assessments.push(assessment)
      return Promise.resolve(current)
    }
    application.continueRanking = () => {
      current = exhausted
      return Promise.resolve(current)
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    installRetrievalTools(ctx, application)
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('assess-final-page'),
        name: 'ticket_assess_state',
        arguments: { outcome: { verdict: 'continue', next: { type: 'continue_ranking' } } },
        agent: fakeAgent('assessment-final-page'),
      })

      expect(result).toMatchObject({ isError: false })
      expect(assessments).toEqual([
        expect.objectContaining({ decision: 'continue', evaluator: 'model', nextAction: 'continue_ranking' }),
      ])
      expect(current).toMatchObject({
        phase: 'assessed', lastPage: { boundary: { resultPagesExhausted: true } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects finish_current_results while an uncounted exhaustive query still has a page', async () => {
    const exhaustive = {
      ...stateWithDetail(),
      task: {
        target: 'cohort_collection', countPolicy: 'exhaustive',
        answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'exhaustive',
      },
      allowedActions: stateWithActions(['assess', 'search_next']).allowedActions,
      lastPage: {
        nextCursor: 'provider-owned', completeness: 'bounded',
        boundary: { resultPagesExhausted: false },
      },
    } as unknown as RetrievalState
    const application = stubApplication([])
    application.current = () => exhaustive
    application.currentOrUndefined = () => exhaustive
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    installRetrievalTools(ctx, application)
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('assess-premature-finish'),
        name: 'ticket_assess_state',
        arguments: { outcome: { verdict: 'finish_current_results' } },
        agent: fakeAgent('assessment-premature-finish'),
      })

      expect(result.isError).toBe(true)
      const content = result.content.find(block => block.type === 'text')?.text ?? ''
      expect(JSON.parse(content)).toMatchObject({
        message: expect.stringContaining('不能提前结束'),
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('advances at most one of 102 hidden pages in the natural-language fallback before another assessment', async () => {
    const pending = {
      ...stateWithDetail(),
      task: {
        target: 'cohort_collection', countPolicy: 'exhaustive',
        answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'exhaustive',
      },
      allowedActions: stateWithActions(['assess', 'search_next']).allowedActions,
      lastPage: {
        nextCursor: 'provider-owned', completeness: 'bounded',
        boundary: { resultPagesExhausted: false },
      },
    } as unknown as RetrievalState
    const nextPage = {
      ...pending,
      lastPage: {
        nextCursor: 'provider-owned-2', completeness: 'bounded',
        boundary: { resultPagesExhausted: false },
      },
    } as unknown as RetrievalState
    const exhausted = {
      ...nextPage,
      allowedActions: stateWithActions(['assess']).allowedActions,
      lastPage: { completeness: 'exhaustive', boundary: { resultPagesExhausted: true } },
    } as unknown as RetrievalState
    const continuations: string[] = []
    const assessments: RetrievalKnowledgeAssessment[] = []
    let current = pending
    const application = stubApplication([])
    application.current = () => current
    application.currentOrUndefined = () => current
    application.continueRanking = () => {
      continuations.push('continued')
      current = continuations.length >= 102 ? exhausted : {
        ...nextPage,
        lastPage: { ...nextPage.lastPage, nextCursor: `provider-owned-${continuations.length + 1}` },
      } as RetrievalState
      return Promise.resolve(current)
    }
    application.assess = (_agent, assessment) => {
      assessments.push(assessment)
      current = stoppedState()
      return Promise.resolve(current)
    }
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    installRetrievalTools(ctx, application, { maxFinishReminders: 0 })
    let reassessmentRequests = 0
    const agent = fakeAgent('assessment-fallback-page', () => { reassessmentRequests += 1 })
    try {
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })

      expect(continuations).toEqual(['continued'])
      expect(assessments).toEqual([])
      expect(current.lastPage?.nextCursor).toBe('provider-owned-2')
      expect(reassessmentRequests).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps an exhausted empty uncounted query to the system no-result terminal path', async () => {
    const empty = {
      ...stateWithActions(['assess']),
      task: {
        target: 'cohort_collection', countPolicy: 'exhaustive',
        answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'exhaustive',
      },
      lastPage: {
        completeness: 'exhaustive',
        boundary: { resultPagesExhausted: true },
      },
    } as unknown as RetrievalState
    const assessments: RetrievalKnowledgeAssessment[] = []
    const application = stubApplication([])
    application.current = () => empty
    application.currentOrUndefined = () => empty
    application.assess = (_agent, assessment) => {
      assessments.push(assessment)
      return Promise.resolve(stoppedState())
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    installRetrievalTools(ctx, application)
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('assess-exhausted-empty'),
        name: 'ticket_assess_state',
        arguments: { outcome: { verdict: 'finish_current_results' } },
        agent: fakeAgent('assessment-exhausted-empty'),
      })

      expect(result.isError).toBe(false)
      expect(assessments).toEqual([expect.objectContaining({
        decision: 'no_result', evaluator: 'system', nextAction: 'finish_no_result',
      })])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads multiple authorized L3 payloads in one combined tool result', async () => {
    const ctx = await mountedTools()
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('detail-1'),
        name: 'ticket_read_details',
        arguments: { candidate_aliases: ['c1', 'c2'] },
        agent: fakeAgent('detail-tool-call'),
      })
      expect(result).toMatchObject({
        isError: false,
        value: {
          details: [
            {
              candidate_alias: 'c1', display_id: 'TKT-1',
              source: { dataset_id: 'tickets', dataset_version: 'v1', schema_version: 'raw-v1', record_id: 'TKT-1' },
              raw_payload: '{"conversation":["用户：故障1","客服：已处理1"]}',
              trust: 'untrusted_ticket_evidence',
            },
            {
              candidate_alias: 'c2', display_id: 'TKT-2',
              source: { dataset_id: 'tickets', dataset_version: 'v1', schema_version: 'raw-v1', record_id: 'TKT-2' },
              raw_payload: '{"conversation":["用户：故障2","客服：已处理2"]}',
              trust: 'untrusted_ticket_evidence',
            },
          ],
        },
      })
      const invalid = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('detail-unknown'),
        name: 'ticket_read_details',
        arguments: { candidate_aliases: ['c1', 'c3'] },
        agent: fakeAgent('detail-tool-call-unknown'),
      })
      expect(invalid.isError).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an atomic L3 result that cannot fit the selected model context and asks for a smaller batch', async () => {
    const application = stubApplication([])
    application.modelContextTokenLimit = () => 32
    application.readL3Details = vi.fn(application.readL3Details)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(ToolRuntime)
    installRetrievalTools(ctx, application)
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('detail-over-model-context'),
        name: 'ticket_read_details',
        arguments: { candidate_aliases: ['c1', 'c2'] },
        agent: fakeAgent('detail-over-model-context'),
      })

      expect(application.readL3Details).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({
        isError: true,
      })
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('减少 candidate_aliases') }),
      ]))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
