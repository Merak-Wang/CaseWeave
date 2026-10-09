import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { LlmAdapter, ToolCallId, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { RetrievalError, type TicketRetrievalProvider, type SemanticExecutionOptions } from '@retrieval-agent/contracts'
import { confirmedCount, learnedResult } from '@retrieval-agent/domain/result'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { buildSemanticTicketRequest } from '@retrieval-agent/query-understanding'
import type { RetrievalRanker } from '@retrieval-agent/model-service-client/ranking'
import { TicketPrincipalProviderService, TicketRetrievalProviderService } from './provider-services.js'
import { RetrievalAgentService } from './service.js'
import { SemanticOperators } from './semantic-operators.js'
import { PythonOperatorBridge } from './python-operator-bridge.js'

// These are transport/authority checks with synthetic vectors, not quality evaluation.
const poolCount = 132, outsideCount = 8, query = '查找合成状态甲的工单'
type Method = Extract<SemanticExecutionOptions['semanticMethod'], 'dual_description_margin' | 'name_gmm' | 'kmeans'>
type Variant = 'normal' | 'zero_anchor' | 'cancel_at_anchor' | 'unavailable_source_fields'
class Principal extends TicketPrincipalProviderService {
  async resolve() { return { tenantId: 'unlabeled-synthetic', subjectId: 'reader', entitlementVersion: 'v1',
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
  override featureAnchors: NonNullable<TicketRetrievalProvider['featureAnchors']> = (...a) => this.port.featureAnchors!(...a)
  override resolveFeatureIds: NonNullable<TicketRetrievalProvider['resolveFeatureIds']> = (...a) => this.port.resolveFeatureIds!(...a)
  override readCandidates: NonNullable<TicketRetrievalProvider['readCandidates']> = (...a) => this.port.readCandidates!(...a)
}

// The wrapper observes actual NDJSON callbacks/results; it does not replace Python execution.
class TraceBridge extends PythonOperatorBridge {
  readonly operations: string[] = []
  readonly callbacks: string[] = []
  readonly errors: string[] = []
  readonly predictions = new Map<number, number>()
  decisions = 0
  groupedFeatureRows = 0
  groupedSourceRows = 0
  private readonly groups = new Map<number, unknown>()
  override run(...args: Parameters<PythonOperatorBridge['run']>) {
    const [input, callback, result, signal] = args
    this.operations.push(input.op)
    return super.run(input, async (method, payload) => {
      this.callbacks.push(`${input.op}:${method}`)
      const reply = await callback(method, payload)
      if (input.op === 'sem_filter' && method === 'predictions.write') {
        const block = payload as { ids: number[]; labels: number[] }
        block.ids.forEach((id, i) => this.predictions.set(id, block.labels[i]!))
      }
      if (input.op === 'sem_filter' && method === 'features.scan') {
        const block = reply as { ids: number[]; row_groups?: { business_hash?: string; canonical_hash?: string; group_projection?: string }[] }
        expect(block.row_groups).toHaveLength(block.ids.length)
        block.row_groups!.forEach((group, i) => {
          expect(group.group_projection).toBe('business-and-canonical-nfkc-whitespace-v1')
          expect(group.business_hash).toMatch(/^[0-9a-f]{64}$/)
          expect(group.canonical_hash).toMatch(/^[0-9a-f]{64}$/)
          this.groups.set(block.ids[i]!, group)
        })
        this.groupedFeatureRows += block.ids.length
      }
      if (input.op === 'sem_filter' && method === 'rows.read') {
        const request = payload as { ids: number[] }, records = reply as { rows: { attributes: Record<string, unknown> }[] }
        records.rows.forEach((row, i) => expect(row.attributes.group_hashes).toEqual(this.groups.get(request.ids[i]!)))
        this.groupedSourceRows += records.rows.length
      }
      return reply
    }, async value => {
      const event = value as { type?: string; value?: { error?: string } }
      if (event.type === 'decision') { this.decisions++; if (event.value?.error) this.errors.push(event.value.error) }
      await result(value)
    }, signal)
  }
}

async function fixture(method: Method, variant: Variant = 'normal') {
  const ctx = new Context(), calls = { intent: 0, main: 0, teacher: 0, rank: 0, anchors: 0 }
  let reached = () => {}, dispose: (() => Promise<void>) | undefined
  const anchorReached = new Promise<void>(done => { reached = done })
  const root = process.cwd()
  // Pin local stdio explicitly: ambient service/model environment cannot select a network endpoint.
  const bridge = new TraceBridge(root, resolve(tmpdir(), `caseweave-unlabeled-${randomUUID()}.sqlite`),
    resolve(root, '.venv/Scripts/python.exe'), '')
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
    const ranker: RetrievalRanker = {
      profileVersion: 'unlabeled-synthetic-v1', documentProjection: 'canonical-title-abstract-v1',
      capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
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
        const dense = Buffer.alloc(documents.length * 8)
        documents.forEach((d, i) => {
          const index = Number(d.id.slice(1)), theta = index % 2 ? 1.3 + (index % 11) * .01 : .15 + (index % 13) * .01
          dense.writeFloatLE(Math.cos(theta), i * 8); dense.writeFloatLE(Math.sin(theta), i * 8 + 4)
        })
        return { embedding_id: 'synthetic-l2-title-abstract-v1', dimensions: 2,
          dense: dense.toString('base64'), available: Buffer.alloc(documents.length, 1).toString('base64') }
      },
      async queryAnchors(texts, signal) {
        calls.anchors++
        expect(texts).toEqual([`符合以下检索条件的工单：${query}`, `不符合以下检索条件的工单：${query}`])
        reached()
        if (variant === 'cancel_at_anchor') await new Promise<never>((_done, reject) => {
          if (signal?.aborted) reject(new RetrievalError('CANCELLED', 'Synthetic anchor cancelled'))
          else signal?.addEventListener('abort', () => reject(new RetrievalError('CANCELLED', 'Synthetic anchor cancelled')), { once: true })
        })
        return { embedding_id: 'synthetic-l2-title-abstract-v1', dimensions: 2,
          vectors: [variant === 'zero_anchor' ? [0, 0] : [1, 0], [0, 1]],
          profileIdentity: { model: 'synthetic', dimensions: 2, normalization: 'l2', projectionVersion: 'canonical-title-abstract-v1' } }
      },
    }
    const rows = Array.from({ length: poolCount + outsideCount }, (_, i) => normalizeFixtureTicket({
      ticketId: `r${i}`, displayId: `S-${i}`, tenantId: 'unlabeled-synthetic', allowedSubjectIds: [], requiredAttributes: {},
      sourceVersion: 'v1', title: '合成工单', summary: i % 2 ? '状态乙' : '状态甲', problemDescription: '合成原文',
      conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable',
      rawSource: { datasetId: 'unlabeled-synthetic', datasetVersion: 'v1', schemaVersion: 'v1', recordId: `physical-${i}`,
        payload: { group_id: `business-${i}`, large_model_title: '合成工单', large_model_abstract: i % 2 ? '状态乙' : '状态甲' } },
    }))
    new Principal(ctx); new Provider(ctx, new LocalTicketProvider(rows, { ranker, defaultMode: 'dense', documentProjection: 'canonical-title-abstract-v1' }))
    const app = new RetrievalAgentService(ctx, { searchTopK: 3, reviewBatchSize: 8 })
    const operators = new SemanticOperators(ctx, app, undefined, root, bridge, { batchSize: 64, options: { block_size: 64, batch_size: 64, concurrency: 2 } })
    class PlanningOnlyAdapter extends LlmAdapter {
      override async resolveModel(provider: string, id: string) { return { provider, id, name: id, reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (!options.system?.includes('当前操作：query_plan')) {
          if (options.sessionId?.startsWith('operator-')) calls.teacher++; else calls.main++
          throw new Error('Only the scripted intent call is allowed; teacher/main generation is forbidden')
        }
        calls.intent++
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'submit_result',
          arguments: JSON.stringify(variant === 'unavailable_source_fields'
            ? { keywords: [], instruction: query, retrieval_expressions: [], structured_conditions: [] }
            : { keywords: [], instruction: query, retrieval_expressions: [], goal: { mode: 'all', count: null },
              steps: [{ id: 'review', op: 'sem_filter', inputs: ['$source'], instruction: query, params: {} }] }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['unlabeled-fixture'], new PlanningOnlyAdapter())
    await ctx.plugin(SessionProjection); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'unlabeled-fixture', model: 'scripted' } })
    dispose = handle.dispose
    const agent = handle.agent
    await app.start(agent, buildSemanticTicketRequest(query, { onlineLearning: false, semanticMethod: method,
      ...(variant === 'unavailable_source_fields' ? { orchestration: 'fixed' as const } : {}) }))
    expect(calls).toMatchObject({ intent: 1, main: 0, teacher: 0, rank: 0, anchors: 0 })
    return { app, operators, agent, bridge, calls, anchorReached, async close() { bridge.close(); await dispose?.(); await ctx.fiber.dispose() } }
  } catch (error) { bridge.close(); await dispose?.(); await ctx.fiber.dispose(); throw error }
}

function assertNoTeacher(run: Awaited<ReturnType<typeof fixture>>) {
  expect(run.calls).toMatchObject({ intent: 1, main: 0, teacher: 0, rank: 1, anchors: 1 })
  expect(run.bridge.operations).toEqual(['query_plan', 'sem_filter'])
  expect(run.bridge.callbacks.filter(c => c === 'query_plan:llm.generate')).toHaveLength(1)
  expect(run.bridge.callbacks.filter(c => c.startsWith('sem_filter:llm.'))).toEqual([])
  expect(run.bridge.callbacks.filter(c => c === 'sem_filter:features.anchor')).toHaveLength(1)
  expect(run.bridge.groupedFeatureRows).toBe(poolCount)
}

it.each(['dual_description_margin', 'name_gmm', 'kmeans'] as const)(
  'consumes public fixed %s request via actual Local anchors and Python full scope without teacher authority', async method => {
    const run = await fixture(method)
    try {
      await run.operators.searchAndFilter(run.agent)
      assertNoTeacher(run)
      const state = run.app.current(run.agent)
      const learning = state.budget.operatorUsage?.learning as Record<string, unknown>
      expect(learning).toMatchObject({ algorithm: method, teacher_calls: 0, teacher_unique_records: 0,
        online_feedback_training: false, corpus_records: poolCount, scope_records: poolCount,
        complete_scope_coverage: true, semantic_complete: true, quality: 'unmeasured', stop_reason: 'complete', source_read_passes: 0 })
      expect(learning.manifest).toMatchObject({ method, pool_records: poolCount, usable_vectors: poolCount,
        teacher_calls: 0, quality: 'unmeasured', authority: 'final_yes_collection', fit_count: method === 'dual_description_margin' ? 0 : 1 })
      expect(run.bridge.decisions).toBe(0)
      expect(run.bridge.groupedSourceRows).toBe(0)
      expect(run.bridge.errors).toEqual([])
      expect(state.judgments ?? []).toHaveLength(0)
      expect(run.bridge.predictions.size).toBe(poolCount)
      expect(new Set(run.bridge.predictions.values())).toEqual(new Set([0, 1]))
      const learned = learnedResult(state)!
      expect(learned.scope_count).toBe(poolCount)
      const positives = [...run.bridge.predictions.values()].filter(label => label === 1).length
      expect(confirmedCount(state)).toBe(positives)
      expect(learned.returned).toBe(positives)
      const page = await run.app.semanticResults.page(state.retrievalId, learned.model_id, -1, poolCount + outsideCount)
      expect(page.ids).toHaveLength(positives)
      expect(page.ids.every(id => id < poolCount && run.bridge.predictions.get(id) === 1)).toBe(true)
      // 此处只执行算子，Host随后终结任务；已发布普通是集合可立即分页。
      expect(state.phase).toBe('assessed')
      // The 8 un-recalled authorized rows and the 100-row UI window never replace the fixed 132-row pool.
      expect(state.candidates.every(candidate => Number(candidate.displayId.slice(2)) < poolCount)).toBe(true)
    } finally { await run.close() }
  }, 60000)

it('rejects a zero anchor as an execution error before numeric publication', async () => {
  const run = await fixture('dual_description_margin', 'zero_anchor')
  try {
    await expect(run.operators.searchAndFilter(run.agent)).rejects.toThrow('ProtocolError')
    assertNoTeacher(run)
    expect(run.bridge.decisions).toBe(0)
    expect(run.bridge.groupedSourceRows).toBe(0)
    expect(run.bridge.predictions.size).toBe(0)
    const state = run.app.current(run.agent)
    expect(state.judgments ?? []).toHaveLength(0)
    expect(learnedResult(state)).toBeUndefined()
    expect(confirmedCount(state)).toBe(0)
  } finally { await run.close() }
}, 60000)

it('cancels actual stdio execution at the Local anchor callback before fitting or accepting predictions', async () => {
  const run = await fixture('kmeans', 'cancel_at_anchor'), controller = new AbortController()
  try {
    const pending = run.operators.searchAndFilter(run.agent, controller.signal)
    // Attach the rejection observer before aborting so cancellation cannot become an unhandled rejection.
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await run.anchorReached
    controller.abort()
    await rejected
    assertNoTeacher(run)
    const state = run.app.current(run.agent)
    expect(run.bridge.decisions).toBe(0)
    expect(run.bridge.groupedSourceRows).toBe(0)
    expect(state.judgments ?? []).toHaveLength(0)
    expect(state.budget.operatorUsage?.learning).not.toMatchObject({ complete_scope_coverage: true })
    expect(confirmedCount(state)).toBe(0)
  } finally { await run.close() }
}, 60000)


it('keeps generic canonical fixed no-feedback predictions measurable despite absent raw business evidence', async () => {
  const run = await fixture('name_gmm', 'unavailable_source_fields')
  try {
    await run.operators.searchAndFilter(run.agent)
    assertNoTeacher(run)
    const state = run.app.current(run.agent)
    expect(state.snapshot?.documentProjection).toBe('canonical-title-abstract-v1')
    expect(state.query.contract?.semanticPlan?.steps[0]?.params).toMatchObject({ require_source: false, required_fields: [] })
    expect(state.query.contract?.semanticPlan?.unsupported_constraints ?? []).toEqual([])
    expect(run.bridge.errors).toEqual([])
    expect(state.judgments ?? []).toHaveLength(0)
    expect(run.bridge.groupedSourceRows).toBe(0)
    expect(new Set(run.bridge.predictions.values())).toEqual(new Set([0, 1]))
    expect(confirmedCount(state)).toBe([...run.bridge.predictions.values()].filter(label => label === 1).length)
    expect(learnedResult(state)?.scope_count).toBe(poolCount)
  } finally { await run.close() }
}, 60000)
