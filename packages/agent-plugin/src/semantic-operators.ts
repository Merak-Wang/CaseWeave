import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RetrievalError, type ContextManifest, type OperatorDecision, type OperatorRecord,
  type RetrievalState, type SemanticQueryPlan, type TicketCandidateRef } from '@retrieval-agent/contracts'
import { estimateContextTokens, operatorRecord, operatorRequiredFields, validateOperatorRecord } from '@retrieval-agent/domain'
import { PythonOperatorBridge, type PythonOperatorRun } from './python-operator-bridge.js'
import type { RetrievalAgentService } from './service.js'
import { inputContextTokens } from './context-recovery.js'
import { isDeepStrictEqual } from 'node:util'
import { openWiki, revokedKnowledge } from './wiki-store.js'
import { modelFailure } from './model-failure.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type ModelRequest = { messages: { role: string; content: string }[]; schema: Record<string, unknown>; manifest_id: string; operation: string }
type ModelScope = { state: RetrievalState; input: ModelRequest; knowledge: PythonOperatorRun['knowledge']; manifests: ContextManifest[] }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RetrievalError('PROTOCOL_MISMATCH', '算子协议要求对象。')
  return value as Record<string, unknown>
}

/** Python owns semantics. This adapter only transports authorized data, DSH requests and admitted results. */
export class SemanticOperators {
  readonly bridge: PythonOperatorBridge
  private readonly requests = new AsyncLocalStorage<ModelScope>()
  constructor(readonly ctx: Context, readonly application: RetrievalAgentService, readonly wikiRoot?: string,
    readonly root = process.cwd(), bridge?: PythonOperatorBridge) {
    this.bridge = bridge ?? new PythonOperatorBridge(root)
    application.operators = this
    ctx.effect(() => () => this.bridge.close())
    ctx.on('llm/stream', (options, next) => {
      const scope = this.requests.getStore()
      if (!scope) return next()
      const host = this
      return (async function* () { scope.manifests.push(host.manifest(scope, options)); yield* next() })()
    }, { global: true })
  }
  private manifest(scope: ModelScope, options: GenerateOptions): ContextManifest {
    const user = scope.input.messages.filter(m => m.role === 'user').map(m => m.content)
    const actual = options.messages.flatMap(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : []))
    const system = scope.input.messages.find(m => m.role === 'system')?.content
    if (typeof system !== 'string' || options.system !== system || user.length !== actual.length || user.some((s, i) => s !== actual[i])) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '实际 DSH 请求未完整送达算子指令、来源和固定 Wiki。')
    }
    const data = object(JSON.parse(user.at(-1)!))
    const collect = (v: unknown): OperatorRecord[] => Array.isArray(v) ? v.flatMap(collect) : v && typeof v === 'object'
      ? 'ref' in v && 'version' in v && 'content_hash' in v && 'passages' in v ? [v as OperatorRecord] : Object.values(v).flatMap(collect) : []
    const supplied = collect(data)
    for (const row of supplied) validateOperatorRecord(scope.state, row)
    const rows = [...new Map(supplied.map(r => [r.ref, { ...r, passages: [...new Map(supplied.filter(s => s.ref === r.ref).flatMap(s => s.passages).map(p => [p.id, p])).values()] }])).values()]
    const evidence = scope.state.promotedEvidence.filter(e => rows.some(r => r.passages.some(p => p.id === e.evidenceId)))
    const serialized = JSON.stringify({ system: options.system, tools: options.tools, messages: options.messages })
    const tokens = estimateContextTokens(serialized)
    const knowledgeIds = scope.knowledge.entries.map(e => String(e.id))
    return { id: hash([scope.input.manifest_id, serialized]), roleId: `operator:${scope.input.manifest_id}`, stateId: scope.state.stateId,
      inputGeneration: scope.state.inputGeneration ?? 0, candidateRefs: rows.map(r => r.ref as TicketCandidateRef),
      evidenceIds: evidence.map(e => e.evidenceId), evidenceSpans: evidence.map(e => ({ evidenceId: e.evidenceId, start: e.start, end: e.end, contentHash: e.spanHash ?? e.contentHash })),
      knowledgeRefs: scope.knowledge.entries.map(e => String(e.reference ?? e.id)),
      ...(scope.knowledge.release === 'none' ? {} : { releaseId: scope.knowledge.release }), renderedHash: hash(serialized), estimatedTokens: tokens, measurement: 'dsh_request',
      operator: { pythonManifestId: scope.input.manifest_id, operation: scope.input.operation, records: rows, knowledgeIds,
        ...(scope.state.knowledgeCatalog ? { catalog: scope.state.knowledgeCatalog } : {}) } }
  }
  private config(agent: Agent) {
    const config = this.application.modelSelection ? this.application.modelSelection(agent) : agent.session.requestContext() ?? agent.options
    if (!config?.provider || !config.model) throw new RetrievalError('PROVIDER_UNAVAILABLE', '当前 DSH 模型未配置或已失效，请在模型设置中选择可用模型后继续。')
    return { provider: config.provider, model: config.model, contextWindow: agent.session.requestContext()?.contextWindow ?? 32000 }
  }
  private async knowledge(state: RetrievalState): Promise<PythonOperatorRun['knowledge']> {
    if (!this.wikiRoot || !state.knowledgeCatalog?.releaseId) return { release: 'none', entries: [] }
    const wiki = await openWiki(this.wikiRoot, { releaseId: state.knowledgeCatalog.releaseId })
    const selected = wiki.search([state.query.original, ...(state.userFeedback ?? []).map(f => f.text)].join('\n'), { phase: 'post-fast-query', limit: 3 }).map(e => wiki.read(e.id))
    const revoked = new Set(await revokedKnowledge(this.wikiRoot, selected.map(e => e.reference)))
    return { release: wiki.releaseId ?? 'none', entries: selected.filter(e => !revoked.has(e.reference)).map(e => ({ ...e })) }
  }
  private async model(agent: Agent, scope: ModelScope, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const config = this.config(agent), input = scope.input
    const system = input.messages.find(m => m.role === 'system')?.content
    if (!system || input.messages.some(m => !['system', 'user'].includes(m.role))) throw new RetrievalError('PROTOCOL_MISMATCH', '不支持的算子模型消息。')
    const request: GenerateOptions = { provider: config.provider, model: config.model, sessionId: SessionId(`operator-${input.manifest_id}`),
      ...(signal ? { signal } : {}), system,
      tools: [{ name: 'submit_result', description: 'Submit the operator result with source citations.', parameters: input.schema }],
      messages: input.messages.filter(m => m.role === 'user').map(m => createUserMessage({ content: [{ type: 'text', text: m.content }],
        source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot', sections: [{ name: input.operation, text: m.content }] } })) }
    if (estimateContextTokens(JSON.stringify(request)) + 4096 > config.contextWindow) throw new RetrievalError('CAPACITY_EXCEEDED', '算子当前证据批次超过模型上下文容量；请缩小批次或定向读取必要片段。')
    const path = resolve(this.root, '.cache/semantic-operators/requests', `${input.manifest_id}.json`)
    await mkdir(resolve(this.root, '.cache/semantic-operators/requests'), { recursive: true })
    const started = Date.now(); let payload: unknown, usage: TokenUsage | undefined, finished = false, failure: string | undefined
    let aggregateReceipt: unknown
    try {
      if (input.operation === 'sem_agg') {
        const data = object(JSON.parse(input.messages.find(m => m.role === 'user')!.content))
        for (const source of data.sources as Record<string, unknown>[]) {
          const rows = source.records as OperatorRecord[]
          if (source.origin === 'derived_summary') {
            const prior = await this.receipt(scope.state, String(source.source_manifest_id))
            if (prior.aggregateReceipt?.text !== source.text) throw new RetrievalError('PROTOCOL_MISMATCH', '聚合摘要与原始请求的输出来源不一致。')
            for (const row of prior.aggregateReceipt.records) validateOperatorRecord(scope.state, row)
          } else {
            if (!Array.isArray(rows) || rows.length !== 1 || rows[0]!.passages.length !== 1 || rows[0]!.passages[0]!.text !== source.text
              || rows[0]!.passages[0]!.origin !== source.origin) throw new RetrievalError('PROTOCOL_MISMATCH', '聚合叶子文本与送达片段不一致。')
            rows.forEach(row => validateOperatorRecord(scope.state, row))
          }
        }
      }
      await this.requests.run(scope, async () => {
        for await (const chunk of this.ctx.llm.stream(request)) {
          signal?.throwIfAborted()
          if (chunk.type === 'usage') usage = chunk.usage
          if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
            if (payload !== undefined || chunk.block.name !== 'submit_result') throw new RetrievalError('PROTOCOL_MISMATCH', '算子必须提交一次结构化结果。')
            payload = JSON.parse(chunk.block.arguments)
          }
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error') throw modelFailure(chunk.reason.failure)
            finished = ['stop', 'tool-calls'].includes(chunk.reason.kind)
          }
        }
      })
      if (!finished || payload === undefined || !scope.manifests.some(m => m.operator?.pythonManifestId === input.manifest_id)) throw new RetrievalError('PROTOCOL_MISMATCH', '算子模型未完成实际结构化提交。')
      if (input.operation === 'sem_agg') {
        const data = object(JSON.parse(input.messages.find(m => m.role === 'user')!.content)), result = object(payload)
        const sources = data.sources as { id: string; records?: OperatorRecord[]; source_manifest_id?: string }[], ids = result.source_ids
        if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !sources.some(s => s.id === id))) throw new RetrievalError('PROTOCOL_MISMATCH', '聚合引用了未送达的来源。')
        const rows: OperatorRecord[] = []
        for (const id of ids) {
          const source = sources.find(s => s.id === id)!
          if (source.records) rows.push(...source.records)
          else rows.push(...(await this.receipt(scope.state, source.source_manifest_id!)).aggregateReceipt.records)
        }
        aggregateReceipt = { text: result.status === 'ok' ? result.text : '', records: [...new Map(rows.map(r => [r.ref,
          { ...r, passages: [...new Map(rows.filter(s => s.ref === r.ref).flatMap(s => s.passages).map(p => [p.id, p])).values()] }])).values()] }
      }
      return { payload, usage: usage ? { prompt_tokens: inputContextTokens(usage), completion_tokens: usage.outputTokens,
        cached_prompt_tokens: usage.cacheReadTokens ?? null } : {} }
    } catch (error) { failure = error instanceof RetrievalError ? error.code : 'model_failure'; throw error }
    finally {
      await writeFile(path, JSON.stringify({ operation: input.operation, pythonManifestId: input.manifest_id, provider: config.provider, model: config.model,
        taskScope: [scope.state.retrievalId, scope.state.inputGeneration ?? 0, scope.state.snapshot?.snapshotId, scope.state.principalBindingHash],
        request: { system: request.system, messages: request.messages, tools: request.tools }, manifests: scope.manifests.filter(m => m.operator?.pythonManifestId === input.manifest_id),
        startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, usage: usage ?? null, payload, aggregateReceipt, failure }), { mode: 0o600 })
    }
  }
  private async receipt(state: RetrievalState, id: string) {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw new RetrievalError('PROTOCOL_MISMATCH', '缓存请求身份无效。')
    const saved = JSON.parse(await readFile(resolve(this.root, '.cache/semantic-operators/requests', `${id}.json`), 'utf8'))
    if (hash(saved.taskScope) !== hash([state.retrievalId, state.inputGeneration ?? 0, state.snapshot?.snapshotId, state.principalBindingHash]) || saved.failure) {
      throw new RetrievalError('INVALID_TRANSITION', '缓存请求不属于当前任务、输入和授权来源。')
    }
    return saved
  }
  private async modelCallback(agent: Agent, state: RetrievalState, knowledge: PythonOperatorRun['knowledge'], manifests: ContextManifest[], method: string, payload: unknown, signal?: AbortSignal) {
    if (method === 'llm.generate') return this.model(agent, { state, knowledge, manifests, input: payload as ModelRequest }, signal)
    if (method !== 'llm.reuse') throw new RetrievalError('INVALID_REQUEST', '未授权的模型回调。')
    const reuse = object(payload), input = reuse.request as ModelRequest, saved = await this.receipt(state, input.manifest_id)
    const config = this.config(agent)
    if (saved.provider !== config.provider || saved.model !== config.model || !isDeepStrictEqual(saved.payload, reuse.payload)
      || saved.request.system !== input.messages.find(m => m.role === 'system')?.content
      || !isDeepStrictEqual(saved.request.tools[0]?.parameters, input.schema)
      || hash(saved.request.messages.flatMap((m: any) => m.content.map((b: any) => b.text))) !== hash(input.messages.filter(m => m.role === 'user').map(m => m.content))) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '缓存响应与本次实际请求不一致。')
    }
    for (const m of saved.manifests as ContextManifest[]) {
      m.operator?.records.forEach(row => validateOperatorRecord(state, row))
      if (!manifests.some(n => n.id === m.id)) manifests.push(m)
    }
    return { payload: saved.payload }
  }
  private runInput(agent: Agent, state: RetrievalState, knowledge: PythonOperatorRun['knowledge'], op: string, instruction: string,
    params: Record<string, unknown> = {}): PythonOperatorRun {
    if (!state.snapshot || state.accessValidation === 'required') throw new RetrievalError('UNAUTHORIZED', '算子需要当前授权快照。')
    const config = this.config(agent)
    return { scope: { task_id: state.retrievalId, input_revision: state.inputGeneration ?? 0, snapshot: state.snapshot.snapshotId,
      authorization: hash([state.principalBindingHash, state.snapshot.authorizationVersion]) }, model_identity: hash(config), knowledge, op, instruction, params, source_handle: 'current-candidates' }
  }
  async plan(agent: Agent, state: RetrievalState, signal?: AbortSignal): Promise<{ plan: SemanticQueryPlan; manifests: ContextManifest[] }> {
    if (!state.knowledgeCatalog && this.wikiRoot) {
      const wiki = await openWiki(this.wikiRoot)
      state = { ...state, knowledgeCatalog: { ...(wiki.releaseId ? { releaseId: wiki.releaseId } : {}), status: wiki.releaseId ? 'available' : 'empty',
        domains: wiki.catalog().map(d => ({ id: d.id, description: d.title, entryIds: d.knowledgeRefs })) } }
    }
    const knowledge = await this.knowledge(state), manifests: ContextManifest[] = []
    let plan: SemanticQueryPlan | undefined
    const metrics = await this.bridge.run(this.runInput(agent, state, knowledge, 'query_plan', state.query.original,
      { confirmed_context: JSON.stringify({ feedback: state.userFeedback ?? [], confirmed_filters: state.query.confirmedConstraints,
        previous_plan: state.query.contract?.semanticPlan, fields: state.snapshot?.queryFields, evidence_fields: state.snapshot?.fieldCatalog,
        query_time: state.createdAt, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }) }),
    async (method, payload) => {
      return this.modelCallback(agent, state, knowledge, manifests, method, payload, signal)
    }, async value => {
      const event = object(value)
      if (event.type !== 'plan') throw new RetrievalError('PROTOCOL_MISMATCH', '查询规划返回了无效事件。')
      plan = { ...object(event.value), schemaVersion: 1, inputGeneration: state.inputGeneration ?? 0 } as unknown as SemanticQueryPlan
    }, signal)
    if (!plan) throw new RetrievalError('PROTOCOL_MISMATCH', '查询规划缺少结果。')
    // Cached plans retain the original host receipt; a missing receipt requires a fresh model request.
    for (const m of state.contextManifests ?? []) if (m.operator?.pythonManifestId === plan.manifest_id && !manifests.some(n => n.id === m.id)) manifests.push(m)
    if (!manifests.length) {
      if (!/^[a-f0-9-]{36}$/u.test(plan.manifest_id)) throw new RetrievalError('PROTOCOL_MISMATCH', '缓存模型请求身份无效。')
      const saved = JSON.parse(await readFile(resolve(this.root, '.cache/semantic-operators/requests', `${plan.manifest_id}.json`), 'utf8'))
      if (JSON.stringify(saved.taskScope) !== JSON.stringify([state.retrievalId, state.inputGeneration ?? 0, state.snapshot?.snapshotId, state.principalBindingHash])
        || saved.failure) throw new RetrievalError('INVALID_TRANSITION', '缓存查询计划缺少同范围的已完成模型请求。')
      manifests.push(...saved.manifests)
    }
    return { plan, manifests: manifests.map(m => m.operator ? { ...m, operator: { ...m.operator, metrics } } : m) }
  }
  async ensurePlan(agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
    await this.application.coordinator?.validateKnowledge?.(agent)
    const state = this.application.current(agent)
    const plan = state.query.contract?.semanticPlan
    if (plan?.inputGeneration === (state.inputGeneration ?? 0)
      && state.contextManifests?.some(m => m.operator?.pythonManifestId === plan.manifest_id)) return state
    await this.application.recordOperatorActivity(agent, { operation: 'query_plan', status: 'running', at: new Date().toISOString(), inputGeneration: state.inputGeneration ?? 0 })
    try {
      const planned = await this.plan(agent, state, signal)
      await this.application.acceptSemanticPlan(agent, planned.plan, planned.manifests, signal)
      return this.application.recordOperatorActivity(agent, { operation: 'query_plan', status: 'completed', at: new Date().toISOString(), inputGeneration: state.inputGeneration ?? 0 })
    } catch (error) {
      await this.application.recordOperatorActivity(agent, { operation: 'query_plan', status: 'failed', at: new Date().toISOString(), inputGeneration: state.inputGeneration ?? 0 }).catch(() => {})
      throw error
    }
  }
  private async run(agent: Agent, ...args: Parameters<PythonOperatorBridge['run']>): Promise<Record<string, unknown>> {
    const activity = (status: 'running' | 'completed' | 'failed') => this.application.recordOperatorActivity(agent,
      { operation: args[0].op, status, at: new Date().toISOString(), inputGeneration: args[0].scope.input_revision })
    await activity('running')
    try { const metrics = await this.bridge.run(...args); await activity('completed'); return metrics }
    catch (error) {
      await activity('failed').catch(() => {})
      const metrics = error instanceof Error ? (error.cause as { operatorUsage?: Record<string, unknown> } | undefined)?.operatorUsage : undefined
      const current = this.application.current(agent)
      if (metrics && current.retrievalId === args[0].scope.task_id && (current.inputGeneration ?? 0) === args[0].scope.input_revision) {
        await this.application.recordOperatorUsage(agent, current.inputGeneration ?? 0, metrics)
      }
      throw error
    }
  }
  async filter(agent: Agent, refs?: readonly TicketCandidateRef[], signal?: AbortSignal): Promise<RetrievalState> {
    await this.application.ensureModelAccess(agent, signal)
    await this.application.coordinator?.prepare(agent, signal)
    const state = await this.ensurePlan(agent, signal), generation = state.inputGeneration ?? 0
    const plan = state.query.contract!.semanticPlan!, knowledge = await this.knowledge(state)
    const candidates = refs ? refs.map(ref => {
      const c = state.candidates.find(c => c.ref === ref)
      if (!c) throw new RetrievalError('CANDIDATE_NOT_FOUND', '算子输入不属于当前候选。')
      return c
    }) : state.candidates
    // The whole chosen candidate set is the algorithm's region. Only I/O and
    // model packing are paged; no review-window truncation of that population.
    const manifests: ContextManifest[] = []
    const strongFeedback = (s: RetrievalState) => (s.judgments ?? []).filter(j => j.basis !== 'proxy'
      && !manifests.some(m => m.id === j.operatorManifestId)).map(j => [j.candidateRef, j.verdict, j.evidenceRefs, j.operatorManifestId])
    const feedbackVersion = hash(strongFeedback(state))
    const current = async () => {
      signal?.throwIfAborted(); await this.application.loadTask(agent)
      const now = this.application.current(agent)
      if ((now.inputGeneration ?? 0) !== generation || now.retrievalId !== state.retrievalId || now.snapshot?.snapshotId !== state.snapshot?.snapshotId
        || now.principalBindingHash !== state.principalBindingHash || now.phase === 'stopped') throw new RetrievalError('INVALID_TRANSITION', '算子任务已变化，旧输出已拒收。')
      if (hash(strongFeedback(now)) !== feedbackVersion) throw new RetrievalError('INVALID_TRANSITION', '强判断已更正，需使用当前反馈重新推断。')
      return now
    }
    const metrics = await this.run(agent, this.runInput(agent, state, knowledge, 'sem_filter', JSON.stringify({ original: state.query.original,
      instruction: plan.instruction, user_feedback: state.userFeedback ?? [], rule: '原始请求和已确认补充优先，检索改写不是业务要求。' }),
      { batch_size: Math.min(this.application.reviewBatchSize, 8), require_source: plan.steps.some(s => s.op === 'sem_filter' && s.params.require_source === true),
        required_fields: operatorRequiredFields(plan), replay_saved: true,
        host_labels: Object.fromEntries((state.judgments ?? []).filter(j => j.basis !== 'proxy').map(j =>
          [j.candidateRef, j.verdict === 'accept' ? 1 : j.verdict === 'exclude' ? 0 : -1])),
        ...(!refs && plan.goal.mode === 'examples' ? { example_count: plan.goal.count } : {}) }),
    async (method, payload) => {
      const now = await current()
      if (method === 'rows.read') {
        const p = object(payload)
        if (p.handle !== 'current-candidates' || (p.cursor !== null && !/^\d+$/u.test(String(p.cursor)))) throw new RetrievalError('INVALID_REQUEST', '算子集合句柄或游标无效。')
        const offset = p.cursor === null ? 0 : Number(p.cursor), size = Math.min(Number(p.page_size) || 128, 128)
        const batch = candidates.slice(offset, offset + size)
        const principal = await this.application.principal(agent, 'detail_read', signal)
        const features = await this.ctx.ticketRetrievalProvider.readFeatures?.(principal,
          { snapshotId: state.snapshot!.snapshotId, candidateRefs: batch.map(c => c.ref) }, signal ? { signal } : {}) ?? []
        const page = batch.map(c => {
          const row = operatorRecord(now, c), feature = features.find(f => f.ref === c.ref)
          if (feature && (feature.content_hash !== c.contentHash || feature.version !== c.sourceVersion)) throw new RetrievalError('INVALID_TRANSITION', '已有向量不属于当前工单版本。')
          return { ...row, ...(feature ? { vectors: feature.vectors, embedding_id: feature.embedding_id } : {}) }
        })
        page.forEach(row => validateOperatorRecord(now, row))
        return { rows: page, next_cursor: offset + size < candidates.length ? String(offset + size) : null }
      }
      if (method === 'llm.generate' || method === 'llm.reuse') {
        const result = await this.modelCallback(agent, now, knowledge, manifests, method, payload, signal)
        for (const m of manifests) await this.application.updateExpert(agent, generation, { kind: 'manifest', manifest: m })
        return result
      }
      throw new RetrievalError('INVALID_REQUEST', '算子资源回调未授权。')
    }, async value => {
      await current()
      const event = object(value)
      if (event.type !== 'decision') throw new RetrievalError('PROTOCOL_MISMATCH', '过滤算子返回了无效事件。')
      await this.application.acceptOperatorResults(agent, generation, [event.value as OperatorDecision], signal)
    }, signal)
    await this.application.recordOperatorUsage(agent, generation, metrics)
    return this.application.current(agent)
  }
  async searchPlanned(agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
    const state = await this.ensurePlan(agent, signal), plan = state.query.contract!.semanticPlan!
    const searches = [
      ...(plan.keywords.length ? [{ mode: 'keyword' as const, text: plan.keywords.join(' '), terms: plan.keywords }] : []),
      ...plan.retrieval_expressions.filter(text => text.normalize('NFKC').trim() !== state.query.original.normalize('NFKC').trim())
        .map(text => ({ mode: 'dense' as const, text, terms: [] })),
    ]
    for (const search of searches) {
      const key = hash([state.retrievalId, state.inputGeneration ?? 0, state.snapshot?.snapshotId,
        state.principalBindingHash, state.snapshot?.authorizationVersion, state.query.confirmedConstraints, search.mode, search.text])
      if (this.application.current(agent).semanticSearchKeys?.includes(key)) continue
      await this.search(agent, search.mode === 'keyword' ? { keywords: search.terms } : { expression: search.text }, signal)
      if ((this.application.current(agent).inputGeneration ?? 0) !== (state.inputGeneration ?? 0)) throw new RetrievalError('INVALID_TRANSITION', '新输入已取代本轮检索计划。')
      if (this.application.current(agent).phase === 'stopped') return this.application.current(agent)
      await this.application.recordSemanticSearch(agent, key)
    }
    return this.application.current(agent)
  }
  async search(agent: Agent, query: { keywords: readonly string[] } | { expression: string }, signal?: AbortSignal): Promise<RetrievalState> {
    await this.application.ensureModelAccess(agent, signal)
    const state = this.application.current(agent), generation = state.inputGeneration ?? 0
    const keyword = 'keywords' in query, expected = keyword ? 'search.keyword' : 'search.vector'
    await this.run(agent, this.runInput(agent, state, { release: 'none', entries: [] }, 'sem_search', state.query.original,
      keyword ? { keywords: query.keywords } : { expressions: [query.expression] }), async (method, payload) => {
      signal?.throwIfAborted()
      if (method !== expected || (this.application.current(agent).inputGeneration ?? 0) !== generation) throw new RetrievalError('INVALID_TRANSITION', '搜索回调或输入代次无效。')
      const p = object(payload)
      const found = p.cursor === null ? await this.application.search(agent, { mode: keyword ? 'keyword' : 'dense', delta: keyword
        ? { kind: 'replace_terms', terms: query.keywords, operator: 'or' } : { kind: 'rewrite_semantic_query', text: query.expression } }, signal)
        : this.application.current(agent).lastPage?.nextCursor === p.cursor ? await this.application.continueRanking(agent, signal)
          : (() => { throw new RetrievalError('INVALID_TRANSITION', '搜索游标已失效。') })()
      if (found.phase === 'stopped') throw new RetrievalError('PROVIDER_UNAVAILABLE', found.stopExplanation ?? '搜索未完成。')
      return { hits: (found.lastPage?.candidates ?? []).map(c => ({ record: operatorRecord(found, c), score: null })),
        next_cursor: keyword ? found.lastPage?.nextCursor ?? null : null }
    }, async value => {
      const event = object(value)
      if (event.type !== 'candidate') throw new RetrievalError('PROTOCOL_MISMATCH', '搜索算子返回了无效事件。')
      validateOperatorRecord(this.application.current(agent), event.record as OperatorRecord)
    }, signal)
    return this.application.current(agent)
  }
  async operate(agent: Agent, operation: 'sem_topk' | 'sem_map' | 'sem_extract' | 'sem_join' | 'sem_agg',
    refs: readonly TicketCandidateRef[], instruction: string, params: Record<string, unknown>, signal?: AbortSignal,
    pairs?: readonly (readonly [TicketCandidateRef, TicketCandidateRef])[]): Promise<import('@retrieval-agent/contracts').OperatorArtifact> {
    await this.application.ensureModelAccess(agent, signal)
    const state = await this.ensurePlan(agent, signal), generation = state.inputGeneration ?? 0, knowledge = await this.knowledge(state)
    if (!refs.length || new Set(refs).size !== refs.length || !instruction.trim()) throw new RetrievalError('INVALID_REQUEST', '算子需要非空、去重的当前候选和指令。')
    const rows = refs.map(ref => {
      const candidate = state.candidates.find(c => c.ref === ref)
      if (!candidate) throw new RetrievalError('CANDIDATE_NOT_FOUND', '算子引用不属于当前候选。')
      return operatorRecord(state, candidate)
    })
    const paired = (pairs ?? []).map(([left, right]) => {
      const l = rows.find(r => r.ref === left), r = rows.find(r => r.ref === right)
      if (!l || !r) throw new RetrievalError('INVALID_REQUEST', '连接候选对必须属于本次授权输入。')
      return { left: l, right: r }
    })
    if (operation === 'sem_join' && !paired.length && typeof params.blocking_field !== 'string') throw new RetrievalError('INVALID_REQUEST', '语义连接需要明确候选对或 blocking_field。')
    const manifests: ContextManifest[] = [], events: unknown[] = []
    const current = async () => {
      signal?.throwIfAborted(); await this.application.loadTask(agent)
      const now = this.application.current(agent)
      if ((now.inputGeneration ?? 0) !== generation || now.retrievalId !== state.retrievalId || now.phase === 'stopped') throw new RetrievalError('INVALID_TRANSITION', '算子输入已过期。')
      rows.forEach(row => validateOperatorRecord(now, row)); return now
    }
    const metrics = await this.run(agent, this.runInput(agent, state, knowledge, operation,
      JSON.stringify({ original: state.query.original, predicate: state.query.contract!.semanticPlan!.instruction,
        user_feedback: state.userFeedback ?? [], operation_instruction: instruction, rule: '产物不修改工单事实，不自动确认候选；只处理已提供的集合或候选对。' }), params),
    async (method, payload) => {
      const now = await current(), p = object(payload)
      if (method === 'rows.read' || method === 'pairs.read') {
        if (p.handle !== 'current-candidates' || (p.cursor !== null && !/^\d+$/u.test(String(p.cursor)))) throw new RetrievalError('INVALID_REQUEST', '算子集合或游标无效。')
        const offset = p.cursor === null ? 0 : Number(p.cursor), source = method === 'rows.read' ? rows : paired, size = this.application.reviewBatchSize
        return { [method === 'rows.read' ? 'rows' : 'pairs']: source.slice(offset, offset + size), next_cursor: offset + size < source.length ? String(offset + size) : null }
      }
      const reply = await this.modelCallback(agent, now, knowledge, manifests, method, payload, signal)
      for (const m of manifests) await this.application.updateExpert(agent, generation, { kind: 'manifest', manifest: m })
      return reply
    }, async value => {
      await current()
      if (operation === 'sem_agg') {
        const event = object(value), summary = object(event.value)
        const saved = await this.receipt(this.application.current(agent), String(summary.manifest_id))
        if (event.type !== 'aggregate' || !saved.aggregateReceipt || summary.text !== saved.aggregateReceipt.text) throw new RetrievalError('PROTOCOL_MISMATCH', '聚合产物与实际模型输出不一致。')
        const citations = summary.citations as import('@retrieval-agent/contracts').OperatorCitation[]
        const expected = (saved.aggregateReceipt.records as OperatorRecord[]).flatMap(r => r.passages.map(p => [r.ref, r.version, r.content_hash, p.id, p.field, p.start, p.text, p.origin]))
        if (!Array.isArray(citations) || hash(citations.map(c => [c.ref, c.version, c.content_hash, c.passage_id, c.field, c.start, c.quote, c.origin])) !== hash(expected)) {
          throw new RetrievalError('PROTOCOL_MISMATCH', '聚合产物引文与模型选用的来源不一致。')
        }
      }
      events.push(value)
    }, signal)
    await current()
    await this.application.coordinator?.validateKnowledge?.(agent)
    await this.application.ensureModelAccess(agent, signal)
    const artifact = { id: hash([operation, generation, rows, instruction, params, events]), operation, inputGeneration: generation, candidateRefs: refs,
      manifestIds: [...new Set(manifests.map(m => m.id))], events }
    await this.application.recordOperatorArtifact(agent, artifact)
    await this.application.recordOperatorUsage(agent, generation, metrics)
    return artifact
  }
}
