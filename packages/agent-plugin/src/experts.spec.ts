import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { LlmAdapter, CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Skills from '@deepseek-ai/dsh-skill'
import Questions from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { foldRetrievalEvents } from '@retrieval-agent/domain'
import { readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import { createTicketResultCollection } from '@retrieval-agent/domain/result'
import type { TicketRetrievalProvider, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { TicketPrincipalProviderService, TicketRetrievalProviderService } from './provider-services.js'
import { RetrievalAgentService } from './service.js'
import { ExpertCoordinator } from './experts.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { installRetrievalTools } from './tools.js'
import { installWorkingContext } from './working-context.js'
import { installRetrievalRuntimeBudget } from './context-budget.js'
import { requestTokens } from './context-recovery.js'
import { inject } from './index.js'
import { openWiki } from './wiki-store.js'

const p: TrustedPrincipalContext = { tenantId: 'expert-test', subjectId: 'tester', entitlementVersion: '1', purpose: 'ticket_retrieval', attributes: {}, issuedAt: new Date().toISOString() }
class Principal extends TicketPrincipalProviderService { async resolve() { return p } }
class Provider extends TicketRetrievalProviderService {
  constructor(ctx: Context, readonly delegate: TicketRetrievalProvider) { super(ctx) }
  get providerId() { return this.delegate.providerId }
  resolve: TicketRetrievalProvider['resolve'] = (...args) => this.delegate.resolve(...args)
  openSnapshot: TicketRetrievalProvider['openSnapshot'] = (...args) => this.delegate.openSnapshot(...args)
  search: TicketRetrievalProvider['search'] = (...args) => this.delegate.search(...args)
  readEvidence: TicketRetrievalProvider['readEvidence'] = (...args) => this.delegate.readEvidence(...args)
  readDetails: TicketRetrievalProvider['readDetails'] = (...args) => this.delegate.readDetails(...args)
  status: TicketRetrievalProvider['status'] = (...args) => this.delegate.status(...args)
}
const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings)
  : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
class ScriptedExperts extends LlmAdapter {
  constructor(readonly useWiki = false, readonly questionGate?: Promise<void>, readonly continuation = false, readonly quota = false, readonly broken = false, readonly expectedWikiReference?: string,
    readonly pipeline?: { gate: Promise<void>; mainWorked(): void; partial(): void }) { super() }
  mainRead = false
  readonly requests: GenerateOptions[] = []
  readonly turns = new Map<string, number>()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const session = options.sessionId!; const step = (this.turns.get(session) ?? 0) + 1; this.turns.set(session, step)
    if (step > (this.broken ? 30 : this.quota ? 14 : 8)) throw new Error('fixture exceeded expected model steps')
    const text = options.messages.flatMap(m => strings(m.content)).join('\n')
    const header = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)].map(m => JSON.parse(m[1]!)).at(-1).knowledgeState
    const isExpert = options.tools?.some(t => t.name === 'ticket_expert')
    let toolName = isExpert ? 'ticket_expert' : 'ticket_decide'
    let args: unknown
    if (isExpert) {
      expect(options.tools?.map(t => t.name)).toEqual(['ticket_expert'])
      expect(header.actionState.callableToolsNow).toEqual(['ticket_expert'])
      expect(header.actionState.clarificationChannel).toContain('ticket_expert report.question')
      const knowledge = [...text.matchAll(/<untrusted_retrieval_knowledge>(.*?)<\/untrusted_retrieval_knowledge>/gu)].map(m => JSON.parse(m[1]!)).at(-1)
      if (this.pipeline && step === 1 && knowledge.scope === '反例核查') await this.pipeline.gate
      if (this.useWiki) expect(knowledge.entries[0]?.reference).toBe(this.expectedWikiReference)
      if (this.broken) args = {}
      else if (this.quota && step <= 12) args = { action: 'inspect', candidate_aliases: ['c1'], fields: [] }
      else if (step === 1 && this.questionGate && knowledge.scope === '支持核查') args = {
        action: 'report', judgments: [{ candidate_alias: 'c1', verdict: 'undetermined', evidence_aliases: ['c1'], reason: '办理范围需用户确认。' }],
        semantic_gaps: [{ kind: 'ambiguity', status: 'open', evidence_aliases: ['c1'], description: '是否包括解绑后的共享流量？' }],
        question: '是否包括解绑后的共享流量？', next_action: '请主 Agent 提问；其他反例核查可继续。' }
      else if (step === 1) { await this.questionGate; args = { action: 'search', query: '副卡解绑', mode: 'dense', judgments: [], semantic_gaps: [] } }
      else if (step === 2 || this.continuation && !text.includes('末尾反例：状态曾反复，需复核')) {
        if (step > 2) expect(header.evidenceState.nextPosition).toMatchObject({ candidate_alias: 'c1', field: 'answer' })
        args = { action: 'inspect', candidate_aliases: ['c1'], fields: ['answer'], judgments: [], semantic_gaps: [],
          ...(step > 2 ? { position: header.evidenceState.nextPosition } : {}) }
      }
      else args = { action: 'report', judgments: [{ candidate_alias: 'c1', verdict: knowledge.scope === '支持核查' ? 'accept' : 'exclude', evidence_aliases: [this.quota ? 'c1' : 'e1'], reason: '已收到的记录用于测试独立专家的相反解释。' }],
        semantic_gaps: [], counter_evidence_aliases: [this.quota ? 'c1' : 'e1'], next_action: '请主 Agent 核对处理结论并解决业务解释分歧。', disagreement_kind: 'business_scope' }
    } else if (step === 1) args = { state_id: header.stateId, judgments: [], semantic_gaps: [], action: { kind: 'delegate', assignments: [
      { domain_id: this.useWiki ? 'primary-secondary-card' : 'general', goal: '核对副卡解绑', scope: '支持核查', candidate_aliases: ['c1'], ...(this.useWiki ? { knowledge_ids: ['primary-secondary-card-cross-domain'] } : {}) },
      { domain_id: this.useWiki ? 'primary-secondary-card' : 'general', goal: '检查副卡解绑反例', scope: '反例核查', candidate_aliases: ['c1'], ...(this.useWiki ? { knowledge_ids: ['primary-secondary-card-cross-domain'] } : {}) },
    ] } }
    else if (this.pipeline && !this.mainRead) {
      this.mainRead = true; this.pipeline.mainWorked()
      args = { state_id: header.stateId, judgments: [], semantic_gaps: [], action: { kind: 'inspect', candidate_aliases: ['c1'], fields: ['answer'] } }
    }
    else if (header.experts?.tasks.some((t: { status: string }) => ['pending', 'running'].includes(t.status))
      && !(this.questionGate && header.experts.tasks.some((t: { finding?: { question?: string } }) => t.finding?.question))) {
      if (this.pipeline && header.experts.tasks.some((t: { status: string }) => t.status === 'completed')) this.pipeline.partial()
      toolName = 'ticket_wait'; args = { task_ids: header.experts.tasks.filter((t: { status: string }) => ['pending', 'running'].includes(t.status)).map((t: { id: string }) => t.id) }
    }
    else if (this.broken) args = { state_id: header.stateId, judgments: [], semantic_gaps: [], action: { kind: 'finish', reason: 'incomplete',
      explanation: '两位专家因持续无效调用达到请求额度，没有有效产物，当前任务未完成。', coverage: {
        checked: ['原文快查已产生候选'], remaining: ['专家取证与逐条判断尚未完成'], nextAction: '修正模型工具使用后继续复核', nextActionValue: 'useful' } } }
    else if (this.questionGate) args = { state_id: header.stateId, judgments: [], semantic_gaps: [{ kind: 'ambiguity', status: 'open', evidence_aliases: ['c1'], description: '专家请求确认范围' }],
      action: { kind: 'clarify', question: '是否包括解绑后的共享流量？', candidate_aliases: ['c1'], evidence_aliases: ['c1'] } }
    else if (!this.mainRead) { this.mainRead = true; args = { state_id: header.stateId, judgments: [], semantic_gaps: [],
      action: { kind: 'inspect', candidate_aliases: ['c1'], fields: ['answer'] } } }
    else args = { state_id: header.stateId, judgments: [{ candidate_alias: 'c1', verdict: 'accept', evidence_aliases: ['e1'], reason: '来源确认解绑未生效，属于查询范围。',
      conflict_resolution: { kind: 'business_scope', reason: '处理字段明确解绑未生效；排除解释不符合来源。', evidence_aliases: ['e1'] } }], semantic_gaps: [],
      action: { kind: 'finish', reason: 'satisfied', explanation: '处理原文解决范围分歧，当前任务所需个案已有证据，无待查方向。',
        coverage: { checked: ['解绑状态与反例'], remaining: [], nextAction: '个案要求已解决，无需继续扩展。', nextActionValue: 'none' } } }
    await new Promise(resolve => setTimeout(resolve, 8))
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`${session}-${step}`), name: toolName, arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 100 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

describe('A3/A4/A6/A9 installed DSH expert execution', () => {
  it.each([false, 'always', 'reset'] as const)('bounds the public DSH context and repeated tool errors (invalid=%s)', async invalid => {
    const ctx = new Context(); let dispose: (() => Promise<void>) | undefined
    let calls = 0; let recovered = false
    class ScaleAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls++; if (calls > 64) throw new Error('scale fixture loop')
        const text = options.messages.flatMap(m => strings(m.content)).join('\n')
        const header = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)].map(m => JSON.parse(m[1]!)).at(-1).knowledgeState
        if (calls === 61) recovered = text.includes('第一个反例：仅欠费停机，未解绑')
        const action = invalid === 'reset' && calls === 2 ? { kind: 'inspect', history: true, candidate_aliases: ['c1'], fields: [] }
          : calls < 60 ? { kind: 'search', continue_ranking: true }
          : calls === 60 ? { kind: 'inspect', history: true, candidate_aliases: ['c1'], fields: [] }
            : { kind: 'finish', reason: 'incomplete', explanation: '当前表达式已枚举，1200 条候选仍需逐项复核；早期欠费反例已取回。' }
        const args = invalid && !(invalid === 'reset' && calls === 2) ? {} : { state_id: header.stateId, judgments: calls === 1 ? [{ candidate_alias: 'c1', verdict: 'exclude', evidence_aliases: ['c1'], reason: '第一个反例只涉及欠费停机。' }] : [], semantic_gaps: [], action }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`scale-${calls}`), name: 'ticket_decide', arguments: JSON.stringify(args) } }
        yield { type: 'usage', usage: { inputTokens: 1800, outputTokens: 100 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    try {
      await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
      await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter); new Principal(ctx)
      const records = Array.from({ length: 1200 }, (_, i) => normalizeFixtureTicket({ ticketId: `large-${i}`, displayId: String(i).padStart(4, '0'),
        tenantId: p.tenantId, allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'scale-v1', title: `副卡工单 ${i}`,
        summary: i === 0 ? '第一个反例：仅欠费停机，未解绑' : `副卡待复核工单 ${i}`, conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable' }))
      const provider = new LocalTicketProvider(records, { defaultMode: 'hybrid', ranker: { profileVersion: 'scale', capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
        rank: async (documents, query) => ({ hits: documents.map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1, channels: [] })),
          execution: { requestedMode: query.mode, executedMode: query.mode, strategyVersion: 'scale', channels: [] }, scanned: documents.length, keywordEligible: documents.length, rankedHits: documents.length, warnings: [] }) } })
      new Provider(ctx, provider); const application = new RetrievalAgentService(ctx, { maxContextTokens: 24000, maxRepeatedToolErrors: 3 })
      installAutomaticRetrievalStart(ctx, application, { analyzer: { analyze: async () => ({ protocolVersion: 'retrieval-agent.models.v1', requestId: 'scale',
        analyzer: { engine: 'spacy', engineVersion: '1', pipeline: 'fixture', pipelineVersion: '1', lexiconVersion: '1', loaded: true, components: [] }, language: 'zh',
        keywords: ['副卡'], candidates: [], tokens: [], entities: [], triples: [], elapsedMs: 0 }) } })
      installRetrievalTools(ctx, application); installWorkingContext(ctx, application); installRetrievalRuntimeBudget(ctx, application)
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      ctx.llm.registerAdapter(['scale'], new ScaleAdapter())
      const handle = await ctx.agents.create({ sessionId: SessionId('public-scale'), agentOptions: { provider: 'scale', model: 'fixture' } }); dispose = handle.dispose
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '查找全部副卡工单' }] }))
      await handle.agent.whenIdle()
      const state = application.current(handle.agent)
      if (invalid) {
        expect(calls).toBe(invalid === 'reset' ? 5 : 3)
        expect(state.termination).toBe('budget_exhausted')
        expect(state.stopExplanation).toContain('工具调用死循环')
        expect(state.budget.consecutiveToolErrors).toBe(3)
        expect(state.budget.successfulToolCalls ?? 0).toBe(invalid === 'reset' ? 1 : 0)
        expect(state.selectedCandidateRefs).toEqual([])
        expect(foldRetrievalEvents(readRetrievalSessionEvents(handle.agent.session))?.termination).toBe('budget_exhausted')
        return
      }
      expect(calls).toBe(61)
      expect(state.candidates).toHaveLength(1200)
      expect(recovered).toBe(true)
      expect(state.termination).toBe('partial')
      // Bound the full request in tokens, including schemas, not an arbitrary
      // character count that would force discarding useful low-pressure history.
      expect(state.contextManifests?.filter(m => m.measurement === 'dsh_request').every(m => m.estimatedTokens <= 24000 - 2560)).toBe(true)
      expect(state.contextManifests?.filter(m => m.measurement === 'dsh_request')).toHaveLength(61)
      expect(state.budget.totalMeasuredInputTokens).toBe(61 * 1800)
      expect(foldRetrievalEvents(readRetrievalSessionEvents(handle.agent.session))?.candidates).toHaveLength(1200)
    } finally { await dispose?.(); await ctx.fiber.dispose() }
  }, 60000)
  it.each([false, true, 'question', 'continuation', 'quota', 'broken', 'pipeline'] as const)('runs parallel specialists with Wiki=%s, shares I/O, resolves disagreement and replays evidence', async variant => {
    const useWiki = variant === true
    let releaseQuestion!: () => void
    const questionGate = variant === 'question' ? new Promise<void>(resolve => { releaseQuestion = resolve }) : undefined
    const ctx = new Context(); let dispose: (() => Promise<void>) | undefined
    const failures: unknown[] = []; let rankingCalls = 0; let reads = 0
    let releasePipeline!: () => void, pipelineReleased = false, mainOverlapped = false, partialReceived = false
    const gate = new Promise<void>(resolve => { releasePipeline = () => { pipelineReleased = true; resolve() } })
    const timeout = variant === 'pipeline' ? setTimeout(releasePipeline, 4000) : undefined
    const pipeline = variant === 'pipeline' ? { gate, mainWorked: () => { mainOverlapped = !pipelineReleased },
      partial: () => { partialReceived = !pipelineReleased; releasePipeline() } } : undefined
    try {
      await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime); await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
      await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' })
      await ctx.plugin(Skills); await ctx.plugin(Questions)
      ctx.skills.register({ name: 'ticket-evidence-review', description: '核对来源事实', source: 'bundled', content: '读取来源并保留反例。' })
      expect((await ctx.skills.get('ticket-evidence-review'))?.content).toContain('反例')
      new Principal(ctx)
      const record = normalizeFixtureTicket({ ticketId: 'one', displayId: 'ONE', tenantId: p.tenantId, allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'source-v1',
        title: '副卡解绑', summary: '副卡解绑后仍共享流量，需要核对处理结果。', answer: '来源处理记录：解绑未生效，重新同步成功。'
          + (variant === 'continuation' ? '来源对话持续记录。'.repeat(600) + '末尾反例：状态曾反复，需复核' : ''),
        conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable' })
      const provider = new LocalTicketProvider([record], { defaultMode: 'hybrid', ranker: { profileVersion: 'expert-fixture', capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
        rank: async (documents, query) => { rankingCalls++; await new Promise(resolve => setTimeout(resolve, 25)); return {
          hits: documents.map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1, channels: [{ channel: 'keyword' as const, rank: i + 1, score: 1 }] })),
          execution: { requestedMode: query.mode, executedMode: query.mode, strategyVersion: 'fixture', channels: [] }, scanned: documents.length, keywordEligible: documents.length, rankedHits: documents.length, warnings: [] } } } })
      const read = provider.readEvidence.bind(provider); provider.readEvidence = async (...args) => { reads++; return read(...args) }
      new Provider(ctx, provider)
      const application = new RetrievalAgentService(ctx, { maxContextTokens: 32000 })
      // Use the same injected plugin scope as a mounted production preset.
      await ctx.plugin({ name: 'expert-scope', inject, apply(scope: Context) {
        new ExpertCoordinator(scope, application, useWiki ? 'wiki' : undefined)
      } })
      let delegatedQuestionChecks = 0
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        if (agent.session.header.origin === 'subagent') {
          await expect(ctx.userQuestions.ask({ agent, questions: [{ id: 'scope-question', question: '确认范围？' }] }))
            .rejects.toMatchObject({ code: 'DELEGATED_CALLER' })
          delegatedQuestionChecks++
        }
        return next()
      }, { global: true })
      installAutomaticRetrievalStart(ctx, application, { analyzer: { analyze: async () => ({ protocolVersion: 'retrieval-agent.models.v1', requestId: 'fixture',
        analyzer: { engine: 'spacy', engineVersion: '1', pipeline: 'fixture', pipelineVersion: '1', lexiconVersion: '1', loaded: true, components: [] },
        language: 'zh', keywords: ['副卡'], candidates: [], tokens: [], entities: [], triples: [], elapsedMs: 0 }) } })
      installRetrievalTools(ctx, application); installWorkingContext(ctx, application); installRetrievalRuntimeBudget(ctx, application)
      ctx.on('tools/result', (_exec, result) => { if (result.isError) failures.push(result.content) }, { global: true })
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      const expectedWikiReference = useWiki ? (await openWiki('wiki')).read('primary-secondary-card-cross-domain').reference : undefined
      const adapter = new ScriptedExperts(useWiki, questionGate, variant === 'continuation', variant === 'quota', variant === 'broken', expectedWikiReference, pipeline); ctx.llm.registerAdapter(['expert-fixture'], adapter)
      const handle = await ctx.agents.create({ sessionId: SessionId('expert-public-flow'), agentOptions: { provider: 'expert-fixture', model: 'scripted' } }); dispose = handle.dispose
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '找副卡解绑工单' }] }))
      const idle = handle.agent.whenIdle()
      if (questionGate) {
        const deadline = Date.now() + 5000
        while (application.currentOrUndefined(handle.agent)?.phase !== 'awaiting_clarification' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        expect(application.current(handle.agent).phase, JSON.stringify({ failures, tasks: application.current(handle.agent).expertTasks, turns: [...adapter.turns] })).toBe('awaiting_clarification')
        expect(application.current(handle.agent).expertTasks?.some(t => t.status === 'running')).toBe(true)
        releaseQuestion()
      }
      await idle
      await application.coordinator?.settlePending?.(handle.agent)
      const state = application.current(handle.agent)
      if (pipeline) { expect(mainOverlapped, 'main must read while the second expert is still working').toBe(true)
        expect(partialReceived, 'main must consume the first finding before the whole batch finishes').toBe(true) }
      if (variant === 'broken') {
        expect(state.expertTasks?.every(t => t.status === 'failed' && t.modelSteps === 4 && t.actionsUsed === 0 && t.failure?.includes('工具调用死循环'))).toBe(true)
        expect(adapter.requests.filter(r => r.tools?.some(t => t.name === 'ticket_expert'))).toHaveLength(8)
        expect(state.termination).toBe('partial')
        expect(state.selectedCandidateRefs).toEqual([])
        expect(foldRetrievalEvents(readRetrievalSessionEvents(handle.agent.session))?.expertTasks).toEqual(state.expertTasks)
        return
      }
      if (variant === 'quota') {
        expect(failures, JSON.stringify({ tasks: state.expertTasks, failures, turns: [...adapter.turns] })).toEqual([])
        expect(state.expertTasks?.every(t => t.actionsUsed === 13 && t.actionsUsed > t.maxActions)).toBe(true)
      } else expect(failures, JSON.stringify({ tasks: state.expertTasks, turns: [...adapter.turns] })).toEqual([])
      expect(state.expertTasks?.map(t => t.status), JSON.stringify(handle.agent.session.events.filter(e => e.type === 'turn/end'))).toEqual(['completed', 'completed'])
      expect(adapter.turns.size).toBe(3)
      for (const request of adapter.requests) {
        const tool = request.tools?.find(t => t.name === 'ticket_decide')
        if (tool) {
          const properties = tool.parameters.properties as { action: { oneOf: { properties: { kind: { const: string } }; required: string[] }[] } }
          expect(properties.action.oneOf.find(f => f.properties.kind.const === 'finish')!.required).toContain('coverage')
        }
      }
      expect(delegatedQuestionChecks).toBeGreaterThanOrEqual(2)
      expect(rankingCalls).toBe(variant === 'quota' ? 1 : 2) // initial + one shared expert search
      if (variant === 'continuation') {
        expect(reads).toBeGreaterThan(2)
        const spans = state.promotedEvidence.filter(e => e.field === 'answer').sort((a, b) => a.start - b.start)
        for (const task of state.expertTasks!) {
          const seen = new Set(state.contextManifests?.filter(m => m.roleId === task.id && m.measurement === 'dsh_request').flatMap(m => m.evidenceIds))
          const rebuilt = new Array<string>(record.answer!.length)
          for (const span of spans.filter(s => seen.has(s.evidenceId))) {
            expect(span.text).toBe(record.answer!.slice(span.start, span.end))
            for (let index = span.start; index < span.end; index++) rebuilt[index] = span.text[index - span.start]!
          }
          expect(rebuilt.join('')).toBe(record.answer)
        }
        expect(state.expertTasks?.every(t => t.context && !t.context.evidencePosition)).toBe(true)
        for (const task of state.expertTasks!) expect(state.contextManifests?.some(m => m.roleId === task.id && m.measurement === 'dsh_request'
          && m.evidenceIds.includes(spans.at(-1)!.evidenceId))).toBe(true)
      } else expect(reads).toBe(questionGate || variant === 'quota' ? 1 : 2) // one shared expert read + main conflict re-read
      expect(state.expertConflicts).toMatchObject([{ status: questionGate ? 'open' : 'resolved', kind: 'business_scope' }])
      expect(state.contextManifests?.filter(m => m.roleId !== 'main').length).toBeGreaterThanOrEqual(questionGate ? 4 : 6)
      expect(new Set(state.contextManifests?.map(m => m.roleId)).size).toBe(3)
      if (questionGate) { expect(state.phase).toBe('awaiting_clarification'); expect(state.selectedCandidateRefs).toEqual([]) }
      else expect(createTicketResultCollection(state)?.tickets.map(c => c.displayId)).toEqual(['ONE'])
      expect(foldRetrievalEvents(readRetrievalSessionEvents(handle.agent.session))?.expertTasks).toEqual(state.expertTasks)
      expect(adapter.requests.map(request => requestTokens(ctx, request) + 2560).filter(tokens => tokens > 32000)).toEqual([])
      expect(state.knowledgeCatalog?.status).toBe(useWiki ? 'available' : 'empty')
      expect(state.contextManifests?.some(m => m.measurement === 'dsh_request' && m.knowledgeRefs.length > 0)).toBe(useWiki)
      const prior = state.expertTasks![0]!.finding!
      await application.applyUserFeedback(handle.agent, { accepted: true, answer: '请依据原始工单重新核对。' })
      await expect(application.updateExpert(handle.agent, prior.inputGeneration, { kind: 'finding', finding: prior })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
      expect(application.current(handle.agent).selectedCandidateRefs).toEqual([])
    } finally { clearTimeout(timeout); releasePipeline(); releaseQuestion?.(); await dispose?.(); await ctx.fiber.dispose() }
  }, 20000)
})
