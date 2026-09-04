import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { type RetrievalDecision, type RetrievalState } from '@retrieval-agent/contracts'
import { installRetrievalTools, visibleRetrievalTools, type RetrievalToolApplication } from './tools.js'

const SIGNAL = new AbortController().signal
function fakeAgent(): Agent {
  const session = Session.create(SessionId('decision-tools'))
  return { id: session.id, options: {}, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'running', ctx: new Context(), send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(SIGNAL), whenIdle: () => Promise.resolve(), }
}
function state(): RetrievalState {
  const candidates = [1, 2].map(n => ({ ref: `candidate-${n}`, title: `标题${n}`, summary: `摘要${n}` }))
  return { stateId: 'state-1', retrievalId: 'retrieval-1', phase: 'assessed', termination: 'active',
    candidates, candidateHistory: candidates, promotedEvidence: [], allowedActions: [{ kind: 'assess' }], } as unknown as RetrievalState
}
async function mounted() {
  const current = state()
  const decisions: RetrievalDecision[] = []
  const app: RetrievalToolApplication = {
    current: () => current, currentOrUndefined: () => current,
    projectContext: () => ({ rendered: '<ticket_knowledge_context>{"state_id":"state-1"}</ticket_knowledge_context>' }),
    decide: async (_agent, decision) => { decisions.push(decision); return current },
    recordToolCall: async () => current, stopIncomplete: vi.fn(async () => current),
  }
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  installRetrievalTools(ctx, app)
  const execute = (args: unknown) => ctx.tools.execute({ signal: SIGNAL, callId: CallId('decide'), name: 'ticket_decide', arguments: args, agent: fakeAgent() })
  return { ctx, app, decisions, execute }
}
const base = { state_id: 'state-1', judgments: [], semantic_gaps: [] }

describe('public decision tool', () => {
  it('exposes one structured action surface without Provider cursors or raw payload access', async () => {
    const { ctx } = await mounted()
    try {
      expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['ticket_decide'])
      const schema = JSON.stringify(ctx.tools.schemas())
      expect(schema).not.toContain('raw_payload')
      expect(schema).not.toContain('cursor')
      expect(visibleRetrievalTools(undefined)).toEqual(new Set(['ticket_decide']))
      expect(visibleRetrievalTools({ ...state(), termination: 'needs_clarification' })).toEqual(new Set(['ticket_decide']))
      expect(visibleRetrievalTools({ ...state(), phase: 'stopped' })).toEqual(new Set(['ticket_decide']))
    } finally { await ctx.fiber.dispose() }
  })
  it('submits accepts and exclusions with search changes in one call without selecting other tickets', async () => {
    const { ctx, decisions, execute } = await mounted()
    try {
      const result = await execute({ ...base,
        judgments: [{ candidate_alias: 'c1', verdict: 'exclude', evidence_aliases: ['c1'], reason: '摘要说明是宽带问题而非副卡业务。' }],
        action: { kind: 'search', mode: 'keyword', changes: [
          { type: 'add_terms', terms: ['副卡'] }, { type: 'add_filter', field: 'region', op: 'eq', value: '上海' },
        ] },
      })
      expect(result.isError).toBe(false)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.judgments).toEqual([{ candidateRef: 'candidate-1', verdict: 'exclude', evidenceRefs: ['candidate-1'], reason: '摘要说明是宽带问题而非副卡业务。' }])
      expect(decisions[0]?.action).toMatchObject({ kind: 'search', mode: 'keyword', delta: { kind: 'batch', changes: [
        { kind: 'add_terms', terms: ['副卡'] }, { kind: 'add_filter', filter: { field: 'region', op: 'eq', value: '上海' } },
      ] } })
    } finally { await ctx.fiber.dispose() }
  })
  it('returns concrete errors for unknown aliases and conflicting search operations without invoking application', async () => {
    const { ctx, decisions, execute } = await mounted()
    try {
      const badAlias = await execute({ ...base, judgments: [{ candidate_alias: 'c3', verdict: 'accept', evidence_aliases: ['c3'], reason: '伪造' }], action: { kind: 'finish', reason: 'satisfied', explanation: '完成' } })
      expect(badAlias.isError).toBe(true)
      expect(badAlias.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('不在当前有效集合') })]))
      const conflict = await execute({ ...base, action: { kind: 'search', continue_ranking: true, query: '副卡' } })
      expect(conflict.isError).toBe(true)
      expect(decisions).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
  it('advances only one requested Provider page and leaves the next judgment to the model', async () => {
    const { ctx, decisions, execute } = await mounted()
    try {
      expect((await execute({ ...base, action: { kind: 'search', continue_ranking: true } })).isError).toBe(false)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.action).toEqual({ kind: 'search', continueRanking: true })
      expect(decisions[0]?.judgments).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
  it('passes a controlled evidence batch and next summary window through the same inspect action', async () => {
    const { ctx, decisions, execute } = await mounted()
    try {
      expect((await execute({ ...base, action: { kind: 'inspect', candidate_aliases: ['c1', 'c2'], fields: ['resolution'], token_budget: 200 } })).isError).toBe(false)
      expect(decisions[0]?.action).toEqual({ kind: 'inspect', candidateRefs: ['candidate-1', 'candidate-2'], fields: ['resolution'], tokenBudget: 200 })
      expect((await execute({ ...base, action: { kind: 'inspect', next_window: true } })).isError).toBe(false)
      expect(decisions[1]?.action).toEqual({ kind: 'inspect', nextWindow: true })
    } finally { await ctx.fiber.dispose() }
  })
  it('persists the actual question and cited candidate differences in the clarify submission', async () => {
    const { ctx, decisions, execute } = await mounted()
    try {
      expect((await execute({ ...base, action: { kind: 'clarify', question: '只需要上海还是也包含北京？', candidate_aliases: ['c1', 'c2'], evidence_aliases: ['c1', 'c2'] } })).isError).toBe(false)
      expect(decisions[0]?.action).toMatchObject({ kind: 'clarify', question: '只需要上海还是也包含北京？', candidateRefs: ['candidate-1', 'candidate-2'] })
    } finally { await ctx.fiber.dispose() }
  })
  it('stops explicitly after an unstructured response without reminders, automatic search, or acceptance', async () => {
    const { ctx, app, decisions } = await mounted()
    try {
      await agentEvents(ctx, fakeAgent()).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
      expect(app.stopIncomplete).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('未提交'))
      expect(decisions).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})
