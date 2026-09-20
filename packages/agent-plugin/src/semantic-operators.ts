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
import { estimateContextTokens, operatorRecords, operatorRequiredFields, validateOperatorRecords } from '@retrieval-agent/domain'
import { confirmedCount } from '@retrieval-agent/domain/result'
import { PythonOperatorBridge, type PythonOperatorRun } from './python-operator-bridge.js'
import type { RetrievalAgentService } from './service.js'
import { inputContextTokens } from './context-recovery.js'
import { isDeepStrictEqual } from 'node:util'
import { openWiki, revokedKnowledge } from './wiki-store.js'
import { modelFailure } from './model-failure.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// 累计调用回执只更新计量；学习状态由本轮 learning.update 更新，不能复活旧结论。
const usageMetrics = ({ learning: _learning, ...metrics }: Record<string, unknown>) => metrics
type ModelRequest = { messages: { role: string; content: string }[]; schema: Record<string, unknown>; manifest_id: string; operation: string }
type ModelScope = { state: RetrievalState; input: ModelRequest; knowledge: PythonOperatorRun['knowledge']; manifests: ContextManifest[] }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RetrievalError('PROTOCOL_MISMATCH', '算子协议要求对象。')
  return value as Record<string, unknown>
}

// 按工单和片段各归并一次；聚合树中的重复来源不会引发反复全表过滤。
function mergeOperatorRecords(rows: readonly OperatorRecord[]): OperatorRecord[] {
  const records = new Map<string, OperatorRecord>()
  const passages = new Map<string, Map<string, OperatorRecord['passages'][number]>>()
  for (const row of rows) {
    records.set(row.ref, row)
    const grouped = passages.get(row.ref) ?? new Map()
    for (const passage of row.passages) grouped.set(passage.id, passage)
    passages.set(row.ref, grouped)
  }
  return [...records.values()].map(row => ({ ...row, passages: [...passages.get(row.ref)!.values()] }))
}

/** Python 执行语义算法；此适配器连接授权数据、DSH 模型请求与结果准入。 */
export class SemanticOperators {
  readonly bridge: PythonOperatorBridge
  private readonly requests = new AsyncLocalStorage<ModelScope>()
  constructor(readonly ctx: Context, readonly application: RetrievalAgentService, readonly wikiRoot?: string,
    readonly root = process.cwd(), bridge?: PythonOperatorBridge,
    readonly filterConfig: { readonly algorithm?: 'auto' | 'cluster' | 'active' | 'learned' | 'baseline' | 'direct'; readonly options?: Readonly<Record<string, number | string>> } = {}) {
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
    const rows = mergeOperatorRecords(collect(data))
    const passageIds = new Set(rows.flatMap(r => r.passages.map(p => p.id)))
    const evidence = scope.state.promotedEvidence.filter(e => passageIds.has(e.evidenceId))
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
    const contextWindow = agent.session.requestContext()?.contextWindow
      ?? (await this.ctx.llm.resolveModelInfo(config.provider, config.model)).context?.contextWindow ?? config.contextWindow
    if (estimateContextTokens(JSON.stringify(request)) + 4096 > contextWindow) throw new RetrievalError('CAPACITY_EXCEEDED', '算子当前证据批次超过模型上下文容量；请缩小批次或定向读取必要片段。')
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
            validateOperatorRecords(scope.state, prior.aggregateReceipt.records)
          } else {
            if (!Array.isArray(rows) || rows.length !== 1 || rows[0]!.passages.length !== 1 || rows[0]!.passages[0]!.text !== source.text
              || rows[0]!.passages[0]!.origin !== source.origin) throw new RetrievalError('PROTOCOL_MISMATCH', '聚合叶子文本与送达片段不一致。')
            validateOperatorRecords(scope.state, rows)
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
        const rows: OperatorRecord[] = [], parents: string[] = []
        for (const id of ids) {
          const source = sources.find(s => s.id === id)!
          if (source.records) rows.push(...source.records)
          else parents.push(source.source_manifest_id!)
        }
        aggregateReceipt = { text: result.status === 'ok' ? result.text : '', records: mergeOperatorRecords(rows), parents }
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
    if (method === 'llm.generate') {
      const fresh: ContextManifest[] = []
      const result = await this.model(agent, { state, knowledge, manifests: fresh, input: payload as ModelRequest }, signal)
      manifests.push(...fresh)
      return result
    }
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
      if (m.operator) validateOperatorRecords(state, m.operator.records)
      if (!manifests.some(n => n.id === m.id)) manifests.push(m)
    }
    return { payload: saved.payload }
  }
  private async aggregateRecords(state: RetrievalState, manifestId: string): Promise<OperatorRecord[]> {
    const pending = [manifestId], visited = new Set<string>(), rows: OperatorRecord[] = []
    while (pending.length) {
      const id = pending.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      const receipt = (await this.receipt(state, id)).aggregateReceipt
      rows.push(...receipt.records); pending.push(...(receipt.parents ?? []))
    }
    return mergeOperatorRecords(rows)
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
    // 新调用和缓存命中都经 modelCallback 返回回执，不另开绕过该入口的恢复分支。
    const manifestId = plan.manifest_id
    if (!manifests.some(m => m.operator?.pythonManifestId === manifestId)) throw new RetrievalError('PROTOCOL_MISMATCH', '查询计划缺少实际模型请求。')
    return { plan, manifests: manifests.map(m => m.operator ? { ...m, operator: { ...m.operator, metrics: usageMetrics(metrics) } } : m) }
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
    try { const metrics = await this.bridge.run(...args); await activity('completed'); return usageMetrics(metrics) }
    catch (error) {
      await activity('failed').catch(() => {})
      const metrics = error instanceof Error ? (error.cause as { operatorUsage?: Record<string, unknown> } | undefined)?.operatorUsage : undefined
      const current = this.application.current(agent)
      if (metrics && current.retrievalId === args[0].scope.task_id && (current.inputGeneration ?? 0) === args[0].scope.input_revision) {
        await this.application.recordOperatorUsage(agent, current.inputGeneration ?? 0, usageMetrics(metrics))
      }
      throw error
    }
  }
  async filter(agent: Agent, refs?: readonly TicketCandidateRef[], signal?: AbortSignal): Promise<RetrievalState> {
    await this.application.ensureModelAccess(agent, signal)
    await this.application.coordinator?.prepare(agent, signal)
    const state = await this.ensurePlan(agent, signal), generation = state.inputGeneration ?? 0
    const plan = state.query.contract!.semanticPlan!, knowledge = await this.knowledge(state)
    const algorithm = refs || plan.goal.mode === 'examples' ? 'direct' : this.filterConfig.algorithm ?? 'auto'
    const fullScope = ['auto', 'active', 'learned'].includes(algorithm)
    const planFields = operatorRequiredFields(plan)
    const requiredFields = planFields
    const discoveryKey = (s: RetrievalState) => hash([s.candidates.map(c => c.ref).sort(), s.promotedEvidence.map(e => e.evidenceId).sort(), this.filterConfig.options])
    const lastLearning = state.budget.operatorUsage?.learning as { input_revision?: number; stop_reason?: string; discovery_key?: string } | undefined
    if (fullScope && lastLearning?.input_revision === generation
      && (lastLearning.stop_reason === 'quality_passed' || lastLearning.discovery_key === discoveryKey(state)
        && ['quality_not_met', 'needs_coverage', 'needs_information', 'needs_selection_coverage'].includes(lastLearning.stop_reason ?? ''))) return state
    const byRef = new Map(state.candidates.map(c => [c.ref, c]))
    const exampleWindow = !refs && plan.goal.mode === 'examples'
    const known = new Set((state.judgments ?? []).filter(j => j.basis !== 'proxy' && (exampleWindow || j.verdict !== 'undetermined')).map(j => j.candidateRef))
    let candidates = (refs ? refs.map(ref => {
      const c = byRef.get(ref)
      if (!c) throw new RetrievalError('CANDIDATE_NOT_FOUND', '算子输入不属于当前候选。')
      return c
    }) : state.candidates).filter(c => !known.has(c.ref))
    // 少量案例每轮只审阅一个窗口后交回 Agent；未决项由 Agent 定向补证，不盲扫整池。
    if (exampleWindow) candidates = candidates.slice(0, this.application.reviewBatchSize)
    if ((!fullScope && !candidates.length) || (!refs && plan.goal.mode === 'examples' && state.selectedCandidateRefs.length >= plan.goal.count!)) return state
    const batchSize = Math.min(this.application.reviewBatchSize, 8)
    const feedbackValue = (j: NonNullable<RetrievalState['judgments']>[number]) => JSON.stringify([j.verdict, j.evidenceRefs, j.operatorManifestId])
    const feedback = new Map((state.judgments ?? []).filter(j => j.basis !== 'proxy').map(j => [j.candidateRef, feedbackValue(j)]))
    let checkedJudgments = state.judgments
    const current = async () => {
      signal?.throwIfAborted(); await this.application.loadTask(agent)
      const now = this.application.current(agent)
      if ((now.inputGeneration ?? 0) !== generation || now.retrievalId !== state.retrievalId || now.snapshot?.snapshotId !== state.snapshot?.snapshotId
        || now.principalBindingHash !== state.principalBindingHash || now.phase === 'stopped') throw new RetrievalError('INVALID_TRANSITION', '算子任务已变化，旧输出已拒收。')
      if (now.judgments !== checkedJudgments) {
        const strong = (now.judgments ?? []).filter(j => j.basis !== 'proxy')
        if (strong.length !== feedback.size || strong.some(j => feedback.get(j.candidateRef) !== feedbackValue(j))) throw new RetrievalError('INVALID_TRANSITION', '强判断已更正，需使用当前反馈重新推断。')
        checkedJudgments = now.judgments
      }
      return now
    }
    let pending: OperatorDecision[] = []
    let modelMetadata: Record<string, unknown> | undefined
    let learnedSet: import('@retrieval-agent/contracts').LearnedResult | undefined
    let written = 0
    const hydrate = async (refs: readonly TicketCandidateRef[]) => {
      const existing = new Set(this.application.current(agent).candidates.map(c => c.ref))
      const missing = refs.filter(ref => !existing.has(ref))
      if (missing.length) {
        const provider = this.ctx.ticketRetrievalProvider
        if (!provider.readCandidates) throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Provider 尚未提供全库按需取样。')
        const candidates = await provider.readCandidates(await this.application.principal(agent, 'detail_read', signal),
          { snapshotId: state.snapshot!.snapshotId, candidateRefs: missing }, signal ? { signal } : {})
        await this.application.updateExpert(agent, generation, { kind: 'candidates', candidates })
      }
    }
    const flush = async () => {
      if (!pending.length) return
      await current()
      await hydrate(pending.map(d => d.ref as TicketCandidateRef))
      const result = await this.application.acceptOperatorResults(agent, generation, pending, signal)
      const submitted = new Set(pending.map(d => d.ref))
      for (const j of result.judgments ?? []) if (submitted.has(j.candidateRef) && j.basis !== 'proxy') feedback.set(j.candidateRef, feedbackValue(j))
      pending = []
    }
    const metrics = await this.run(agent, this.runInput(agent, state, knowledge, 'sem_filter', JSON.stringify({ original: state.query.original,
      instruction: plan.instruction, user_feedback: state.userFeedback ?? [], rule: '原始请求和已确认补充优先，检索改写不是业务要求。' }),
      { algorithm, scope_mode: fullScope ? 'full' : 'candidates', options: this.filterConfig.options ?? {}, initial_refs: state.candidates.map(c => c.ref),
        batch_size: batchSize, require_source: plan.steps.some(s => s.op === 'sem_filter' && s.params.require_source === true),
        required_fields: requiredFields, replay_saved: true,
        host_labels: Object.fromEntries((state.judgments ?? []).filter(j => j.basis !== 'proxy').map(j =>
          [j.candidateRef, j.verdict === 'accept' ? 1 : j.verdict === 'exclude' ? 0 : -1])),
        ...(!refs && plan.goal.mode === 'examples' ? { example_count: plan.goal.count! - state.selectedCandidateRefs.length } : {}) }),
    async (method, payload) => {
      if (method === 'llm.generate' || method === 'llm.reuse') {
        const now = await current(), requestManifests: ContextManifest[] = []
        const result = await this.modelCallback(agent, now, knowledge, requestManifests, method, payload, signal)
        for (const manifest of requestManifests) await this.application.updateExpert(agent, generation, { kind: 'manifest', manifest })
        return result
      }
      await flush()
      let now = await current()
      if (['features.scan', 'features.take', 'features.seeds'].includes(method)) {
        const p = object(payload), provider = this.ctx.ticketRetrievalProvider
        if (!provider.featureBlock) throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Provider 尚未提供授权数值块；不会退回全库逐条强判。')
        const principal = await this.application.principal(agent, 'detail_read', signal)
        const block = await provider.featureBlock(principal,
          { snapshotId: state.snapshot!.snapshotId, limit: p.page_size ? Math.min(2048, Number(p.page_size)) : Number((p.ids as number[] | undefined)?.length ?? (p.refs as string[] | undefined)?.length ?? 2048),
            filters: state.query.confirmedConstraints, ...(p.cursor !== null && p.cursor !== undefined ? { cursor: String(p.cursor) } : {}),
            ...(p.ids ? { ids: p.ids as number[] } : {}), ...(p.refs ? { refs: p.refs as TicketCandidateRef[] } : {}) }, signal ? { signal } : {})
        if (method !== 'features.seeds') return block
        if (!provider.resolveFeatureIds) throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Provider 尚未提供数值来源映射。')
        const seedRows = await provider.resolveFeatureIds(principal, { snapshotId: state.snapshot!.snapshotId, ids: block.ids }, signal ? { signal } : {})
        const strong = new Map((state.judgments ?? []).filter(j => j.basis !== 'proxy').map(j => [j.candidateRef, j.verdict]))
        return { ...block, known_labels: Object.fromEntries(seedRows.flatMap((row, i) => strong.has(row.ref)
          ? [[block.ids[i], strong.get(row.ref) === 'accept' ? 1 : strong.get(row.ref) === 'exclude' ? 0 : -1]] : [])) }
      }
      if (method === 'predictions.begin') {
        modelMetadata = object(payload); written = 0
        if (modelMetadata.input_revision !== generation || !modelMetadata.predicate_key || !modelMetadata.feature_id || Number(modelMetadata.fit_count) < 1) throw new RetrievalError('INVALID_REQUEST', '学习结果缺少当前模型来源。')
        await this.application.semanticResults.begin(state.retrievalId, String(modelMetadata.model_id))
        return {}
      }
      if (method === 'predictions.write') {
        const block = payload as import('@retrieval-agent/contracts').NumericPredictionBlock
        if (block.model_id !== modelMetadata?.model_id || (block.offset >= 0 && block.offset !== written)
          || block.ids.length !== block.labels.length || block.ids.length !== block.scores.length) throw new RetrievalError('INVALID_REQUEST', '预测块不属于当前模型或扫描顺序。')
        await this.application.semanticResults.write(state.retrievalId, block)
        if (block.offset >= 0) written += block.ids.length
        return {}
      }
      if (method === 'predictions.finish') {
        const p = object(payload), quality = p.quality as import('@retrieval-agent/contracts').LearnedResult['quality']
        if (p.model_id !== modelMetadata?.model_id || p.scope_count !== written) throw new RetrievalError('INVALID_REQUEST', '预测集合未覆盖本次扫描。')
        if (p.passed === true) {
          if (quality.precision_lower === null || quality.recall_lower === null || quality.precision_lower < quality.precision_target
            || quality.recall_lower < quality.recall_target) throw new RetrievalError('INVALID_REQUEST', '集合质量未达到声明目标。')
          const returned = await this.application.semanticResults.count(state.retrievalId, String(p.model_id))
          if (returned !== p.returned) throw new RetrievalError('PROTOCOL_MISMATCH', '数值集合与 Host 保存数量不一致。')
          const setHash = createHash('sha256').update(String(modelMetadata!.feature_id)); let after = -1
          for (;;) {
            const page = await this.application.semanticResults.page(state.retrievalId, String(p.model_id), after, 16384)
            if (!page.ids.length) break
            const bytes = Buffer.alloc(page.ids.length * 8); page.ids.forEach((id, i) => bytes.writeBigInt64LE(BigInt(id), i * 8))
            setHash.update(bytes); after = page.ids.at(-1)!
          }
          modelMetadata = { ...modelMetadata, result_set_sha256: setHash.digest('hex'), hash_basis: 'feature_id + sorted int64 IDs (little endian)' }
          learnedSet = { model_id: String(p.model_id), input_revision: generation, predicate_key: String(modelMetadata!.predicate_key),
            feature_id: String(modelMetadata!.feature_id), returned, scope_count: written, quality, metadata: modelMetadata! }
        }
        return {}
      }
      if (method === 'learning.update') {
        const { _usage, ...learning } = object(payload)
        await this.application.recordOperatorUsage(agent, generation, { ...now.budget.operatorUsage,
          ...(_usage ? object(_usage) : {}), learning: { ...learning, discovery_key: discoveryKey(now), ...(learnedSet ? { result_set: learnedSet } : {}) } })
        return {}
      }
      if (method === 'rows.read') {
        const p = object(payload)
        if (Array.isArray(p.ids)) {
          const provider = this.ctx.ticketRetrievalProvider
          if (!provider.resolveFeatureIds) throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Provider 尚未提供数值 ID 来源读取。')
          const resolved = await provider.resolveFeatureIds(await this.application.principal(agent, 'detail_read', signal),
            { snapshotId: state.snapshot!.snapshotId, ids: p.ids as number[] }, signal ? { signal } : {})
          await this.application.updateExpert(agent, generation, { kind: 'candidates', candidates: resolved })
          p.refs = resolved.map(c => c.ref)
        }
        const requested = Array.isArray(p.refs) ? p.refs as TicketCandidateRef[] : undefined
        if (!requested && (p.handle !== 'current-candidates' || (p.cursor !== null && !/^\d+$/u.test(String(p.cursor))))) throw new RetrievalError('INVALID_REQUEST', '算子集合句柄或游标无效。')
        const offset = p.cursor === null ? 0 : Number(p.cursor), size = batchSize
        if (requested) { await hydrate(requested); now = await current() }
        const currentCandidates = requested ? new Map(now.candidates.map(c => [c.ref, c])) : undefined
        const batch = requested ? requested.map(ref => currentCandidates!.get(ref)!) : candidates.slice(offset, offset + size)
        const reads = new Map<string, { fields: string[]; refs: TicketCandidateRef[] }>()
        const rows = operatorRecords(now, batch)
        for (const [i, c] of batch.entries()) {
          const row = rows[i]!
          const fields = [...new Set([...requiredFields, ...(row.attributes!.required_evidence_fields as string[])])]
            .filter(f => (fullScope || !row.passages.some(p => p.field === f && p.origin === 'source' && p.text))
              && now.snapshot!.fieldCatalog.some(field => field.key === f))
          if (!fields.length) continue
          const key = fields.sort().join('\n'), read = reads.get(key) ?? { fields, refs: [] }
          read.refs.push(c.ref); reads.set(key, read)
        }
        if (reads.size) {
          const principal = await this.application.principal(agent, 'evidence_read', signal)
          for (const { fields, refs } of reads.values()) {
            let position: import('@retrieval-agent/contracts').TicketEvidenceResult['nextPosition']
            do {
              const result = await this.ctx.ticketRetrievalProvider.readEvidence(principal,
                { snapshotId: state.snapshot!.snapshotId, candidateRefs: refs, fields, tokenBudget: 8000, ...(position ? { position } : {}) }, signal ? { signal } : {})
              if (result.evidence.length || result.rejectedCandidateRefs.length) now = await this.application.updateExpert(agent, generation, { kind: 'evidence', result })
              position = result.nextPosition
            } while (position)
          }
        }
        return { rows: reads.size ? operatorRecords(now, batch) : rows, next_cursor: !requested && offset + size < candidates.length ? String(offset + size) : null }
      }
      throw new RetrievalError('INVALID_REQUEST', '算子资源回调未授权。')
    }, async value => {
      const event = object(value)
      if (event.type !== 'decision') throw new RetrievalError('PROTOCOL_MISMATCH', '过滤算子返回了无效事件。')
      pending.push(event.value as OperatorDecision)
      if (pending.length >= (event.value && (event.value as OperatorDecision).basis === 'proxy' ? 256 : batchSize)) await flush()
    }, signal)
    await flush()
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
      return { hits: operatorRecords(found, found.lastPage?.candidates ?? []).map(record => ({ record, score: null })),
        next_cursor: keyword ? found.lastPage?.nextCursor ?? null : null }
    }, async value => {
      const event = object(value)
      if (event.type !== 'candidate') throw new RetrievalError('PROTOCOL_MISMATCH', '搜索算子返回了无效事件。')
      validateOperatorRecords(this.application.current(agent), [event.record as OperatorRecord])
    }, signal)
    return this.application.current(agent)
  }
  async operate(agent: Agent, operation: 'sem_extract' | 'sem_agg',
    refs: readonly TicketCandidateRef[], instruction: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<import('@retrieval-agent/contracts').OperatorArtifact> {
    await this.application.ensureModelAccess(agent, signal)
    const state = await this.ensurePlan(agent, signal), generation = state.inputGeneration ?? 0, knowledge = await this.knowledge(state)
    if (!refs.length || new Set(refs).size !== refs.length || !instruction.trim()) throw new RetrievalError('INVALID_REQUEST', '算子需要非空、去重的当前候选和指令。')
    if (operation === 'sem_agg') {
      if (params.evidence_window !== undefined && (!Number.isSafeInteger(params.evidence_window) || Number(params.evidence_window) < 1 || refs.length > 2048)) throw new RetrievalError('INVALID_REQUEST', '证据窗口必须为正整数，命名证据池最多 2048 条。')
      if (params.evidence_window !== undefined && refs.some(ref => !state.selectedCandidateRefs.includes(ref))) throw new RetrievalError('INVALID_REQUEST', '案例证据窗口只能从已确认记录中选择。')
      params = { ...params, population_count: confirmedCount(state) }
    }
    const candidates = new Map(state.candidates.map(c => [c.ref, c]))
    const rows = operatorRecords(state, refs.map(ref => {
      const candidate = candidates.get(ref)
      if (!candidate) throw new RetrievalError('CANDIDATE_NOT_FOUND', '算子引用不属于当前候选。')
      return candidate
    }))
    const manifests: ContextManifest[] = [], events: unknown[] = []
    let checkedCandidates = state.candidates, checkedEvidence = state.promotedEvidence
    const current = async () => {
      signal?.throwIfAborted(); await this.application.loadTask(agent)
      const now = this.application.current(agent)
      if ((now.inputGeneration ?? 0) !== generation || now.retrievalId !== state.retrievalId || now.phase === 'stopped') throw new RetrievalError('INVALID_TRANSITION', '算子输入已过期。')
      // 计量、活动和回执更新不改变来源；仅在实际候选或正文变化后重新核验输入。
      if (now.candidates !== checkedCandidates || now.promotedEvidence !== checkedEvidence) {
        validateOperatorRecords(now, rows)
        checkedCandidates = now.candidates; checkedEvidence = now.promotedEvidence
      }
      return now
    }
    const metrics = await this.run(agent, this.runInput(agent, state, knowledge, operation,
      JSON.stringify({ original: state.query.original, predicate: state.query.contract!.semanticPlan!.instruction,
        user_feedback: state.userFeedback ?? [], operation_instruction: instruction, rule: '产物不修改工单事实，不自动确认候选；只处理已提供的集合或候选对。' }), params),
    async (method, payload) => {
      const now = await current(), p = object(payload)
      if (method === 'evidence.features') {
        const provider = this.ctx.ticketRetrievalProvider
        if (!provider.featureBlock || !provider.resolveFeatureIds) throw new RetrievalError('PROVIDER_UNAVAILABLE', '证据窗口数值特征尚未接通。')
        const selected = p.refs as TicketCandidateRef[]
        if (selected.some(ref => !refs.includes(ref))) throw new RetrievalError('CANDIDATE_NOT_FOUND', '证据池超出本次输入。')
        const principal = await this.application.principal(agent, 'detail_read', signal)
        const block = await provider.featureBlock(principal, { snapshotId: state.snapshot!.snapshotId, refs: selected, limit: selected.length }, signal ? { signal } : {})
        const sources = await provider.resolveFeatureIds(principal, { snapshotId: state.snapshot!.snapshotId, ids: block.ids }, signal ? { signal } : {})
        return { ...block, refs: sources.map(c => c.ref) }
      }
      if (method === 'rows.read') {
        if (p.handle !== 'current-candidates' || (p.cursor !== null && !/^\d+$/u.test(String(p.cursor)))) throw new RetrievalError('INVALID_REQUEST', '算子集合或游标无效。')
        const offset = p.cursor === null ? 0 : Number(p.cursor), size = this.application.reviewBatchSize
        return { rows: rows.slice(offset, offset + size), next_cursor: offset + size < rows.length ? String(offset + size) : null }
      }
      const start = manifests.length
      const reply = await this.modelCallback(agent, now, knowledge, manifests, method, payload, signal)
      for (const m of manifests.slice(start)) await this.application.updateExpert(agent, generation, { kind: 'manifest', manifest: m })
      return reply
    }, async value => {
      await current()
      if (operation === 'sem_agg') {
        const event = object(value), summary = object(event.value)
        const saved = await this.receipt(this.application.current(agent), String(summary.manifest_id))
        if (event.type !== 'aggregate' || !saved.aggregateReceipt || summary.text !== saved.aggregateReceipt.text) throw new RetrievalError('PROTOCOL_MISMATCH', '聚合产物与实际模型输出不一致。')
        const citations = summary.citations as import('@retrieval-agent/contracts').OperatorCitation[]
        const expected = (await this.aggregateRecords(this.application.current(agent), String(summary.manifest_id))).flatMap(r => r.passages.map(p => JSON.stringify([r.ref, r.version, r.content_hash, p.id, p.field, p.start, p.text, p.origin]))).sort()
        if (!Array.isArray(citations) || hash(citations.map(c => JSON.stringify([c.ref, c.version, c.content_hash, c.passage_id, c.field, c.start, c.quote, c.origin])).sort()) !== hash(expected)) {
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
