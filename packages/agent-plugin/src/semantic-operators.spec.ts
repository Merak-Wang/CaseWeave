import { confirmedCount, learnedResult } from '@retrieval-agent/domain/result'
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
import { admitDecision, finishReason } from '../../domain/src/decision.js'
import { candidateEvidence, createRetrievalReport, CandidateExportService, InMemoryExportAuditSink, learnedResultWindow, materializeLearnedRefs } from '@retrieval-agent/product-api'
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
import { installRetrievalRuntimeBudget } from './metrics/budget.js'

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
  override featureBlock: NonNullable<TicketRetrievalProvider['featureBlock']> = (...a) => this.port.featureBlock!(...a)
  override resolveFeatureIds: NonNullable<TicketRetrievalProvider['resolveFeatureIds']> = (...a) => this.port.resolveFeatureIds!(...a)
  override scanFeatures: NonNullable<TicketRetrievalProvider['scanFeatures']> = (...a) => this.port.scanFeatures!(...a)
  override readCandidates: NonNullable<TicketRetrievalProvider['readCandidates']> = (...a) => this.port.readCandidates!(...a)
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

it.each([true, false])('routes knowledge in planning (selected=%s), then judges one review window with only selected bodies', async (selectKnowledge) => {
  const ctx = new Context(), judged: string[][] = [], unresolvedIssues: (string | undefined)[][] = []
  let selectedId = '', selectedBody = ''
  let dispose: (() => Promise<void>) | undefined
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
    const records = Array.from({ length: 40 }, (_, i) => normalizeFixtureTicket({ ticketId: `example-${i}`, displayId: `E-${i}`,
      tenantId: 'operators', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'v1', title: '副卡问题', summary: '缺少解绑状态',
      problemDescription: '尚待核实解绑状态', resolutionSteps: [], conversationOrUpdates: [], errorCodes: [], piiRedactionStatus: 'not_applicable' }))
    const ranker: RetrievalRanker = { profileVersion: 'example-window', capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
      rank: async (documents, query) => ({ hits: documents.map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1, channels: [{ channel: 'vector' as const, rank: i + 1, score: 1 }] })),
        execution: { requestedMode: query.mode, executedMode: query.mode, strategyVersion: 'fixture', channels: [] },
        scanned: documents.length, keywordEligible: documents.length, rankedHits: documents.length, warnings: [] }) }
    new Principal(ctx); new Provider(ctx, new LocalTicketProvider(records, { ranker }))
    const app = new RetrievalAgentService(ctx, { searchTopK: 40, reviewBatchSize: 8 })
    const operators = new SemanticOperators(ctx, app, resolve('wiki'), process.cwd(),
      new PythonOperatorBridge(process.cwd(), resolve('.cache/semantic-operators', `window-${randomUUID()}.sqlite`)))
    class WindowAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const data = JSON.parse(options.messages[0]!.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(''))
        const planning = options.system?.includes('当前操作：query_plan')
        const knowledge = JSON.parse(options.system!.split('\n相关Wiki：')[1]!)
        if (planning) {
          const evidenceFields = JSON.parse(data.confirmed_context).evidence_fields
          expect(evidenceFields.some((field: any) => field.key === 'summary')).toBe(false)
          expect(evidenceFields.every((field: any) => ['L2', 'L3'].includes(field.accessLevel)
            && (!field.capability || field.capability.origin === 'source'))).toBe(true)
          const catalog = JSON.parse(data.confirmed_context).knowledge_catalog
          expect(catalog.length).toBeGreaterThan(0)
          expect(knowledge.entries).toEqual([])
          const entry = catalog.flatMap((d: any) => d.entries).at(-1)
          expect(entry.bodyMarkdown).toBeUndefined()
          selectedId = entry.id
        } else {
          expect(knowledge.entries.map((e: any) => e.id)).toEqual(selectKnowledge ? [selectedId] : [])
          if (selectKnowledge) {
            expect(knowledge.entries[0].bodyMarkdown.length).toBeGreaterThan(0)
            selectedBody = knowledge.entries[0].bodyMarkdown
          }
        }
        if (!planning) {
          judged.push(data.records.map((r: any) => r.ref))
          unresolvedIssues.push(data.records.map((r: any) => r.attributes.unresolved_issue))
        }
        const payload = planning ? { keywords: ['副卡'], instruction: '找3条解绑已完成的副卡工单', retrieval_expressions: [],
          knowledge_routes: selectKnowledge ? [{ entry_id: selectedId, reason: '测试 Agent 选择这条业务知识' }] : [],
          goal: { mode: 'examples', count: 3 }, steps: [{ id: 'filter', op: 'sem_filter', inputs: ['$source'], instruction: '核实解绑状态', params: {} }] }
          : { rows: data.records.map((r: any) => ({ ref: r.ref, label: 'undetermined', citations: [], knowledge_ids: [], reason: '缺少解绑完成事实。' })) }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'submit_result', arguments: JSON.stringify(payload) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['example-window'], new WindowAdapter())
    await ctx.plugin(SessionProjection); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'example-window', model: 'scripted' } })
    dispose = handle.dispose
    const agent = handle.agent
    await app.start(agent, buildSemanticTicketRequest('找3条解绑已完成的副卡工单'))
    await operators.filter(agent)
    expect(app.current(agent).query.contract?.semanticPlan?.knowledge_routes).toEqual(selectKnowledge
      ? [{ entry_id: selectedId, reason: '测试 Agent 选择这条业务知识', title: expect.any(String) }] : [])
    if (selectKnowledge) expect(selectedBody).not.toBe('')
    expect(app.current(agent).judgments).toHaveLength(8)
    expect(app.current(agent).phase).not.toBe('stopped')
    await operators.filter(agent)
    expect(app.current(agent).judgments).toHaveLength(16)
    expect(judged).toHaveLength(2)
    const ref = app.current(agent).judgments![0]!.candidateRef
    await operators.filter(agent, [ref])
    expect(judged).toHaveLength(3)
    expect(unresolvedIssues.at(-1)).toEqual(['缺少解绑完成事实。'])
    expect(app.current(agent).judgments).toHaveLength(16)
    expect(app.current(agent).selectedCandidateRefs).toEqual([])
  } finally { await dispose?.(); await ctx.fiber.dispose() }
}, 60000)

it.each([[2, false], [24, false], [1536, false], [2048, false], [2048, true], [2048, 'unknown']] as const)('runs public DSH input through Python filtering for %i rows (fallback=%s) with commits and replay', async (count, fallback) => {
  const active = count === 2048
  const ctx = new Context(), searches: string[] = [], requests: GenerateOptions[] = []
  const ranker: RetrievalRanker = { profileVersion: 'operator-fixture', capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
    readFeatures: async documents => ({ embedding_id: 'synthetic-operator-fixture', rows: documents.map(d => ({ id: d.id,
      vector: Number(d.id.slice(1)) % 2 ? [0, 1] : [1, 0] })) }),
    rank: async (documents, query) => {
      searches.push(query.semanticText ?? query.text)
      return { hits: (active ? documents.slice(0, 12) : documents).map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1, channels: [{ channel: 'vector', rank: i + 1, score: 1 }] })),
        execution: { requestedMode: query.mode, executedMode: query.mode, strategyVersion: 'fixture', channels: [{ channel: 'vector', implementation: 'fixture', version: '1', resultCount: documents.length, elapsedMs: 0 }] },
        scanned: documents.length, keywordEligible: 0, rankedHits: active ? 12 : documents.length, warnings: [] }
    } }
  const records = Array.from({ length: count }, (_, i) => i % 2 ? '解绑已经完成，后续仅咨询账单。' : '解绑仍受阻，尚未完成。').map((summary, i) => normalizeFixtureTicket({
    ticketId: `r${i}`, displayId: `R-${i}`, tenantId: 'operators', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'v1', title: '副卡解绑', summary,
    problemDescription: summary, resolutionSteps: [], conversationOrUpdates: [summary], errorCodes: [], piiRedactionStatus: 'not_applicable',
  }))
  let agent: Agent | undefined, dispose: (() => Promise<void>) | undefined
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
    new Principal(ctx); new Provider(ctx, new LocalTicketProvider(records, { ranker, defaultMode: 'hybrid' }))
    const featureBlock = ctx.ticketRetrievalProvider.featureBlock!.bind(ctx.ticketRetrievalProvider)
    const numericReads = vi.spyOn(ctx.ticketRetrievalProvider, 'featureBlock').mockImplementation(async (...args) => {
      const block = await featureBlock(...args)
      return { ...block, scores: block.ids.map(id => id / count) }
    })
    const app = new RetrievalAgentService(ctx)
    const updates = vi.spyOn(app, 'updateExpert')
    const commits = vi.spyOn(app, 'acceptOperatorResults')
    const bridge = new PythonOperatorBridge(process.cwd(), resolve('.cache/semantic-operators', `test-${randomUUID()}.sqlite`))
    let pausedStages = 0, selectionResumes = 0
    if (active) {
      const run = bridge.run.bind(bridge)
      bridge.run = async (input, callback, result, signal) => {
        // 模拟发现与选择缺类回执，验证公开入口都能直接继续有剩余样本的窗口。
        if (input.op === 'sem_filter' && pausedStages < 2) {
          await callback('learning.update', { input_revision: input.scope.input_revision,
            stop_reason: pausedStages++ === 0 ? 'needs_coverage' : 'needs_selection_coverage',
            discovery_remaining_records: 256, selection_remaining_records: 256 })
          return {}
        }
        let predicting = false
        return run(input, async (method, payload) => {
          if (method === 'predictions.begin') predicting = true
          if (predicting) expect(['rows.read', 'llm.generate']).not.toContain(method)
          // Python 的真实 60% 边界另有数值用例；此处验证备用模型声明贯穿宿主交付与重放。
          if (fallback && ['predictions.finish', 'learning.update'].includes(method)) {
            const p = payload as Record<string, any>
            if (p.quality) payload = { ...p, quality: { ...p.quality, precision: fallback === 'unknown' ? .59 : .6, recall: .8,
              acceptance: fallback === 'unknown' ? 'unknown' : 'fallback' },
              ...(fallback === 'unknown' ? { passed: false, message: '不知道：最佳模型选择集查准率低于 60%，仅返回已确认工单。' } : {}),
              ...(p.stop_reason === 'quality_passed' ? { stop_reason: fallback === 'unknown' ? 'model_unknown' : 'quality_fallback' } : {}) }
          }
          return callback(method, payload)
        }, result, signal)
      }
    }
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
    new SemanticOperators(ctx, app, undefined, process.cwd(), bridge, active ? { batchSize: 4, options: { concurrency: 32 } } : { algorithm: 'baseline' })
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
        const revised = active && (app.currentOrUndefined(agent!)?.inputGeneration ?? 0) > 0
        let name = 'submit_result', payload: unknown
        if (options.sessionId?.startsWith('operator-')) {
          if (options.system?.includes('当前操作：query_plan')) {
            expect(searches.length).toBeGreaterThan(0)
            payload = { keywords: active ? [] : ['副卡', '解绑'], instruction: revised ? '只纳入已经完成解绑，排除尚未完成。' : '查找仍受阻的副卡解绑，排除已完成解绑。', retrieval_expressions: [], goal: { mode: active ? 'all' : 'adaptive', count: null },
              steps: [{ id: 'review', op: 'sem_filter', inputs: ['$source'], instruction: '核对完成状态', params: active ? { required_fields: ['conversationOrUpdates'] } : {} }] }
          } else if (options.system?.includes('当前操作：sem_agg')) {
            payload = { status: 'ok', text: '受控的典型案例说明', source_ids: data.sources.map((s: any) => s.id) }
          } else {
            payload = { rows: data.records.map((r: any) => ({ ref: r.ref, label: r.passages.find((p: any) => active ? p.field === 'conversationOrUpdates' : p.id === 'summary').text.includes(revised ? '已经完成' : '尚未完成') ? 'accept' : 'exclude',
              citations: [{ ref: r.ref, passage_id: r.passages.find((p: any) => active ? p.field === 'conversationOrUpdates' : p.id === 'summary').id,
                quote: r.passages.find((p: any) => active ? p.field === 'conversationOrUpdates' : p.id === 'summary').text }], knowledge_ids: [], reason: '依据会话结束时的解绑状态。' })) }
          }
        } else {
          name = 'ticket_decide'
          const state = app.current(agent!)
          if (['needs_coverage', 'needs_selection_coverage'].includes((state.budget.operatorUsage?.learning as { stop_reason?: string } | undefined)?.stop_reason ?? '')) {
            expect(++selectionResumes).toBeLessThanOrEqual(2)
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'sem_filter', arguments: '{}' } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          expect(confirmedCount(state)).toBe(count / 2)
          payload = { state_id: state.stateId, judgments: [], semantic_gaps: [], action: { kind: 'finish', reason: 'satisfied',
            explanation: '当前案例覆盖所需的解绑受阻边界。', coverage: { checked: ['结束时的状态'], remaining: [], nextAction: '无需继续', nextActionValue: 'none' } } }
          if (active && !state.operatorArtifacts?.some(a => a.inputGeneration === (state.inputGeneration ?? 0))) {
            name = 'sem_agg'
            payload = { candidate_aliases: state.selectedCandidateRefs.slice(0, 8).map(ref => `c${state.candidateHistory.findIndex(c => c.ref === ref)+1}`),
              instruction: '用不同案例说明，窗口不改变全集成员', evidence_window: 3 }
          }
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
    if (fallback === 'unknown') {
      expect(state.termination).toBe('partial')
      expect(state.stopExplanation).toContain('不知道')
      expect(learnedResult(state)).toBeUndefined()
      expect(confirmedCount(state)).toBeGreaterThan(0)
      expect(confirmedCount(state)).toBeLessThan(count / 2)
      expect(state.judgments!.filter(j => j.verdict === 'accept').every(j => j.operatorManifestId && j.basis !== 'proxy')).toBe(true)
      const report = createRetrievalReport(state, [])
      expect(report.learning).toBeUndefined()
      expect(report.confirmedCount).toBe(state.selectedCandidateRefs.length)
      expect(report.conclusion).toContain('不知道')
      const exporter = new CandidateExportService(ctx.ticketRetrievalProvider, new InMemoryExportAuditSink(), { semanticResults: app.semanticResults })
      const rows: string[] = []
      await exporter.stream(await app.principal(agent, 'export'), state, { format: 'jsonl', template: 'summary' }, async row => { rows.push(row) })
      expect(rows.join('').split('\n').filter(Boolean)).toHaveLength(state.selectedCandidateRefs.length)
      const replay = foldRetrievalEvents(readRetrievalSessionEvents(agent.session))!
      expect(replay.selectedCandidateRefs).toEqual(state.selectedCandidateRefs)
      expect(learnedResult(replay)).toBeUndefined()
      const requestsBefore = requests.length
      await app.operators!.filter(agent, state.candidates.slice(0, 1).map(c => c.ref))
      expect(requests).toHaveLength(requestsBefore)
      return
    }
    if (!active) expect(state.candidates.filter(c => state.selectedCandidateRefs.includes(c.ref)).map(c => c.displayId).sort()).toEqual(
      records.filter((_, i) => i % 2 === 0).map(r => r.displayId).sort())
    expect(state.query.spec.queryPlan).toBeUndefined()
    expect(state.query.contract?.semanticPlan?.goal.mode).toBe(active ? 'all' : 'adaptive')
    expect(state.contextManifests!.filter(m => m.operator?.operation === 'query_plan').every(m => !m.operator?.metrics)).toBe(true)
    const filtering = state.contextManifests!.filter(m => m.operator?.operation === 'sem_filter')
    if (count !== 1536 && !active) {
      // 每批初判与独立缺项复核各留一份清单，只提交复核后的判断。
      expect(filtering).toHaveLength(2 * Math.ceil(count / 8))
      expect(commits.mock.calls).toHaveLength(Math.ceil(count / 8))
      expect(state.judgments!.every(j => j.basis === 'model')).toBe(true)
    }
    const registrations = updates.mock.calls.filter(([, , update]) => update.kind === 'manifest' && update.manifest.operator?.operation === 'sem_filter')
    expect(registrations).toHaveLength(filtering.length)
    if (active) {
      const learning = state.budget.operatorUsage?.learning as Record<string, any>
      const rankedReads = numericReads.mock.calls.filter(([, request]) => request.rankingQuery !== undefined)
      expect(rankedReads.length).toBeGreaterThan(1)
      expect(rankedReads.every(([, request]) => request.rankingQuery === query)).toBe(true)
      expect(learning.sampling_method).toBe('ngram_vector_desc')
      expect(learning.feature_records).toBe(count)
      expect(learning.fit_count).toBeGreaterThan(0)
      expect(learning.predicted_records).toBe(count)
      expect(learning.fit_count).toBe(4)
      expect(learning.batch_size).toBe(4)
      expect(learning.concurrency).toBe(32)
      expect(filtering.every(m => m.operator!.records.length <= 4)).toBe(true)
      expect(learning.teacher_unique_records).toBeLessThan(count)
      expect(learning.stop_reason).toBe(fallback ? 'quality_fallback' : 'quality_passed')
      expect(learning.sampling_requests).toBeLessThanOrEqual(128)
      expect(learning.quality.basis).toBe('selection')
      expect(learning.quality.recall).toBeGreaterThanOrEqual(fallback ? .8 : .95)
      expect(learning.quality.precision_lower).toBeUndefined()
      expect(learning.audit_records).toBeUndefined()
      expect(new Set(filtering.flatMap(m => m.candidateRefs)).size).toBe(learning.teacher_unique_records)
      expect(learning.unresolved).toBe(0)
      const summary = (state.operatorArtifacts!.find(a => a.operation === 'sem_agg')!.events[0] as { value: { leaves: number; statistics: { population_count: number } } }).value
      expect(summary.leaves).toBe(3)
      expect(summary.statistics.population_count).toBe(count/2)
      expect(() => finishReason({ ...state, task: { ...state.task, countPolicy: 'adaptive' }, budget: { ...state.budget,
        operatorUsage: { learning: { ...learning, stop_reason: 'quality_not_met', result_set: undefined } } } },
      { kind: 'finish', reason: 'satisfied', explanation: '搜索页末并非质量验收' })).toThrow('未通过集合质量验收')
      const principal = await app.principal(agent, 'detail_read')
      const allRefs: string[] = []; let cursor: string | undefined
      do {
        const page = await learnedResultWindow(state, ctx.ticketRetrievalProvider, principal, app.semanticResults, cursor, 31)
        allRefs.push(...page.items.map(c => c.displayId)); cursor = page.nextCursor
      } while (cursor)
      expect(allRefs.sort()).toEqual(records.filter((_, i) => i % 2 === 0).map(r => r.displayId).sort())
      const page = await learnedResultWindow(state, ctx.ticketRetrievalProvider, principal, app.semanticResults, undefined, 200)
      const proxy = page.judgments.find(j => j.basis === 'proxy')!
      const resolved = await materializeLearnedRefs(state, ctx.ticketRetrievalProvider, principal, app.semanticResults, [proxy.candidateRef as TicketCandidateRef])
      expect(candidateEvidence(resolved, proxy.candidateRef).citations).toEqual([])
      const hydrated = await app.hydrateResultCandidates(agent, [proxy.candidateRef as TicketCandidateRef])
      expect(hydrated.candidates.some(c => c.ref === proxy.candidateRef)).toBe(true)
      expect(confirmedCount(hydrated)).toBe(count/2)
      expect(learnedResult({ ...state, inputGeneration: (state.inputGeneration ?? 0) + 1 })).toBeUndefined()
      const learnedReport = createRetrievalReport(state, [])
      expect(learnedReport.confirmedCount).toBe(count / 2)
      expect(learnedReport.learning?.quality.basis).toBe('selection')
      const exporter = new CandidateExportService(ctx.ticketRetrievalProvider, new InMemoryExportAuditSink(), { semanticResults: app.semanticResults })
      const rows: string[] = []
      await exporter.stream(await app.principal(agent, 'export'), state, { format: 'jsonl', template: 'summary' }, async row => { rows.push(row) })
      expect(rows.join('').split('\n').filter(Boolean)).toHaveLength(count / 2)
      const oldStrong = state.judgments!.find(j => j.operatorManifestId)!
      const oldManifest = state.contextManifests!.find(m => m.id === oldStrong.operatorManifestId)!
      const changed = admitDecision({ ...state, phase: 'assessed' }, { stateId: state.stateId, judgments: [{ ...oldStrong,
        verdict: oldStrong.verdict === 'accept' ? 'exclude' : 'accept' }], gaps: [], action: { kind: 'inspect', fields: [] } }, oldManifest.roleId)
      expect(changed.judgments!.some(j => j.basis === 'proxy')).toBe(false)
      expect((changed.budget!.operatorUsage!.learning as Record<string, unknown>).stop_reason).toBe('strong_label_corrected')
    }
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
      const exporter = new CandidateExportService(ctx.ticketRetrievalProvider, new InMemoryExportAuditSink(), { semanticResults: app.semanticResults })
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
    // 全集分支分别续跑发现和选择两个窗口，随后汇总并结束。
    expect(requests.filter(r => !r.sessionId?.startsWith('operator-'))).toHaveLength(active ? 4 : 1)
    const manifest = state.contextManifests!.find(m => m.operator?.operation === 'sem_filter')!
    const row = manifest.operator!.records[0]!
    expect(() => validateOperatorRecords(state, [{ ...row, content_hash: 'changed' }])).toThrow('来源版本')
    expect(() => validateOperatorRecords(state, [{ ...row, passages: row.passages.map(p => ({ ...p, text: p.text + '伪造' })) }])).toThrow('授权证据')
    expect(() => admitOperatorDecisions(state, (state.inputGeneration ?? 0) + 1, [])).toThrow('旧输入代次')
    expect(() => admitOperatorDecisions({ ...state, phase: 'assessed' }, state.inputGeneration ?? 0, [{ ref: row.ref, label: 'accept', citations: [], knowledge_ids: [],
      basis: 'proxy', reason: '未经校准的代理', manifest_id: manifest.operator!.pythonManifestId }])).toThrow('代理推断')
    expect(buildSemanticTicketRequest('副卡 AND 跨域').filters).toBeUndefined()
    if (active) {
      expect(selectionResumes).toBe(2)
      const previous = learnedResult(state)!
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '改为只找已经完成解绑，排除尚未完成。' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(errors).toEqual([])
      const revised = app.current(agent)
      expect(revised.inputGeneration).toBeGreaterThan(state.inputGeneration ?? 0)
      expect(learnedResult(revised)?.model_id).not.toBe(previous.model_id)
      expect(confirmedCount(revised)).toBe(count/2)
      const page = await learnedResultWindow(revised, ctx.ticketRetrievalProvider, await app.principal(agent, 'detail_read'), app.semanticResults, undefined, 200)
      expect(page.items.every(c => Number(c.displayId.slice(2)) % 2 === 1)).toBe(true)
    }
  } finally { await dispose?.(); await ctx.fiber.dispose() }
}, 180000)
