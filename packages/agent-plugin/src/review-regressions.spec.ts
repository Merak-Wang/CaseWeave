import SessionProjection from '@deepseek-ai/dsh-session-projection'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import type { RetrievalRanker } from '@retrieval-agent/model-service-client/ranking'
import type { TicketRetrievalProvider } from '@retrieval-agent/contracts'
import { TicketPrincipalProviderService, TicketRetrievalProviderService } from './provider-services.js'
import { RetrievalAgentService } from './service.js'
import { SemanticOperators } from './semantic-operators.js'
import { PythonOperatorBridge } from './python-operator-bridge.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { installRetrievalTools } from './tools.js'
import { installRetrievalRuntimeBudget } from './context-budget.js'
import { projectOrchestration } from '../../product-host/src/orchestration.js'
import { recoverExecutionClock, foldRetrievalEvents } from '@retrieval-agent/domain'
import { createTicketResultCollection } from '@retrieval-agent/domain/result'
import { readRetrievalSessionEvents } from '../../dsh-compat/src/index.js'
import { validateOperatorArtifact } from '../../domain/src/semantic-operators.js'

class Principal extends TicketPrincipalProviderService {
  async resolve() { return { tenantId: 'operators', subjectId: 'reader', entitlementVersion: 'v1', purpose: 'ticket_retrieval' as const,
    attributes: {}, issuedAt: new Date().toISOString() } }
}
class Provider extends TicketRetrievalProviderService {
  constructor(ctx: Context, readonly port: TicketRetrievalProvider) { super(ctx) }
  get providerId() { return this.port.providerId }
  resolve: TicketRetrievalProvider['resolve'] = (...a) => this.port.resolve(...a)
  openSnapshot: TicketRetrievalProvider['openSnapshot'] = (...a) => this.port.openSnapshot(...a)
  search: TicketRetrievalProvider['search'] = (...a) => this.port.search(...a)
  readEvidence: TicketRetrievalProvider['readEvidence'] = (...a) => this.port.readEvidence(...a)
  readDetails: TicketRetrievalProvider['readDetails'] = (...a) => this.port.readDetails(...a)
  status: TicketRetrievalProvider['status'] = (...a) => this.port.status(...a)
}

// Controlled model only determines fixture semantics; real DSH, Python, Provider and tools execute.
async function fixture(options: { derived?: 'sem_topk' | 'sem_agg' | 'sem_extract' | 'sem_join'; sourceRequired?: boolean; readSource?: boolean; recordCount?: number; repeatDerived?: number } = {}) {
  const ctx = new Context(), searches: string[] = [], errors: string[] = [], requests: GenerateOptions[] = []
  const records = Array.from({ length: options.recordCount ?? 2 }, (_, i) => ['宽带停机案例', '副卡解绑案例'][i % 2]!).map((summary, i) => normalizeFixtureTicket({
    ticketId: `r${i}`, displayId: `R-${i}`, tenantId: 'operators', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'v1',
    title: summary, summary, summaryOrigin: { kind: 'source', sourceFields: ['summary'] },
    problemDescription: '用户原文待核实。', resolutionSteps: [], conversationOrUpdates: options.readSource ? [summary] : [], errorCodes: [], piiRedactionStatus: 'not_applicable',
  }))
  const ranker: RetrievalRanker = { profileVersion: 'review-fixture', capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
    rank: async (documents, query) => {
      searches.push(query.semanticText ?? query.text)
      const matched = options.derived ? documents : documents.filter(d => JSON.stringify(d).includes('宽带'))
      return { hits: matched.map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1, channels: [{ channel: 'vector', rank: i + 1, score: 1 }] })),
        execution: { requestedMode: query.mode, executedMode: query.mode, strategyVersion: 'fixture', channels: [{ channel: 'vector', implementation: 'fixture', version: '1', resultCount: matched.length, elapsedMs: 0 }] },
        scanned: documents.length, keywordEligible: 0, rankedHits: matched.length, warnings: [] }
    } }
  let agent!: Agent, dispose: (() => Promise<void>) | undefined, derivedSubmitted = 0
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
  new Principal(ctx); new Provider(ctx, new LocalTicketProvider(records, { ranker, defaultMode: 'hybrid' }))
  const app = new RetrievalAgentService(ctx)
  const bridge = new PythonOperatorBridge(process.cwd(), resolve('.cache/semantic-operators', `fixture-${randomUUID()}.sqlite`), undefined, '')
  const ops = new SemanticOperators(ctx, app, undefined, process.cwd(), bridge)
  installAutomaticRetrievalStart(ctx, app, { analyzer: { async analyze() { throw new Error('legacy compiler must not run') } } })
  installRetrievalTools(ctx, app); installRetrievalRuntimeBudget(ctx, app)
  ctx.on('tools/result', (_exec, result) => { if (result.isError) errors.push(JSON.stringify(result.content)) })
  class Adapter extends LlmAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(request)
      const operator = request.sessionId?.startsWith('operator-')
      const data = operator ? JSON.parse(request.messages[0]!.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('')) : {}
      let name = 'submit_result', payload: unknown
      if (operator && request.system?.includes('当前操作：query_plan')) {
        const revised = data.confirmed_context?.includes('改为副卡')
        payload = { keywords: [revised ? '副卡' : '宽带'], instruction: revised ? '只纳入副卡解绑案例' : '只纳入宽带停机案例', retrieval_expressions: [],
          goal: { mode: 'adaptive', count: null }, steps: [{ id: 'review', op: 'sem_filter', inputs: ['$source'], instruction: '复核场景',
            params: options.sourceRequired ? { require_source: true } : {} }] }
      } else if (operator && request.system?.includes('当前操作：sem_topk_compare')) {
        payload = { winner: 'left', citations: [data.left, data.right].map(r => ({ ref: r.ref, passage_id: 'summary', quote: r.passages.find((p: any) => p.id === 'summary').text })) }
      } else if (operator && request.system?.includes('当前操作：sem_agg')) {
        payload = { status: 'ok', text: '这批候选涉及宽带和副卡。', source_ids: data.sources.map((s: any) => s.id) }
      } else if (operator && request.system?.includes('当前操作：sem_extract')) {
        payload = { rows: data.records.map((r: any) => {
          const citation = { ref: r.ref, passage_id: 'summary', quote: r.passages.find((p: any) => p.id === 'summary').text }
          return { ref: r.ref, status: 'ok', data: { summary: citation.quote }, citations: [citation], field_citations: { summary: [citation] } }
        }) }
      } else if (operator) {
        const revised = (app.currentOrUndefined(agent)?.inputGeneration ?? 0) > 0
        payload = { rows: data.records.map((r: any) => ({ ref: r.ref, label: r.passages.find((p: any) => p.id === 'summary').text.includes(revised ? '副卡' : '宽带') ? 'accept' : 'exclude',
          citations: [{ ref: r.ref, passage_id: (r.passages.find((p: any) => options.readSource && p.field === 'conversationOrUpdates') ?? r.passages.find((p: any) => p.id === 'summary')).id,
            quote: (r.passages.find((p: any) => options.readSource && p.field === 'conversationOrUpdates') ?? r.passages.find((p: any) => p.id === 'summary')).text }], knowledge_ids: [], reason: '测试模型依据送达场景判断。' })) }
      } else {
        const s = app.current(agent)
        if (options.readSource && !s.promotedEvidence.length) {
          name = 'ticket_read'; payload = { state_id: s.stateId, candidate_aliases: ['c1'], fields: ['conversationOrUpdates'], reason: '按用户要求核实原始对话。' }
        } else if (options.derived && derivedSubmitted < (options.repeatDerived ?? 1)) {
          derivedSubmitted++; name = options.derived
          payload = { candidate_aliases: s.candidates.map(c => `c${s.candidateHistory.findIndex(h => h.ref === c.ref) + 1}`), instruction: '辅助当前检索复核',
            ...(name === 'sem_topk' ? { k: 1 } : name === 'sem_join' ? { blocking_field: 'summary' } : name === 'sem_extract'
              ? { output_schema: { type: 'object', $defs: { text: { type: 'string' } }, properties: { summary: { $ref: '#/$defs/text' } }, required: ['summary'] } } : {}) }
        } else {
          name = 'ticket_decide'
          payload = { state_id: s.stateId, judgments: [], semantic_gaps: [], action: { kind: 'finish', reason: s.selectedCandidateRefs.length ? 'satisfied' : 'no_result',
            explanation: '受控模型按当前收到的集合结束。', coverage: { checked: ['当前模型已收到的候选'], remaining: [], nextAction: '无', nextActionValue: 'none' } } }
        }
      }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(payload) } }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 80 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['review-fixture'], new Adapter())
  await ctx.plugin(SessionProjection); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'review-fixture', model: 'scripted' } })
  agent = handle.agent; dispose = handle.dispose
  return { app, agent, ops, searches, errors, requests, async input(text: string) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })); await agent.whenIdle()
  }, async close() { await dispose?.(); await ctx.fiber.dispose() } }
}

it('O1 executes new plan keywords after the user changes the business scope', async () => {
  const f = await fixture()
  try {
    await f.input('查找宽带停机案例')
    expect(f.errors).toEqual([])
    await f.input('改为副卡解绑案例，宽带不要了')
    const s = f.app.current(f.agent)
    console.log('O1', JSON.stringify({ keywords: s.query.contract?.semanticPlan?.keywords, candidates: s.candidates.map(c => c.displayId), outcome: s.termination, errors: f.errors }))
    expect(s.query.contract?.semanticPlan?.keywords).toEqual(['副卡'])
    expect(s.candidates.map(c => c.displayId)).toContain('R-1')
    expect(createTicketResultCollection(s).tickets.map(c => c.displayId)).toEqual(['R-1'])
    expect(foldRetrievalEvents(readRetrievalSessionEvents(f.agent.session))?.selectedCandidateRefs).toEqual(s.selectedCandidateRefs)
  } finally { await f.close() }
}, 60000)

it('O4 fetches required dialogue before the first filter request and replays the confirmation', async () => {
  const f = await fixture({ sourceRequired: true, readSource: true })
  try {
    await f.input('查找宽带停机案例，必须核实原始对话')
    const s = f.app.current(f.agent)
    expect(f.errors).toEqual([])
    expect(s.termination).toBe('top_k_accepted')
    expect(s.selectedCandidateRefs).toHaveLength(1)
    expect(f.requests.filter(r => r.system?.includes('当前操作：sem_filter'))).toHaveLength(1)
    expect(s.contextManifests?.some(m => m.operator?.operation === 'sem_filter' && m.evidenceIds.length)).toBe(true)
    expect(createTicketResultCollection(s).evidence.some(e => e.field === 'conversationOrUpdates')).toBe(true)
  } finally { await f.close() }
}, 60000)

it('O2 retains the actual comparison manifests on public sem_topk artifacts', async () => {
  const f = await fixture({ derived: 'sem_topk' })
  try {
    await f.input('查找宽带停机案例，并排序')
    const s = f.app.current(f.agent), a = s.operatorArtifacts?.find(a => a.operation === 'sem_topk')
    console.log('O2', JSON.stringify({ errors: f.errors, artifacts: s.operatorArtifacts?.map(a => ({ operation: a.operation, manifestIds: a.manifestIds })), operations: s.contextManifests?.map(m => m.operator?.operation) }))
    expect(f.errors).toEqual([]); expect(a).toBeDefined()
    expect(a!.manifestIds.length).toBeGreaterThan(0)
  } finally { await f.close() }
}, 60000)

it('reuses valid extraction through the public tool with the original batch receipt', async () => {
  const f = await fixture({ derived: 'sem_extract', repeatDerived: 2 })
  try {
    await f.input('提取这批工单的摘要')
    expect(f.errors).toEqual([])
    const s = f.app.current(f.agent), artifact = s.operatorArtifacts!.find(a => a.operation === 'sem_extract')!
    expect(artifact.manifestIds).toHaveLength(1)
    expect(f.requests.filter(r => r.system?.includes('当前操作：sem_extract'))).toHaveLength(1)
    expect(() => validateOperatorArtifact(s, artifact)).not.toThrow()
  } finally { await f.close() }
}, 60000)

it('finishes an empty indexed join without claiming complete pair recall or a model call', async () => {
  const f = await fixture({ derived: 'sem_join' })
  try {
    await f.input('查找摘要相同的工单关系')
    expect(f.errors).toEqual([])
    const artifact = f.app.current(f.agent).operatorArtifacts!.find(a => a.operation === 'sem_join')!
    expect(artifact.manifestIds).toHaveLength(0)
    expect(artifact.events).toEqual([{ type: 'join_summary', candidate_pairs: 0, strategy: 'indexed_blocking', blocking_recall: 'not_established' }])
  } finally { await f.close() }
}, 60000)

it('O3 retains candidate/source identity in actual sem_agg manifests', async () => {
  const f = await fixture({ derived: 'sem_agg' })
  try {
    await f.input('查找宽带停机案例，归纳这批来源')
    const s = f.app.current(f.agent), m = s.contextManifests?.find(m => m.operator?.operation === 'sem_agg')
    console.log('O3', JSON.stringify({ errors: f.errors, candidateRefs: m?.candidateRefs, evidenceIds: m?.evidenceIds, records: m?.operator?.records, artifacts: s.operatorArtifacts?.map(a => a.operation) }))
    expect(f.errors).toEqual([]); expect(m).toBeDefined()
    expect(m!.operator!.records.length).toBeGreaterThan(0)
  } finally { await f.close() }
}, 60000)

it('O3 validates multi-level aggregation, cached receipts and rejects unsupplied artifact quotes', async () => {
  const f = await fixture({ derived: 'sem_agg', recordCount: 10, repeatDerived: 2 })
  try {
    await f.input('归纳这些工单的来源')
    expect(f.errors).toEqual([])
    const s = f.app.current(f.agent), artifact = s.operatorArtifacts!.find(a => a.operation === 'sem_agg')!
    expect(artifact.manifestIds.length).toBeGreaterThan(1)
    expect(f.requests.filter(r => r.system?.includes('当前操作：sem_agg'))).toHaveLength(artifact.manifestIds.length)
    expect(() => validateOperatorArtifact(s, artifact)).not.toThrow()
    const corrupted = JSON.parse(JSON.stringify(artifact))
    corrupted.events[0].value.citations[0].quote = '没有送达模型的伪造内容'
    expect(() => validateOperatorArtifact(s, corrupted)).toThrow('未送达')
    expect(foldRetrievalEvents(readRetrievalSessionEvents(f.agent.session))?.operatorArtifacts).toEqual(s.operatorArtifacts)
  } finally { await f.close() }
}, 60000)

it('O4 require_source cannot be fulfilled by an unread source-authored summary', async () => {
  const f = await fixture({ sourceRequired: true })
  try {
    await f.input('查找宽带停机案例，必须核实原始对话')
    const s = f.app.current(f.agent)
    console.log('O4', JSON.stringify({ confirmed: s.selectedCandidateRefs.length, evidence: s.promotedEvidence.length, phase: s.phase, errors: f.errors }))
    expect(s.promotedEvidence).toHaveLength(0)
    expect(s.selectedCandidateRefs).toHaveLength(0)
    expect(f.requests.filter(r => r.system?.includes('当前操作：sem_filter'))).toHaveLength(0)
  } finally { await f.close() }
}, 60000)

it('B05 legacy finished tasks keep elapsed time after a display-only state update', async () => {
  const f = await fixture()
  try {
    await f.input('查找宽带停机案例')
    const { executionClock: _clock, ...original } = f.app.current(f.agent)
    const legacy = { ...original, createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:01:07Z' }
    // The old checkpoint has no end time. Recovery must consume its persisted stop event before projection.
    const stoppedAt = '2026-09-08T00:01:07Z'
    const s = recoverExecutionClock(legacy, stoppedAt)
    const initial = projectOrchestration(s).clock.elapsedMs
    expect(initial).toBe(67000)
    expect(projectOrchestration(recoverExecutionClock({ ...legacy, updatedAt: '2026-09-15T00:00:00Z' }, stoppedAt)).clock.elapsedMs).toBe(initial)
  } finally { await f.close() }
}, 60000)

it('O6 operator review is discoverable by the feedback receipt consumer', async () => {
  const f = await fixture()
  try {
    await f.input('查找宽带停机案例')
    const first = readRetrievalSessionEvents(f.agent.session).length
    await f.input('请复核宽带工单是否相关')
    const s = f.app.current(f.agent), events = readRetrievalSessionEvents(f.agent.session).slice(first)
    const decisions = events.filter(e => e.type === 'retrieval/decision-submitted').flatMap(e => e.data.decision.judgments)
    console.log('O6', JSON.stringify({ actualJudgments: s.judgments?.length, feedbackConsumerJudgments: decisions.length }))
    expect(s.judgments?.length).toBeGreaterThan(0)
    expect(decisions.some(j => j.candidateRef === s.candidates[0]!.ref)).toBe(true)
  } finally { await f.close() }
}, 60000)
