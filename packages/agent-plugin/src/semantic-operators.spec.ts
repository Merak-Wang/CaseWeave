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
import { expect, it, vi } from 'vitest'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { buildSemanticTicketRequest } from '@retrieval-agent/query-understanding'
import { admitOperatorDecisions, foldRetrievalEvents, validateOperatorRecords } from '@retrieval-agent/domain'
import { admitDecision } from '../../domain/src/decision.js'
import { candidateEvidence, createRetrievalReport, CandidateExportService, InMemoryExportAuditSink } from '@retrieval-agent/product-api'
import { readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import type { RetrievalRanker } from '@retrieval-agent/model-service-client/ranking'
import type { OperatorRecord, TicketCandidateRef, TicketRetrievalProvider } from '@retrieval-agent/contracts'
import { RetrievalError } from '@retrieval-agent/contracts'
import { TicketPrincipalProviderService, TicketRetrievalProviderService } from './provider-services.js'
import { RetrievalAgentService } from './service.js'
import { SemanticOperators } from './semantic-operators.js'
import { PythonOperatorBridge } from './python-operator-bridge.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { installRetrievalTools } from './tools.js'
import { installRetrievalRuntimeBudget } from './context-budget.js'

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
  override readFeatures: NonNullable<TicketRetrievalProvider['readFeatures']> = (...a) => this.port.readFeatures?.(...a) ?? Promise.resolve([])
  status: TicketRetrievalProvider['status'] = (...a) => this.port.status(...a)
}

it('retains failed callback metering and the original error instead of treating missing usage as zero', async () => {
  const bridge = new PythonOperatorBridge(process.cwd(), resolve('.cache/semantic-operators', `failure-${randomUUID()}.sqlite`))
  try {
    await expect(bridge.run({ scope: { task_id: randomUUID(), input_revision: 0, snapshot: 'test', authorization: 'test' },
      model_identity: 'failure-fixture', knowledge: { release: 'none', entries: [] }, op: 'query_plan', instruction: '副卡' },
    async () => { throw new RetrievalError('PROTOCOL_MISMATCH', '模拟结构化响应失败') }, async () => { throw new Error('No results expected') }))
      .rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH', cause: { operatorUsage: { llm_adapter_calls: 1, failed_attempts: 1,
        usage_missing_attempts: 1, accounting_complete: false } } })
  } finally { bridge.close() }
}, 30000)

it.each([2, 24, 1536])('runs public DSH input through Python filtering for %i rows with incremental commits and replay', async (count) => {
  const ctx = new Context(), searches: string[] = [], requests: GenerateOptions[] = []
  const ranker: RetrievalRanker = { profileVersion: 'operator-fixture', capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
    readFeatures: async documents => ({ embedding_id: 'synthetic-operator-fixture', rows: documents.map(d => ({ id: d.id,
      vector: Number(d.id.slice(1)) % 2 ? [0, 1] : [1, 0] })) }),
    rank: async (documents, query) => {
      searches.push(query.semanticText ?? query.text)
      return { hits: documents.map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1, channels: [{ channel: 'vector', rank: i + 1, score: 1 }] })),
        execution: { requestedMode: query.mode, executedMode: query.mode, strategyVersion: 'fixture', channels: [{ channel: 'vector', implementation: 'fixture', version: '1', resultCount: documents.length, elapsedMs: 0 }] },
        scanned: documents.length, keywordEligible: 0, rankedHits: documents.length, warnings: [] }
    } }
  const records = Array.from({ length: count }, (_, i) => i % 2 ? '解绑已经完成，后续仅咨询账单。' : '解绑仍受阻，尚未完成。').map((summary, i) => normalizeFixtureTicket({
    ticketId: `r${i}`, displayId: `R-${i}`, tenantId: 'operators', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'v1', title: '副卡解绑', summary,
    problemDescription: summary, resolutionSteps: [], conversationOrUpdates: [], errorCodes: [], piiRedactionStatus: 'not_applicable',
  }))
  let agent: Agent | undefined, dispose: (() => Promise<void>) | undefined
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
    new Principal(ctx); new Provider(ctx, new LocalTicketProvider(records, { ranker, defaultMode: 'hybrid' }))
    const app = new RetrievalAgentService(ctx)
    const updates = vi.spyOn(app, 'updateExpert')
    const commits = vi.spyOn(app, 'acceptOperatorResults')
    const bridge = new PythonOperatorBridge(process.cwd(), resolve('.cache/semantic-operators', `test-${randomUUID()}.sqlite`))
    // Keep a real checked-cluster integration case alongside the strict default.
    // The fixture supplies its numeric features through the same Provider port.
    if (count === 1536) {
      const run = bridge.run.bind(bridge)
      bridge.run = (input, callback, result, signal) => run(input.op === 'sem_filter'
        ? { ...input, params: { ...input.params, algorithm: 'cluster' } } : input, async (method, payload) => {
        const reply = await callback(method, payload)
        if (input.op !== 'sem_filter' || method !== 'rows.read') return reply
        const page = reply as { rows: OperatorRecord[]; next_cursor: string | null }
        const features = await ctx.ticketRetrievalProvider.readFeatures(await app.principal(agent!, 'detail_read'),
          { snapshotId: app.current(agent!).snapshot!.snapshotId, candidateRefs: page.rows.map(r => r.ref as TicketCandidateRef) })
        return { ...page, rows: page.rows.map(row => ({ ...row, ...features.find(f => f.ref === row.ref) })) }
      }, result, signal)
    }
    new SemanticOperators(ctx, app, undefined, process.cwd(), bridge)
    installAutomaticRetrievalStart(ctx, app, { analyzer: { async analyze() { throw new Error('legacy compiler must not run') } } })
    installRetrievalTools(ctx, app); installRetrievalRuntimeBudget(ctx, app)
    const errors: string[] = []
    const accept = app.acceptOperatorResults.bind(app)
    app.acceptOperatorResults = async (...args) => {
      try { return await accept(...args) } catch (error) { errors.push(String(error)); throw error }
    }
    ctx.on('tools/result', (_exec, result) => { if (result.isError) errors.push(JSON.stringify(result.content)) })
    class Adapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        const data = options.sessionId?.startsWith('operator-') ? JSON.parse(options.messages[0]!.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('') || '{}') : {}
        let name = 'submit_result', payload: unknown
        if (options.sessionId?.startsWith('operator-')) {
          if (options.system?.includes('当前操作：query_plan')) {
            expect(searches.length).toBeGreaterThan(0)
            payload = { keywords: ['副卡', '解绑'], instruction: '查找仍受阻的副卡解绑，排除已完成解绑。', retrieval_expressions: [], goal: { mode: 'adaptive', count: null },
              steps: [{ id: 'review', op: 'sem_filter', inputs: ['$source'], instruction: '核对完成状态', params: {} }] }
          } else {
            payload = { rows: data.records.map((r: any) => ({ ref: r.ref, label: r.passages.find((p: any) => p.id === 'summary').text.includes('尚未完成') ? 'accept' : 'exclude',
              citations: [{ ref: r.ref, passage_id: 'summary', quote: r.passages.find((p: any) => p.id === 'summary').text }], knowledge_ids: [], reason: '依据会话结束时的解绑状态。' })) }
          }
        } else {
          name = 'ticket_decide'
          const state = app.current(agent!)
          expect(state.selectedCandidateRefs).toHaveLength(count / 2)
          payload = { state_id: state.stateId, judgments: [], semantic_gaps: [], action: { kind: 'finish', reason: 'satisfied',
            explanation: '当前案例覆盖所需的解绑受阻边界。', coverage: { checked: ['结束时的状态'], remaining: [], nextAction: '无需继续', nextActionValue: 'none' } } }
        }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(payload) } }
        yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 80 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['operator-fixture'], new Adapter())
    await ctx.plugin(SessionProjection); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'operator-fixture', model: 'scripted' } })
    agent = handle.agent; dispose = handle.dispose
    const query = count === 2 ? '查找副卡解绑仍受阻的案例，\n  排除已经解绑。' : '查找副卡解绑仍受阻的案例，排除已经解绑。'
    agent.followup(createUserMessage({ content: [{ type: 'text', text: query }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(errors).toEqual([])
    const state = app.current(agent)
    expect(state.query.original).toBe(query)
    expect(searches).toContain(query)
    expect(state.phase, JSON.stringify({ candidates: state.candidates.length, judgments: state.judgments?.length,
      selected: state.selectedCandidateRefs.length, activity: state.operatorActivity, stop: state.stopExplanation,
      filterRequests: requests.filter(r => r.system?.includes('当前操作：sem_filter')).length })).toBe('stopped')
    expect(state.candidates.filter(c => state.selectedCandidateRefs.includes(c.ref)).map(c => c.displayId).sort()).toEqual(
      records.filter((_, i) => i % 2 === 0).map(r => r.displayId).sort())
    expect(state.query.spec.queryPlan).toBeUndefined()
    expect(state.query.contract?.semanticPlan?.goal.mode).toBe('adaptive')
    const filtering = state.contextManifests!.filter(m => m.operator?.operation === 'sem_filter')
    if (count !== 1536) {
      expect(filtering).toHaveLength(Math.ceil(count / 8))
      expect(commits.mock.calls).toHaveLength(Math.ceil(count / 8))
      expect(state.judgments!.every(j => j.basis === 'model')).toBe(true)
    }
    const registrations = updates.mock.calls.filter(([, , update]) => update.kind === 'manifest' && update.manifest.operator?.operation === 'sem_filter')
    expect(registrations).toHaveLength(filtering.length)
    if (count === 1536) {
      const proxies = state.judgments!.filter(j => j.basis === 'proxy')
      const seenByModel = new Set(filtering.flatMap(m => m.candidateRefs))
      expect(proxies.length).toBeGreaterThan(0)
      expect(proxies.every(j => !seenByModel.has(j.candidateRef) && !j.operatorManifestId)).toBe(true)
      expect(new Set([...seenByModel, ...proxies.map(j => j.candidateRef)]).size).toBe(count)
      expect(foldRetrievalEvents(readRetrievalSessionEvents(agent.session))?.judgments?.filter(j => j.basis === 'proxy')).toEqual(proxies)
      const acceptedProxy = proxies.find(j => j.verdict === 'accept')!
      const evidence = candidateEvidence(state, acceptedProxy.candidateRef)
      expect(evidence.judgment?.basis).toBe('proxy')
      expect(evidence.citationCount).toBeGreaterThan(0)
      const report = createRetrievalReport(state, [])
      expect(report.confirmedCount).toBe(count / 2)
      const principal = await app.principal(agent, 'export')
      const exporter = new CandidateExportService(ctx.ticketRetrievalProvider, new InMemoryExportAuditSink())
      const csv = await exporter.exportCsv(principal, state)
      expect(csv.content).toContain('judgment_basis')
      expect(csv.content).toContain('proxy')
      const jsonl: string[] = []
      await exporter.stream(principal, state, { format: 'jsonl', template: 'summary' }, async text => { jsonl.push(text) })
      expect(jsonl.join('').split('\n').filter(Boolean).map(s => JSON.parse(s)).some(r => r.judgment?.basis === 'proxy')).toBe(true)
      const oldStrong = state.judgments!.find(j => j.operatorManifestId)!
      const oldManifest = state.contextManifests!.find(m => m.id === oldStrong.operatorManifestId)!
      const changed = admitDecision({ ...state, phase: 'assessed' }, { stateId: state.stateId, judgments: [{ ...oldStrong,
        verdict: oldStrong.verdict === 'accept' ? 'exclude' : 'accept' }], gaps: [], action: { kind: 'inspect', fields: [] } }, oldManifest.roleId)
      expect(changed.judgments!.some(j => j.basis === 'proxy')).toBe(false)
      expect(changed.judgments!.find(j => j.candidateRef === oldStrong.candidateRef)!.verdict).not.toBe(oldStrong.verdict)
    }
    expect(foldRetrievalEvents(readRetrievalSessionEvents(agent.session))?.selectedCandidateRefs).toEqual(state.selectedCandidateRefs)
    expect(requests.filter(r => !r.sessionId?.startsWith('operator-'))).toHaveLength(1)
    const manifest = state.contextManifests!.find(m => m.operator?.operation === 'sem_filter')!
    const row = manifest.operator!.records[0]!
    expect(() => validateOperatorRecords(state, [{ ...row, content_hash: 'changed' }])).toThrow('来源版本')
    expect(() => validateOperatorRecords(state, [{ ...row, passages: row.passages.map(p => ({ ...p, text: p.text + '伪造' })) }])).toThrow('授权证据')
    expect(() => admitOperatorDecisions(state, (state.inputGeneration ?? 0) + 1, [])).toThrow('旧输入代次')
    expect(() => admitOperatorDecisions({ ...state, phase: 'assessed' }, state.inputGeneration ?? 0, [{ ref: row.ref, label: 'accept', citations: [], knowledge_ids: [],
      basis: 'proxy', reason: '未经校准的代理', manifest_id: manifest.operator!.pythonManifestId }])).toThrow('代理推断')
    expect(buildSemanticTicketRequest('副卡 AND 跨域').filters).toBeUndefined()
  } finally { await dispose?.(); await ctx.fiber.dispose() }
}, 180000)
