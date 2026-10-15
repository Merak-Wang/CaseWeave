import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { LlmAdapter, ToolCallId, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ONLINE_MODEL_NAMES, type NumericFeatureRowGroup, type SemanticExecutionOptions, type TicketRetrievalProvider } from '@retrieval-agent/contracts'
import { confirmedCount, learnedResult } from '@retrieval-agent/domain/result'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { buildSemanticTicketRequest } from '@retrieval-agent/query-understanding'
import type { RetrievalRanker } from '@retrieval-agent/model-service-client/ranking'
import { TicketPrincipalProviderService, TicketRetrievalProviderService } from './provider-services.js'
import { RetrievalAgentService } from './service.js'
import { SemanticOperators } from './semantic-operators.js'
import { PythonOperatorBridge } from './python-operator-bridge.js'

// Actual Local -> NDJSON Python -> sklearn fitting. Ranker/intent/teacher transports
// are wholly synthetic doubles: these tests measure authority and plumbing, not
// model quality on business tickets. No production snapshot, service or real LLM.
const poolCount = 512, outsideCount = 16, query = '找出合成状态甲记录', projection = 'business-and-canonical-nfkc-whitespace-v1'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Deterministic LCG + Box-Muller fixture. Seed 8 was selected by a bounded
// synthetic-only search; it is a policy counterexample, not a quality benchmark.
function complementaryVectors(count: number) {
  let state = 8
  const unit = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return (state + .5) / 2 ** 32 }
  const normal = () => Math.sqrt(-2 * Math.log(unit())) * Math.cos(2 * Math.PI * unit())
  return Array.from({ length: count }, (_, i) => {
    const noise = [normal(), normal(), normal()], means = i % 2 ? [1, .3, .4] : [-.2, -.5, .2], scales = i % 2 ? [.5, .8, .8] : [1.4, 2, 1]
    const row = noise.map((v, axis) => means[axis]! + scales[axis]! * v), norm = Math.sqrt(row.reduce((sum, v) => sum + v * v, 0))
    return row.map(v => v / norm)
  })
}
type Row = { ref: string; record_ref?: string; alias: string; attributes: Record<string, unknown>; passages: { alias: string; field: string; origin: string; text: string }[] }
class Principal extends TicketPrincipalProviderService {
  async resolve() { return { tenantId: 'online-synthetic', subjectId: 'reader', entitlementVersion: 'v1',
    purpose: 'ticket_retrieval' as const, attributes: {}, issuedAt: new Date().toISOString() } }
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
  override featureBlock: NonNullable<TicketRetrievalProvider['featureBlock']> = (...a) => this.port.featureBlock!(...a)
  override resolveFeatureIds: NonNullable<TicketRetrievalProvider['resolveFeatureIds']> = (...a) => this.port.resolveFeatureIds!(...a)
  override readCandidates: NonNullable<TicketRetrievalProvider['readCandidates']> = (...a) => this.port.readCandidates!(...a)
}
class TraceBridge extends PythonOperatorBridge {
  readonly operations: Parameters<PythonOperatorBridge['run']>[0][] = []
  readonly callbacks: string[] = []
  readonly groups = new Map<number, NumericFeatureRowGroup>()
  readonly refs = new Map<string, number>()
  readonly predictions = new Map<number, number>()
  readonly updates: Record<string, unknown>[] = []
  readonly begins: Record<string, unknown>[] = []
  readonly finishes: Record<string, unknown>[] = []
  readonly rankedScanIds: number[] = []
  featureSeedRows = 0
  featureScanRows = 0
  sourceRows = 0
  override run(...args: Parameters<PythonOperatorBridge['run']>) {
    const [input, callback, result, signal] = args
    this.operations.push(input)
    return super.run(input, async (method, payload) => {
      this.callbacks.push(input.op + ':' + method)
      const reply = await callback(method, payload)
      if (input.op === 'sem_filter' && ['features.seeds', 'features.scan', 'features.take'].includes(method)) {
        const block = reply as { ids: number[]; row_groups: NumericFeatureRowGroup[]; texts: string[] }
        expect(block.row_groups).toHaveLength(block.ids.length)
        expect(block.texts).toHaveLength(block.ids.length)
        expect(block.texts.every(text => typeof text === 'string' && text.length > 0)).toBe(true)
        block.row_groups.forEach((group, i) => {
          const id = block.ids[i]!
          expect(id).toBeGreaterThanOrEqual(0); expect(id).toBeLessThan(poolCount)
          expect(group.group_projection).toBe(projection)
          expect(group.business_hash).toMatch(/^[0-9a-f]{64}$/)
          expect(group.canonical_hash).toMatch(/^[0-9a-f]{64}$/)
          if (this.groups.has(id)) expect(group).toEqual(this.groups.get(id))
          this.groups.set(id, group)
        })
        if (method === 'features.seeds') this.featureSeedRows += block.ids.length
        if (method === 'features.scan') {
          this.featureScanRows += block.ids.length
          if ((payload as { ranked?: boolean }).ranked) this.rankedScanIds.push(...block.ids)
        }
      }
      if (input.op === 'sem_filter' && method === 'rows.read') {
        const request = payload as { ids: number[] }, records = reply as { rows: Row[] }
        expect(records.rows).toHaveLength(request.ids.length)
        records.rows.forEach((row, i) => {
          const id = request.ids[i]!
          expect(id).toBeLessThan(poolCount)
          expect(row.attributes.group_hashes).toEqual(this.groups.get(id))
          this.refs.set(row.ref, id)
        })
        this.sourceRows += records.rows.length
      }
      if (input.op === 'sem_filter' && method === 'learning.update') this.updates.push(payload as Record<string, unknown>)
      if (input.op === 'sem_filter' && method === 'predictions.begin') this.begins.push(payload as Record<string, unknown>)
      if (input.op === 'sem_filter' && method === 'predictions.finish') this.finishes.push(payload as Record<string, unknown>)
      if (input.op === 'sem_filter' && method === 'predictions.write') {
        const block = payload as { ids: number[]; labels: number[] }
        block.ids.forEach((id, i) => { expect(id).toBeLessThan(poolCount); this.predictions.set(id, block.labels[i]!) })
      }
      return reply
    }, result, signal)
  }
  // Independent test double chooses intentionally wrong holdout labels. Its
  // deterministic role assignment is checked against Python's receipt below.
  finalRole(id: number) {
    const group = this.groups.get(id)!
    const identity = hash([projection, [['business_hash', group.business_hash], ['canonical_hash', group.canonical_hash]]])
    return Number(BigInt('0x' + createHash('sha256').update('0:' + identity).digest('hex').slice(0, 16))) / 2 ** 64 < .3
  }
}
async function fixture(execution: SemanticExecutionOptions, flipFinalTeacher = false, complementary = false, singleClass = false) {
  const ctx = new Context(), root = process.cwd(), calls = { intent: 0, teacher: 0, main: 0, rank: 0 }
  const bridge = new TraceBridge(root, resolve(tmpdir(), 'caseweave-online-' + randomUUID() + '.sqlite'), resolve(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'))
  const teacherLabels = new Map<number, number>(), vectors = complementary ? complementaryVectors(poolCount + outsideCount) : undefined
  let dispose: (() => Promise<void>) | undefined
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter); await ctx.plugin(SessionProjection)
    const ranker: RetrievalRanker = {
      profileVersion: 'online-synthetic-v1', documentProjection: 'canonical-title-abstract-v1',
      capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
      async queryAnchors(texts) {
        // 查询放在独立正交维度，保持本测试的分类器夹具分布；排序另有反RRF验收。
        return { embedding_id: 'synthetic-unit-v1', dimensions: 4, vectors: texts.map(() => [0, 0, 0, 1]),
          profileIdentity: { model: 'synthetic-unit-v1', dimensions: 4 } }
      },
      async rank(documents, request) {
        calls.rank++
        const recalled = documents.filter(d => Number(d.id.slice(1)) < poolCount)
        return { hits: recalled.map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1,
          channels: [{ channel: 'vector', rank: i + 1, score: 1 }] })),
          execution: { requestedMode: request.mode, executedMode: request.mode, strategyVersion: 'synthetic-fixed',
            channels: [{ channel: 'vector', implementation: 'synthetic-fixed', version: '1', resultCount: recalled.length, elapsedMs: 0 }] },
          scanned: documents.length, keywordEligible: 0, rankedHits: recalled.length, warnings: [] }
      },
      async readFeatureBlock(documents) {
        const dense = Buffer.alloc(documents.length * 16)
        documents.forEach((d, i) => { const id = Number(d.id.slice(1)), angle = id % 2 ? 1.35 + (id % 7) * .01 : .15 + (id % 11) * .01
          const vector = [...(vectors?.[id] ?? [Math.cos(angle), Math.sin(angle), 0]), 0]
          vector.forEach((v, axis) => dense.writeFloatLE(v, i * 16 + axis * 4)) })
        return { embedding_id: 'synthetic-unit-v1', dimensions: 4, dense: dense.toString('base64'), available: Buffer.alloc(documents.length, 1).toString('base64') }
      },
    }
    const rows = Array.from({ length: poolCount + outsideCount }, (_, i) => normalizeFixtureTicket({
      ticketId: 'r' + i, displayId: 'S-' + i, tenantId: 'online-synthetic', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'v1',
      title: '合成工单 ' + i, summary: '合成摘要 ' + i, problemDescription: '合成原文事实 ' + i,
      conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable',
      rawSource: { datasetId: 'online-synthetic', datasetVersion: 'v1', schemaVersion: 'v1', recordId: 'physical-' + i,
        payload: { group_id: 'business-' + i, large_model_title: '合成工单 ' + i, large_model_abstract: '合成摘要 ' + i } },
    }))
    new Principal(ctx); new Provider(ctx, new LocalTicketProvider(rows, { ranker, defaultMode: 'dense', documentProjection: 'canonical-title-abstract-v1' }))
    const app = new RetrievalAgentService(ctx, { searchTopK: 3, reviewBatchSize: 8 })
    const operators = new SemanticOperators(ctx, app, undefined, root, bridge, { batchSize: 16, options: {
      block_size: 64, pool_size: 256, sample_size: 128, concurrency: 2,
      // Public execution supplies the exact bank and overrides this fusion default.
      fusion: 'single', fit_budget_seconds: 30,
    } })
    class SyntheticTransport extends LlmAdapter {
      override async resolveModel(provider: string, id: string) { return { provider, id, name: id, reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        let payload: unknown
        if (options.messages.some(message => message.source && 'sections' in message.source && message.source.sections?.some(section => section.name === 'query_plan'))) {
          calls.intent++
          payload = { keywords: [], instruction: query, retrieval_expressions: [], structured_conditions: [] }
        } else if (options.sessionId?.startsWith('operator-') && options.messages.some(message => message.source && 'sections' in message.source && message.source.sections?.some(section => section.name === 'sem_filter'))) {
          calls.teacher++
          const content = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('')
          const input = JSON.parse(content) as { records: Row[]; require_source: boolean; required_fields: string[] }
          expect(input.require_source).toBe(false); expect(input.required_fields).toEqual([])
          expect(input.records.length).toBeGreaterThan(0)
          payload = { rows: input.records.map(row => {
            expect(row.attributes).not.toHaveProperty('group_hashes'); expect(row.attributes).not.toHaveProperty('group_projection')
            expect(row.ref).toMatch(/^@r\d+$/)
            const id = bridge.refs.get(row.record_ref ?? row.ref)!
            expect(id).toBeDefined(); expect(id).toBeLessThan(poolCount)
            const label = singleClass ? 1 : id % 2 ^ Number(flipFinalTeacher && bridge.finalRole(id))
            teacherLabels.set(id, label)
            // Fixed canonical retrieval cites the visible summary; the generic query does not demand a missing raw source field.
            const passage = row.passages.find(p => p.field === 'summary')!
            expect(passage).toBeDefined()
            return { ref: row.alias, label: label ? 'yes' : 'no', confidence: .99 }
          }).reverse() }
        } else { calls.main++; throw new Error('No main or real LLM generation is allowed by this synthetic test') }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'submit_result', arguments: JSON.stringify(payload) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['online-fixture'], new SyntheticTransport())
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'online-fixture', model: 'scripted' } })
    dispose = handle.dispose
    await app.start(handle.agent, buildSemanticTicketRequest(query, execution))
    expect(calls, JSON.stringify(app.current(handle.agent))).toMatchObject({ intent: 1, teacher: 0, main: 0, rank: 0 })
    return { app, operators, agent: handle.agent, bridge, calls, teacherLabels, async close() { bridge.close(); await dispose?.(); await ctx.fiber.dispose() } }
  } catch (error) { bridge.close(); await dispose?.(); await ctx.fiber.dispose(); throw error }
}

it('routes the complete selective model bank through real Python fits, keeps the single baseline, and refits all fixed128 teacher labels', async () => {
  const run = await fixture({ onlineLearning: true, semanticMethod: 'auto', orchestration: 'fixed', onlineFusion: 'selective', onlineModels: ONLINE_MODEL_NAMES }, false)
  try {
    await run.operators.searchAndFilter(run.agent)
    const state = run.app.current(run.agent), learning = state.budget.operatorUsage!.learning as Record<string, unknown>
    expect(run.bridge.operations.map(op => op.op)).toEqual(['query_plan', 'sem_filter'])
    expect(run.bridge.operations[1]!.params).toMatchObject({ algorithm: 'auto', scope_mode: 'full', require_source: false, required_fields: [],
      options: { methods: ONLINE_MODEL_NAMES, fusion: 'selective' } })
    expect(learning).toMatchObject({ algorithm: 'learned', regime: 'online_teacher_feedback', online_feedback_training: true,
      candidate_models: ONLINE_MODEL_NAMES, fusion: 'selective', quality_basis: 'training_group_crossfit',
      corpus_records: poolCount, scope_records: poolCount, predicted_records: poolCount, complete_scope_coverage: true,
      selected_ensemble: false, selection_reason: 'no_oof_diversity_gain', final_holdout_used_for_selection: false })
    const models = learning.models as { name: string }[]
    expect(models.map(model => model.name)).toEqual(ONLINE_MODEL_NAMES)
    expect(Number(learning.fit_count)).toBeGreaterThanOrEqual(ONLINE_MODEL_NAMES.length * 3)
    expect(learning.single_baseline).toMatchObject({ name: (learning.selected_members as string[])[0], f1: 1 })
    expect(learning.quality).toMatchObject({ basis: 'training_group_crossfit', reference_basis: 'teacher', business_accuracy: 'not_measured', precision: 1, recall: 1 })
    expect(learning.final_teacher_agreement).toBeUndefined()
    expect(learning.final_holdout_ids).toEqual([])
    expect(learning.training_records).toBe(128)
    expect(learning.teacher_unique_records).toBe(128)
    expect(learning.exploration_records).toBe(0)
    expect(new Set(learning.training_ids as number[]).size).toBe(128)
    expect(run.bridge.groups.size).toBe(poolCount); expect(run.bridge.featureSeedRows).toBe(0)
    expect(new Set(run.teacherLabels.keys())).toEqual(new Set(learning.training_ids as number[]))
    expect(learning.sampling_method).toBe('ranked_top128')
    expect(run.bridge.sourceRows).toBe(128); expect(run.bridge.featureScanRows).toBe(poolCount * 2)
    expect(run.bridge.predictions.size).toBe(poolCount)
    const learned = learnedResult(state)!
    expect(learned.scope_count).toBe(poolCount); expect(learned.metadata).toMatchObject({ final_holdout_used_for_selection: false, group_projection: projection })
    expect(confirmedCount(state)).toBe([...run.bridge.predictions.values()].filter(label => label === 1).length)
    const page = await run.app.semanticResults.page(state.retrievalId, learned.model_id, -1, poolCount + outsideCount)
    expect(page.ids).toHaveLength(learned.returned)
    expect(page.ids.every(id => id < poolCount && run.bridge.predictions.get(id) === 1)).toBe(true)
    expect(state.candidates.every(candidate => Number(candidate.displayId.slice(2)) < poolCount)).toBe(true)
    expect(run.calls).toMatchObject({ intent: 1, main: 0, rank: 1 })
    expect(run.calls.teacher).toBe(learning.sampling_requests)
    expect(run.bridge.callbacks.filter(name => name === 'sem_filter:features.anchor')).toEqual([])
    expect(run.bridge.begins).toHaveLength(1); expect(run.bridge.finishes).toHaveLength(1)
  } finally { await run.close() }
}, 90000)


it('publishes binary predictions with teacher OOF metrics and no holdout gate', async () => {
  const run = await fixture({ onlineLearning: true, semanticMethod: 'auto', orchestration: 'fixed', onlineFusion: 'selective', onlineModels: ONLINE_MODEL_NAMES }, true)
  try {
    await run.operators.searchAndFilter(run.agent)
    const state = run.app.current(run.agent), learning = state.budget.operatorUsage!.learning as Record<string, unknown>
    expect(learning.stop_reason).toBe('quality_fallback')
    expect(learning.final_teacher_agreement).toBeUndefined()
    expect(learning.teacher_unique_records).toBe(128)
    expect(run.calls.teacher).toBe(Math.ceil(128 / Number(learning.batch_size)))
    expect(run.bridge.predictions.size).toBe(poolCount)
    expect([...run.bridge.predictions.values()].every(label => label === 0 || label === 1)).toBe(true)
    expect(learnedResult(state)?.scope_count).toBe(poolCount)
  } finally { await run.close() }
}, 90000)

it('ends incomplete with teacher confirmations only when all 128 judgments have one class', async () => {
  const run = await fixture({ onlineLearning: true, semanticMethod: 'auto', orchestration: 'fixed' }, false, false, true)
  try {
    await run.operators.searchAndFilter(run.agent)
    const state = run.app.current(run.agent), learning = state.budget.operatorUsage!.learning as Record<string, unknown>
    expect(learning).toMatchObject({ stop_reason: 'model_unknown', teacher_unique_records: 128,
      quality: { basis: 'teacher_single_class', acceptance: 'unknown' } })
    expect(state.phase).toBe('stopped')
    expect(state.termination).toBe('partial')
    expect(confirmedCount(state)).toBe(128)
    expect(learnedResult(state)).toBeUndefined()
    expect(run.bridge.predictions.size).toBe(0)
    expect(run.bridge.begins).toHaveLength(0)
    expect(run.bridge.finishes).toHaveLength(0)
    // 再读同一任务不触发新的教师判断，也不把未判定候选补进确认结果。
    const requests = run.calls.teacher
    await run.operators.searchAndFilter(run.agent)
    expect(run.calls.teacher).toBe(requests)
    expect(confirmedCount(run.app.current(run.agent))).toBe(128)
  } finally { await run.close() }
}, 90000)

it('actually fits both members and retains the measured best single model when two voters provide no majority gain', async () => {
  const methods = ['dense_lr', 'feedback_margin'] as const
  const run = await fixture({ onlineLearning: true, semanticMethod: 'auto', orchestration: 'fixed', onlineFusion: 'selective', onlineModels: methods }, false, true)
  try {
    await run.operators.searchAndFilter(run.agent)
    const state = run.app.current(run.agent), learning = state.budget.operatorUsage!.learning as Record<string, unknown>
    expect(run.bridge.operations[1]!.params).toMatchObject({ scope_mode: 'full', require_source: false, required_fields: [], options: { methods, fusion: 'selective' } })
    expect(learning).toMatchObject({ candidate_models: methods, selected_ensemble: false, selection_reason: 'no_oof_diversity_gain',
      complete_scope_coverage: true, scope_records: poolCount, predicted_records: poolCount, stop_reason: 'quality_fallback' })
    const baseline = learning.single_baseline as { name: string; precision: number; f1: number }
    const quality = learning.quality as { f1: number; precision: number; coverage: number }
    expect(methods).toContain(baseline.name)
    expect(learning.selected_members).toEqual([baseline.name])
    expect(quality).toMatchObject({ basis: 'training_group_crossfit', reference_basis: 'teacher', business_accuracy: 'not_measured' })
    expect(quality.f1).toBe(baseline.f1); expect(quality.precision).toBe(baseline.precision)
    expect(quality.coverage).toBe(1)
    expect((learning.models as { name: string }[]).map(model => model.name)).toEqual(methods)
    expect(Number(learning.fit_count)).toBeGreaterThanOrEqual(methods.length * 3)
    expect(learning.final_teacher_agreement).toBeUndefined()
    const sampled = new Set(run.teacherLabels.keys()), unsampled = [...run.bridge.predictions].filter(([id]) => !sampled.has(id))
    // 成功预测只有二分类；两票无法改进OOF时不强行融合、不以分歧弃权。
    expect(unsampled.every(([, label]) => label === 0 || label === 1)).toBe(true)
    const learned = learnedResult(state)!, positive = await run.app.semanticResults.page(state.retrievalId, learned.model_id, -1, poolCount + outsideCount)
    expect(positive.ids).toHaveLength(learned.returned)
    expect(positive.ids.every(id => id < poolCount && run.bridge.predictions.get(id) === 1)).toBe(true)
    expect(run.bridge.predictions.size).toBe(poolCount)
    expect(state.candidates.every(candidate => Number(candidate.displayId.slice(2)) < poolCount)).toBe(true)
    expect(run.calls).toMatchObject({ intent: 1, main: 0, rank: 1 })
    expect(run.calls.teacher).toBe(learning.sampling_requests)
  } finally { await run.close() }
}, 90000)
