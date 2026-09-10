import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { type RetrievalDecision, type RetrievalState } from '@retrieval-agent/contracts'
import { installRetrievalTools, type RetrievalToolApplication } from './tools.js'

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
    candidates, candidateHistory: candidates, promotedEvidence: [], gaps: [], allowedActions: [{ kind: 'assess' }], } as unknown as RetrievalState
}
async function mounted() {
  const current = state()
  const decisions: RetrievalDecision[] = []
  const app: RetrievalToolApplication = {
    current: () => current, currentOrUndefined: () => current,
    projectContext: async () => ({ rendered: '<ticket_knowledge_context>{"state_id":"state-1"}</ticket_knowledge_context>' }),
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
  it('ships a persona that composes the actual model review and collaboration policies', async () => {
    const { ctx } = await mounted()
    try {
      const preset = parse(await readFile(new URL('../../bundle/presets/retrieval-agent/agent.cordis.yml', import.meta.url), 'utf8'),
        { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }) as { id: string; config: { text: string; complete?: boolean } }[]
      const persona = preset.find(row => row.id === 'persona')!.config
      // Exercise the native complete-section rule with the shipped persona,
      // not a string check that could miss its effect on other contributions.
      ctx.systemPrompt.section({ name: 'retrieval-agent:shipped-persona', order: 0, text: persona.text, complete: persona.complete ?? false })
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(s => s.name)).toEqual(expect.arrayContaining([
        'retrieval-agent:shipped-persona', 'retrieval-agent:policy', 'retrieval-agent:evidence-review', 'retrieval-agent:collaboration',
      ]))
      const system = renderPrompt(assembly)
      expect(system).toContain('默认采用标题与摘要优先')
      expect(system).toContain('用户已回答的口径持续有效')
      expect(system).toContain('不能改成“只有A和B都完成才排除”')
    } finally { await ctx.fiber.dispose() }
  })
  it('identifies the missing delegate scope and the actual nested error instead of unrelated action examples', async () => {
    const { ctx, decisions, execute } = await mounted()
    try {
      const delegate = await execute({ ...base, action: { kind: 'delegate', assignments: [{ domain_id: 'cards', goal: '核实疑点', candidate_aliases: ['c1'] }] } })
      expect(delegate.isError).toBe(true)
      expect(JSON.stringify(delegate.content)).toContain('action.assignments[0].scope')
      const missingKind = await execute({ ...base, action: { reason: 'satisfied', explanation: '摘要足以回答' } })
      expect(JSON.stringify(missingKind.content)).toContain('action.kind is required')
      const serialized = await execute({ ...base, action: JSON.stringify({ kind: 'finish', reason: 'incomplete', explanation: '缺少事实' }) })
      expect(JSON.stringify(serialized.content)).toContain('action must be a JSON object')
      const nested = await execute({ ...base, judgments: [{ candidate_alias: 'c1', verdict: 'exclude', evidence_aliases: ['c1'], reason: '矛盾',
        conflict_resolution: { kind: 'business_scope', reason: '来源说明', evidence_aliases: ['e1'], evidence_aliases_note: '不应存在的字段' } }],
        action: { kind: 'finish', reason: 'satisfied', explanation: '实际依据' } })
      expect(JSON.stringify(nested.content)).toContain('Fix the exact nested field')
      expect(JSON.stringify(nested.content)).not.toContain('Finish requires')
      expect(decisions).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
  it('exposes focused read/search tools and an atomic judgment surface without raw Provider access', async () => {
    const { ctx } = await mounted()
    try {
      expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['ticket_wait', 'ticket_read', 'ticket_search', 'ticket_decide'])
      const schema = JSON.stringify(ctx.tools.schemas())
      expect(schema).not.toContain('raw_payload')
      expect(schema).not.toContain('cursor')
    } finally { await ctx.fiber.dispose() }
  })
  it('recovers specified summaries and searches through the same versioned controller without accepting candidates', async () => {
    const { ctx, decisions } = await mounted()
    const call = (name: string, args: unknown) => ctx.tools.execute({ signal: SIGNAL, callId: CallId(name), name, arguments: args, agent: fakeAgent() })
    try {
      expect((await call('ticket_read', { state_id: 'state-1', candidate_aliases: ['c2'], fields: [], reason: '补充条件后重读依据' })).isError).toBe(false)
      expect(decisions[0]).toMatchObject({ stateId: 'state-1', judgments: [], action: { kind: 'inspect', candidateRefs: ['candidate-2'], fields: [], history: true } })
      expect((await call('ticket_search', { state_id: 'state-1', query: '副卡 解绑', mode: 'dense', reason: '查找遗漏案例' })).isError).toBe(false)
      expect(decisions[1]).toMatchObject({ judgments: [], action: { kind: 'search', mode: 'dense', delta: { kind: 'rewrite_semantic_query', text: '副卡 解绑' } } })
      expect((await call('ticket_search', { state_id: 'state-1', query: '副卡', continue_ranking: true, reason: '混用' })).isError).toBe(true)
      expect(decisions).toHaveLength(2)
      expect((await call('ticket_read', { state_id: 'state-1', candidate_aliases: ['c2'], fields: ['resolution'], reason: '直接核对专家提到的处理原文' })).isError).toBe(false)
      expect(decisions[2]).toMatchObject({ judgments: [], gaps: [], action: { kind: 'inspect', candidateRefs: ['candidate-2'], fields: ['resolution'] } })
    } finally { await ctx.fiber.dispose() }
  })
  it('submits accepts and exclusions with search changes in one call without selecting other tickets', async () => {
    const { ctx, decisions, execute } = await mounted()
    try {
      const result = await execute({ ...base,
        judgments: [{ candidate_alias: 'c1', verdict: 'exclude', evidence_aliases: ['c1'], reason: '摘要说明是宽带问题而非副卡业务。',
          exclusion_checks: [{ requirement_id: 'r1', source_text: '不纳入办理完成后的独立后续问题', applies: 'yes', reason: '摘要已说明办理完成', evidence_aliases: ['c1'] }] }],
        action: { kind: 'search', mode: 'keyword', changes: [
          { type: 'add_terms', terms: ['副卡'] }, { type: 'add_filter', field: 'region', op: 'eq', value: '上海' },
        ] },
      })
      expect(result.isError).toBe(false)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.judgments).toEqual([{ candidateRef: 'candidate-1', verdict: 'exclude', evidenceRefs: ['candidate-1'], reason: '摘要说明是宽带问题而非副卡业务。',
        exclusionChecks: [{ requirementId: 'r1', sourceText: '不纳入办理完成后的独立后续问题', applies: 'yes', reason: '摘要已说明办理完成', evidenceRefs: ['candidate-1'] }] }])
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
  it('uses the same explicit dense query form as ticket_search while rejecting mixed search modes', async () => {
    const { ctx, decisions, execute } = await mounted()
    try {
      const result = await execute({ ...base, action: { kind: 'search', mode: 'dense', query: '副卡异地解绑受阻' } })
      expect(result.isError).toBe(false)
      expect(decisions[0]?.action).toEqual({ kind: 'search', mode: 'dense', delta: { kind: 'rewrite_semantic_query', text: '副卡异地解绑受阻' } })
      expect((await execute({ ...base, action: { kind: 'search', mode: 'keyword', query: '副卡' } })).isError).toBe(true)
      expect(decisions).toHaveLength(1)
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
  it('continues an unstructured response twice through DSH inbox before reporting a persistent protocol failure', async () => {
    const { ctx, app, decisions } = await mounted()
    try {
      const agent = fakeAgent(), inject = vi.spyOn(agent, 'inject')
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
      expect(inject).toHaveBeenCalledOnce()
      expect(app.stopIncomplete).not.toHaveBeenCalled()
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
      expect(app.stopIncomplete).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('未提交'))
      expect(decisions).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
