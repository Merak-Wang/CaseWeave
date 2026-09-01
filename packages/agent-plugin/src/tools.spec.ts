import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type {
  RetrievalActionKind,
  RetrievalState,
  TicketQueryDelta,
} from '@retrieval-agent/contracts'
import type { RetrievalToolApplication } from './tools.js'
import { installRetrievalTools, visibleRetrievalTools } from './tools.js'

const SIGNAL = new AbortController().signal

function fakeAgent(id = 'tool-agent'): Agent {
  const session = Session.create(SessionId(id))
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

function stateWithActions(
  kinds: readonly RetrievalActionKind[],
  mode: 'keyword' | 'dense' | 'hybrid' = 'hybrid',
  nextAction?: 'keyword_search' | 'vector_search',
): RetrievalState {
  return {
    retrievalId: 'retrieval-tools',
    phase: 'assessed',
    termination: 'active',
    query: { original: '副卡', spec: { mode } },
    lastAssessment: nextAction === undefined ? undefined : { decision: 'continue', nextAction },
    allowedActions: kinds.map(kind => ({ kind, candidateAllowlist: [], fieldAllowlist: [], maxTokens: 0 })),
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

function stubApplication(searchCalls: SearchCall[]): RetrievalToolApplication {
  const stopped = stoppedState()
  return {
    contextTokenBudget: 1_500,
    currentOrUndefined: () => undefined,
    current: () => stateWithActions(['read_state']),
    search: (_agent, input) => {
      searchCalls.push(input)
      return Promise.resolve(stopped)
    },
    continueRanking: () => Promise.resolve(stopped),
    assess: () => Promise.resolve(stopped),
    promote: () => Promise.resolve(stopped),
    requestClarification: () => stopped,
    answerClarification: () => stopped,
    recordToolCall: () => Promise.resolve(stopped),
  }
}

async function mountedTools(searchCalls: SearchCall[] = []) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  installRetrievalTools(ctx, stubApplication(searchCalls), { maxFinishReminders: 3 })
  return ctx
}

describe('retrieval tool surface', () => {
  it('registers structured assessment but keeps start, cursor and freeze outside the model surface', async () => {
    const ctx = await mountedTools()
    try {
      const registered = ctx.tools.schemas().map(tool => tool.name)
      expect(registered).toContain('ticket_keyword_search')
      expect(registered).toContain('ticket_vector_search')
      expect(registered).not.toContain('ticket_start')
      expect(registered).not.toContain('ticket_search')
      expect(registered).toContain('ticket_assess_state')
      expect(registered).not.toContain('ticket_assess')
      expect(registered).not.toContain('ticket_freeze')
      const searchSchemas = ctx.tools.schemas()
        .filter(tool => tool.name === 'ticket_keyword_search' || tool.name === 'ticket_vector_search')
      expect(searchSchemas.every(tool => !JSON.stringify(tool.parameters).includes('cursor'))).toBe(true)

      const assembly = await ctx.systemPrompt.assemble({ agent: fakeAgent('first-assembly') })
      expect(assembly.tools.map(tool => tool.name)).toEqual([
        'ticket_assess_state', 'ticket_continue_ranking', 'ticket_keyword_search', 'ticket_promote',
        'ticket_request_clarification', 'ticket_state', 'ticket_vector_search',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects independent repair channels and keeps provider cursors model-hidden', () => {
    expect([...visibleRetrievalTools(undefined)]).toEqual([
      'ticket_assess_state', 'ticket_continue_ranking', 'ticket_keyword_search', 'ticket_vector_search',
      'ticket_promote', 'ticket_request_clarification', 'ticket_state',
    ])
    expect([...visibleRetrievalTools(stoppedState())]).toEqual([
      'ticket_assess_state', 'ticket_continue_ranking', 'ticket_keyword_search', 'ticket_vector_search',
      'ticket_promote', 'ticket_request_clarification', 'ticket_state',
    ])
    expect(visibleRetrievalTools(stateWithActions(['assess', 'read_state']))).toEqual(new Set([
      'ticket_assess_state', 'ticket_state',
    ]))
    expect(visibleRetrievalTools(stateWithActions(['repair_search', 'read_state'], 'hybrid', 'keyword_search'))).toEqual(new Set([
      'ticket_keyword_search', 'ticket_state',
    ]))
    expect(visibleRetrievalTools(stateWithActions(['repair_search', 'read_state'], 'hybrid', 'vector_search'))).toEqual(new Set([
      'ticket_vector_search', 'ticket_state',
    ]))
    expect(visibleRetrievalTools(stateWithActions(['search_next'], 'hybrid'))).toEqual(new Set(['ticket_continue_ranking']))
  })

  it('returns a machine-readable recovery payload for schema failures', async () => {
    const ctx = await mountedTools()
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('keyword-invalid'),
        name: 'ticket_keyword_search',
        arguments: { delta_kind: 'add_terms', terms: ['副卡'] },
        agent: fakeAgent('invalid-tool-call'),
      })
      expect(result.isError).toBe(true)
      const text = result.content.find(block => block.type === 'text')?.text ?? ''
      expect(JSON.parse(text)).toMatchObject({
        type: 'retrieval_tool_error',
        tool: 'ticket_keyword_search',
        code: expect.any(String),
        allowedActions: [],
        repairExample: { change: { type: 'replace_terms', terms: ['副卡', '跨域'] } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fixes each search mode and concludes with the Harness-generated collection', async () => {
    const calls: SearchCall[] = []
    const ctx = await mountedTools(calls)
    const agent = fakeAgent('tool-execution')
    try {
      const keyword = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('keyword-1'),
        name: 'ticket_keyword_search',
        arguments: { change: { type: 'add_terms', terms: ['副卡'] } },
        agent,
      })
      const vector = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('vector-1'),
        name: 'ticket_vector_search',
        arguments: { query: '解绑后流量仍共享' },
        agent,
      })

      expect(calls).toEqual([
        { mode: 'keyword', delta: { kind: 'add_terms', terms: ['副卡'] } },
        { mode: 'dense', delta: { kind: 'rewrite_semantic_query', text: '解绑后流量仍共享' } },
      ])
      expect(keyword).toMatchObject({
        isError: false,
        concludesTurn: true,
        value: { type: 'ticket_collection', stoppingReason: 'no_result', tickets: [] },
      })
      expect(vector).toMatchObject({
        isError: false,
        concludesTurn: true,
        value: { type: 'ticket_collection', stoppingReason: 'no_result', tickets: [] },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
