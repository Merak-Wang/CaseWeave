import { AsyncLocalStorage } from 'node:async_hooks'
import { readTaskKnowledge } from './knowledge-view.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool, type InferValue } from '@deepseek-ai/dsh-tools'
import { RetrievalError, type ExpertTask, type ExpertFinding, type TicketCandidateRef,
  type RetrievalState, type TicketSearchPage, type TicketEvidenceResult, type EvidencePosition, type TicketEvidenceId } from '@retrieval-agent/contracts'
import { EvidenceContextPolicy, applyQueryDelta, requireUserConstraints, estimateContextTokens } from '@retrieval-agent/domain'
import type { RetrievalAgentService } from './service.js'
import { DECISION_PARAMETERS, activeRef, evidenceRefs, exclusionChecksFromArguments } from './assessment.js'
import { openWiki, revokedKnowledge } from './wiki-store.js'
import { requestManifest } from './request-manifest.js'
import { compactRetrievalSurface } from './working-context.js'
import { inputContextTokens, installContextRecovery, requestTokens } from './context-recovery.js'
import { toolFailureSignature } from './context-budget.js'
import { EVIDENCE_REVIEW_POLICY } from './evidence-review-policy.js'

interface WikiEntry { id: string; reference: string; releaseId: string; bodyMarkdown: string; scope: string; limitations: string[]; evidenceChecklist: string[] }
interface Wiki { releaseId: string | null; warning?: string; catalog(): { id: string; title: string; knowledgeRefs: string[] }[];
  read(id: string): WikiEntry; search(query: string, options: { phase: string; domainIds?: string[]; limit?: number }): { id: string }[] }
const loadWiki = openWiki as (root: string, options?: { releaseId?: string }) => Promise<Wiki>
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
interface Branch { parent: Agent; task: ExpertTask; refs: TicketCandidateRef[]; wiki: WikiEntry[]; generation: number;
  evidencePosition?: EvidencePosition | undefined; evidenceIds?: readonly TicketEvidenceId[] | undefined; evidenceWindowOffset?: number | undefined }
interface ExpertBatch { generation: number; runs: Map<string, Promise<void>>; changed: Set<() => void>; abort: AbortController }
const EXPERT_POLICY = '你是工单检索领域专家。只执行分配目标与 scope；原始用户要求优先。先依据已收到的 cN 标题、摘要和结构化字段判断相关性，足以判断就直接 report；不要把每个候选升级为原文核查。只有具体事实缺失、来源矛盾或用户要求核实处理过程时才定向读取最小字段，复用主 Agent 已共享的 cN/eN。不同业务操作不可因相似障碍混同；知识用于解释业务，不能替代工单证据或更改用户要求。report 集中提交本领域逐条判断、简短事实理由、实际 cN/eN 引用及剩余缺口，不重复粘贴原文。摘要是 L1，不能冒充已核实原文。无法判断时返回 undetermined 并说明缺什么；常见业务含义自行判断，question 仅供主 Agent 处理确实依赖用户独有信息的缺口，无问题时省略。不要投票或发布最终结果，不得调用其他工具或创建子专家。'

const { required: _judgmentsRequired, ...expertJudgments } = DECISION_PARAMETERS.judgments
const { required: _gapsRequired, ...expertGaps } = DECISION_PARAMETERS.semantic_gaps
const EXPERT_PARAMETERS = {
        action: { type: 'string', required: true, enum: ['inspect', 'search', 'report'] },
        candidate_aliases: { type: 'array', items: { type: 'string' }, description: 'Required for inspect unless next_window=true. Use assigned or search-result cN aliases.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Only evidenceState.inspectFields are readable. fields=[] reloads L1; title is already in L1 and is not a source field.' },
        next_window: { type: 'boolean', description: 'inspect only: show the next already-read evidence window for this branch; to fetch unread source use position from evidenceState.nextPosition.' },
        query: { type: 'string' }, mode: { type: 'string', enum: ['keyword', 'dense'] },
        operator: { type: 'string', enum: ['or', 'and'], description: 'keyword only: space-separated terms match any term by default; and requires every term.' },
        search_key: { type: 'string', description: 'Continue the stored search returned previously, using its exact key.' },
        position: { type: 'object', additionalProperties: false, properties: { candidate_alias: { type: 'string', required: true },
          field: { type: 'string', required: true }, part: { type: 'integer', required: true }, start: { type: 'integer', required: true } } },
        judgments: { ...expertJudgments, description: 'Required for report. Omit for inspect/search; those actions only retrieve evidence.' },
        semantic_gaps: { ...expertGaps, description: 'Required for report; use [] when no substantive gap remains. Omit for inspect/search.' },
        counter_evidence_aliases: { type: 'array', items: { type: 'string' } }, next_action: { type: 'string', description: 'Required for report, even when this scope is complete: briefly say ready for main synthesis or identify the actual remaining action. Omit for inspect/search. Do not omit this field to signal completion.' },
        question: { type: 'string', description: 'Optional advisory question only if essential user-exclusive information is missing. Omit this field entirely when no question is needed; do not write none/无. Resolve ordinary business meanings from titles, summaries, Wiki and existing answers yourself.' },
        disagreement_kind: { type: 'string', enum: ['fact', 'business_scope', 'knowledge_conflict', 'coverage', 'source_conflict'] },
      } as const
type ExpertArguments = InferValue<{ type: 'object'; additionalProperties: false; properties: typeof EXPERT_PARAMETERS }>

/** DSH owns all model loops; this coordinator owns only product scope and committed artifacts. */
export class ExpertCoordinator {
  private readonly bindings = new WeakMap<Agent, Branch>()
  private readonly creating = new AsyncLocalStorage<Branch>()
  private readonly batches = new WeakMap<Agent, ExpertBatch>()
  private readonly wikis = new Map<string, Promise<Wiki>>()
  private readonly flights = new Map<string, Promise<TicketSearchPage>>()
  private readonly reads = new Map<string, Promise<TicketEvidenceResult>>()
  private readonly pendingMetrics = new WeakMap<Agent, Promise<void>>()
  private readonly repeatedReplies = new WeakMap<Agent, { reply: string; count: number }>()
  constructor(readonly ctx: Context, readonly application: RetrievalAgentService, readonly wikiRoot?: string) {
    application.coordinator = this
    ctx.get('skills')?.register({ name: 'retrieval-evidence-review', description: '受控来源取证、逐条判断和反例复核',
      source: 'bundled', content: `${EXPERT_POLICY}\n${EVIDENCE_REVIEW_POLICY}`, invocation: { modelInvocable: false, userInvocable: false } })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const creating = this.creating.getStore()
      if (creating && agent !== creating.parent && agent.session.header.parentSession === creating.parent.session.id) this.bindings.set(agent, creating)
      const decision = await next()
      const branch = this.bindings.get(agent)
      if (!branch || decision.kind === 'reject') return decision
      await this.pendingMetrics.get(agent)
      // A fast model can report before subagents.start() returns its handle.
      // Persist the executing session before any model/tool result can become visible.
      const task = this.current(branch).expertTasks!.find(t => t.id === branch.task.id)!
      if (task.childSessionId !== String(agent.session.id)) await this.application.updateExpert(branch.parent, branch.generation,
        { kind: 'task', taskId: task.id, patch: { childSessionId: String(agent.session.id) } })
      compactRetrievalSurface(agent, { contextWindow: agent.session.requestContext()?.contextWindow ?? application.modelContextTokenLimit(branch.parent) ?? 32000 })
      // Errors do not contain a source window. Rebuild from this branch's durable cursor on every model step.
      const rendered = await this.context(branch)
      return { kind: 'enter' as const, messages: [createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
        sections: [{ name: 'retrieval-agent:expert-state', text: rendered }] }, content: [{ type: 'text', text: rendered }] })] }
    }, { prepend: true, global: true })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      const expert = context.agent && (this.isExpert(context.agent) || (context.agent.session.header.origin === 'subagent' && this.creating.getStore()))
      // A different task's coordinator must not strip this child's scoped tool.
      if (!expert && context.agent?.session.header.origin === 'subagent') return result
      return { ...result, tools: result.tools.filter(tool => expert ? tool.name === 'ticket_expert' : tool.name !== 'ticket_expert') }
    }, { global: true })
    this.installTool()
    ctx.on('tools/result', (exec, result) => {
      const child = exec.agent, branch = child && this.bindings.get(child)
      if (!child || !branch || exec.name !== 'ticket_expert') return
      const record = async () => {
        const state = this.current(branch), task = state.expertTasks!.find(t => t.id === branch.task.id)!
        if (task.status !== 'running') return
        if (!result.isError) this.repeatedReplies.delete(child)
        const signature = result.isError ? toolFailureSignature(exec.name, exec.arguments, result.error.message, state) : ''
        const count = result.isError ? (task.repeatedToolFailure?.signature === signature ? task.repeatedToolFailure.count : 0) + 1 : 0
        await this.application.updateExpert(branch.parent, branch.generation, { kind: 'task', taskId: task.id,
          patch: { repeatedToolFailure: { signature, count } } })
      }
      const prior = this.pendingMetrics.get(child)
      const work = (prior ? prior.then(record) : record()).catch(error => { ctx.logger.warn('expert tool metric failed', error) })
      this.pendingMetrics.set(child, work)
      void work.finally(() => { if (this.pendingMetrics.get(child) === work) this.pendingMetrics.delete(child) })
    }, { global: true })
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const branch = this.bindings.get(agent)
      if (!branch || signal.aborted) return
      await this.pendingMetrics.get(agent)
      const task = this.current(branch).expertTasks!.find(t => t.id === branch.task.id)!
      if (task.status !== 'running' || task.finding || (task.repeatedToolFailure?.count ?? 0) >= 4) return
      const last = [...agent.session.snapshotEvents()].reverse().find(e => e.type === 'assistant/message')
      const reply = last?.type === 'assistant/message' ? JSON.stringify(last.data.message.content) : ''
      const previous = this.repeatedReplies.get(agent)
      const count = previous?.reply === reply ? previous.count + 1 : 1
      this.repeatedReplies.set(agent, { reply, count })
      if (count >= 3) return
      const text = '尚未提交专家产物。请继续使用 ticket_expert：缺少事实就 inspect/search，已完成分配范围则 report 提交逐条 judgments、semantic_gaps 和 next_action。文字答复不能替代 report；不要因调用次数或耗时而放弃未完成的核查。'
      agent.inject(createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
        sections: [{ name: 'retrieval-agent:expert-repair', text }] }, content: [{ type: 'text', text }] }))
    })
    installContextRecovery(ctx, { owns: agent => this.bindings.has(agent),
      limit: agent => agent.session.requestContext()?.contextWindow ?? application.modelContextTokenLimit(this.bindings.get(agent)!.parent) ?? 32000,
      render: (agent, budget) => this.context(this.bindings.get(agent)!, budget) })
    ctx.on('llm/stream', (options, next) => {
      const child = options.sessionId ? ctx.agents.get(options.sessionId) : undefined
      const branch = child && this.bindings.get(child)
      if (!branch || options.purpose !== undefined) return next()
      const coordinator = this
      return (async function* () {
        await coordinator.pendingMetrics.get(child!)
        const state = coordinator.current(branch)
        const currentTask = state.expertTasks!.find(t => t.id === branch.task.id)!
        if ((currentTask.repeatedToolFailure?.count ?? 0) >= 4) {
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }; return
        }
        const measured = requestTokens(ctx, options)
        const capacity = child!.session.requestContext()?.contextWindow ?? application.modelContextTokenLimit(branch.parent) ?? 32000
        if (measured + (options.maxTokens ?? 2048) + 512 > capacity) throw new RetrievalError('CAPACITY_EXCEEDED', '专家上下文容量不足，保留来源并转交主 Agent。')
        await application.updateExpert(branch.parent, branch.generation, { kind: 'manifest', manifest: requestManifest(state, options, branch.task.id, measured) })
        let input = 0, output = 0
        for await (const chunk of next()) {
          if (chunk.type === 'usage') { input = inputContextTokens(chunk.usage); output = chunk.usage.outputTokens }
          yield chunk
        }
        const task = coordinator.current(branch).expertTasks!.find(t => t.id === branch.task.id)!
        await application.updateExpert(branch.parent, branch.generation, { kind: 'task', taskId: task.id, patch: {
          modelSteps: (task.modelSteps ?? 0) + 1, inputTokens: (task.inputTokens ?? 0) + input, outputTokens: (task.outputTokens ?? 0) + output } })
      })()
    }, { global: true })
  }
  isExpert(agent: Agent): boolean { return this.bindings.has(agent) || Boolean(this.creating.getStore() && agent.session.header.origin === 'subagent') }
  knowledgeView(state: RetrievalState, entryId?: string) { return readTaskKnowledge(this.wikiRoot, state, entryId) }
  private wiki(state: RetrievalState): Promise<Wiki> {
    const key = `${state.retrievalId}:${state.knowledgeCatalog?.releaseId ?? 'current'}`
    let result = this.wikis.get(key)
    if (!result) {
      result = loadWiki(this.wikiRoot ?? '__retrieval_wiki_not_configured__', state.knowledgeCatalog?.releaseId ? { releaseId: state.knowledgeCatalog.releaseId } : {})
      this.wikis.set(key, result)
    }
    return result
  }
  async prepare(agent: Agent, signal?: AbortSignal): Promise<void> {
    const state = this.application.currentOrUndefined(agent)
    if (!state?.lastPage || state.phase === 'stopped' || this.isExpert(agent)) return
    await this.validateKnowledge(agent)
    if (state.knowledgeCatalog) return
    signal?.throwIfAborted()
    try {
      const wiki = await this.wiki(state)
      await this.application.updateExpert(agent, state.inputGeneration ?? 0, { kind: 'catalog', catalog: {
        status: wiki.releaseId ? 'available' : 'empty', ...(wiki.releaseId ? { releaseId: wiki.releaseId } : {}), ...(wiki.warning ? { warning: wiki.warning } : {}),
        domains: wiki.catalog().map(d => ({ id: d.id, description: d.title, entryIds: d.knowledgeRefs })) } })
    } catch (error) {
      if (error instanceof RetrievalError || signal?.aborted) throw error
      await this.application.updateExpert(agent, state.inputGeneration ?? 0, { kind: 'catalog', catalog: {
        status: 'disabled', warning: '知识发布校验失败，本任务使用零样本取证。', domains: [] } })
    }
  }
  async runPending(agent: Agent, signal?: AbortSignal): Promise<void> {
    if (this.isExpert(agent)) return
    signal?.throwIfAborted()
    const state = this.application.currentOrUndefined(agent)
    if (!state || state.phase === 'stopped') return
    const generation = state.inputGeneration ?? 0
    let batch = this.batches.get(agent)
    if (batch && batch.generation !== generation) { batch.abort.abort(); batch.changed.forEach(notify => notify()); batch = undefined }
    const pending = state.expertTasks?.filter(t => t.inputGeneration === generation && ['pending', 'running'].includes(t.status)) ?? []
    if (!pending.length) return
    if (!batch) { batch = { generation, abort: new AbortController(), runs: new Map(), changed: new Set() }; this.batches.set(agent, batch) }
    if (batch.abort.signal.aborted) return
    const owned = batch
    // The coordinator owns branch lifetimes, not the short-lived delegate tool call.
    // Bounded model concurrency; newly queued assignments start when a slot frees.
    for (const task of pending.filter(t => !owned.runs.has(t.id)).slice(0, Math.max(0, 3 - owned.runs.size))) {
      const work = Promise.resolve().then(() => this.run(agent, task, owned.abort.signal)).finally(async () => {
        owned.runs.delete(task.id)
        owned.changed.forEach(notify => notify())
        if (!owned.abort.signal.aborted && this.batches.get(agent) === owned) await this.runPending(agent)
      })
      owned.runs.set(task.id, work)
      // run() persists branch failures. Cancellation/generation fences also settle waiters.
      void work.catch(() => {})
    }
  }
  /** Suspend without model polling. Wake on the first requested terminal finding, not the whole batch. */
  async waitForExperts(agent: Agent, taskIds: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.runPending(agent, signal)
    const state = this.application.current(agent), generation = state.inputGeneration ?? 0
    const tasks = state.expertTasks?.filter(t => t.inputGeneration === generation) ?? []
    if (!taskIds.length || taskIds.some(id => !tasks.some(t => t.id === id))) throw new RetrievalError('INVALID_REQUEST', 'task_ids 必须是当前 experts.tasks 的非空分支 ID 列表。只等待尚未完成且下一步依赖的分支；不要重复委派。')
    const batch = this.batches.get(agent)
    if (!batch) return
    const ready = (): boolean => {
      const current = this.application.current(agent)
      return batch.abort.signal.aborted || current.phase === 'stopped' || current.inputGeneration !== state.inputGeneration
        || taskIds.some(id => !current.expertTasks?.some(t => t.id === id && ['pending', 'running'].includes(t.status)))
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { batch.changed.delete(check); signal?.removeEventListener('abort', abort) }
      const check = (): void => { if (ready()) { cleanup(); resolve() } }
      const abort = (): void => { cleanup(); reject(signal?.reason ?? new Error('cancelled')) }
      batch.changed.add(check); signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort(); else check()
    })
    signal?.throwIfAborted()
  }
  async validateKnowledge(agent: Agent): Promise<void> {
    if (!this.wikiRoot) return
    const state = this.application.current(agent)
    const refs = state.expertTasks?.filter(t => t.inputGeneration === (state.inputGeneration ?? 0) && t.status !== 'failed').flatMap(t => t.knowledgeRefs) ?? []
    if (!refs.length) return
    const revoked = await revokedKnowledge(this.wikiRoot, refs)
    if (!revoked.length) return
    const wiki = await loadWiki(this.wikiRoot)
    await this.application.updateExpert(agent, state.inputGeneration ?? 0, { kind: 'knowledge_invalidated', references: revoked,
      catalog: { status: wiki.releaseId ? 'available' : 'empty', ...(wiki.releaseId ? { releaseId: wiki.releaseId } : {}),
        warning: '旧知识已停用，受影响分支需要依据当前来源重新复核。',
        domains: wiki.catalog().map(d => ({ id: d.id, description: d.title, entryIds: d.knowledgeRefs })) } })
  }
  /** Keep the worker lease alive while independent children finish after main asks a question. */
  cancelPending(agent: Agent): void {
    const batch = this.batches.get(agent); if (batch) { batch.abort.abort(); batch.changed.forEach(notify => notify()) }
  }
  async settlePending(agent: Agent, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const batch = this.batches.get(agent)
      if (!batch?.runs.size) break
      await Promise.allSettled(batch.runs.values())
      signal?.throwIfAborted()
    }
    signal?.throwIfAborted()
  }
  private current(branch: Branch): RetrievalState {
    const state = this.application.current(branch.parent)
    if ((state.inputGeneration ?? 0) !== branch.generation || state.phase === 'stopped') throw new RetrievalError('INVALID_TRANSITION', '输入条件或任务执行权已变化。')
    return state
  }
  private async context(branch: Branch, tokenBudget?: number): Promise<string> {
    await this.validateKnowledge(branch.parent)
    let state = this.current(branch)
    if (state.expertTasks?.find(t => t.id === branch.task.id)?.status === 'failed') throw new RetrievalError('INVALID_REQUEST', '专家知识已停用，需重新读取当前来源。')
    const position = { candidateRefs: branch.refs, ...(branch.evidencePosition ? { evidencePosition: branch.evidencePosition } : {}),
      evidenceIds: branch.evidenceIds ?? [], evidenceWindowOffset: branch.evidenceWindowOffset ?? 0 }
    if (JSON.stringify(state.expertTasks!.find(t => t.id === branch.task.id)!.context) !== JSON.stringify(position)) {
      state = await this.application.updateExpert(branch.parent, branch.generation, { kind: 'task', taskId: branch.task.id, patch: { context: position } })
    }
    const policy = new EvidenceContextPolicy({ role: 'expert' })
    const prior = (state.contextManifests ?? []).filter(m => m.roleId === branch.task.id && m.inputGeneration === branch.generation)
    const { knowledgeCatalog: _catalog, ...roleBase } = state
    const roleState: RetrievalState = { ...roleBase, contextCandidateRefs: branch.refs.slice(-8), expertTasks: [], expertConflicts: [],
      judgments: [], evidenceReadPosition: branch.evidencePosition, evidenceWindowOffset: branch.evidenceWindowOffset ?? 0,
      progress: { ...state.progress, newEvidenceIds: branch.evidenceIds ?? [] },
      modelVisibleCandidateRefs: prior.flatMap(m => m.candidateRefs), modelVisibleEvidenceIds: prior.flatMap(m => m.evidenceIds) }
    const currentTask = state.expertTasks!.find(t => t.id === branch.task.id)!
    const knowledge = `<untrusted_retrieval_knowledge>${JSON.stringify({ taskId: branch.task.id, goal: branch.task.goal,
      scope: branch.task.scope, assignedCandidateAliases: branch.task.candidateRefs.map(ref => `c${state.candidateHistory.findIndex(c => c.ref === ref) + 1}`),
      actionsUsed: currentTask.actionsUsed, modelRequests: currentTask.modelSteps ?? 0,
      reportRequirement: '按事实缺口决定是否继续搜索/读取；完成分配范围后集中 report。无固定动作或模型请求次数截止，不因耗时宣布完成。相同参数与错误连续重复且没有进展才识别为循环。',
      releaseId: branch.task.releaseId, entries: branch.wiki })}</untrusted_retrieval_knowledge>`
    const cap = tokenBudget ?? this.application.contextTokenBudget ?? this.application.workingContextBudget(branch.parent)
    const selection = policy.select(roleState, cap - estimateContextTokens(knowledge))
    const rendered = `${selection.rendered}\n${knowledge}`
    const manifest = { ...selection.manifest!, id: digest(`${branch.task.id}:${state.stateId}:${rendered}`), roleId: branch.task.id,
      knowledgeRefs: branch.wiki.map(e => e.reference), ...(branch.task.releaseId ? { releaseId: branch.task.releaseId } : {}),
      renderedHash: digest(rendered), estimatedTokens: estimateContextTokens(rendered), tokenBudget: cap }
    await this.application.updateExpert(branch.parent, branch.generation, { kind: 'manifest', manifest })
    return rendered
  }
  private async run(parent: Agent, task: ExpertTask, signal = new AbortController().signal): Promise<void> {
    let run: Awaited<ReturnType<Context['subagents']['start']>> | undefined
    // Seed only assigned, already authorized source identities; the child's actual request still records visibility.
    const sharedEvidence = this.application.current(parent).promotedEvidence.filter(e => task.candidateRefs.includes(e.candidateRef)).map(e => e.evidenceId)
    const branch: Branch = { parent, task, refs: [...(task.context?.candidateRefs ?? task.candidateRefs)], wiki: [], generation: task.inputGeneration,
      evidencePosition: task.context?.evidencePosition, evidenceIds: task.context?.evidenceIds ?? sharedEvidence, evidenceWindowOffset: task.context?.evidenceWindowOffset }
    try {
      const subagents = this.ctx.get('subagents')
      if (!subagents) throw new Error('DSH spawn provider is unavailable')
      const state = this.current(branch)
      if (task.releaseId && state.knowledgeCatalog?.status === 'available') {
        const wiki = await this.wiki(state)
        if (wiki.releaseId !== task.releaseId) throw new Error('Pinned Wiki release unavailable')
        const domain = wiki.catalog().find(d => d.id === task.domainId)
        const ids = task.knowledgeIds ?? (domain ? wiki.search(`${state.query.original} ${task.goal}`, { phase: 'post-fast-query', domainIds: [domain.id], limit: 3 }).map(e => e.id) : [])
        if (ids.length > 3 || ids.some(id => !domain?.knowledgeRefs.includes(id))) throw new RetrievalError('INVALID_REQUEST', '知识条目不属于分配领域或超过本轮 3 条额度。')
        branch.wiki = ids.map(id => wiki.read(id))
      }
      await this.application.updateExpert(parent, branch.generation, { kind: 'task', taskId: task.id, patch: {
        status: 'running', knowledgeRefs: branch.wiki.map(e => e.reference), activity: { kind: 'starting', at: new Date().toISOString() } } })
      const prompt = await this.context(branch)
      const skill = await this.ctx.get('skills')?.get('retrieval-evidence-review')
      run = await this.creating.run(branch, () => subagents.start('spawn', { parent, signal,
        label: `检索专家：${task.domainId}`, persona: skill?.content ?? `${EXPERT_POLICY}\n${EVIDENCE_REVIEW_POLICY}`, maxDepth: 1,
        toolFilter: { allow: ['ticket_expert'] }, prompt: [{ type: 'text', text: prompt }] }))
      if (run.localAgent) this.bindings.set(run.localAgent, branch)
      if (!run.localAgent) await this.application.updateExpert(parent, branch.generation, { kind: 'task', taskId: task.id, patch: { childSessionId: String(run.id) } })
      const result = await run.result
      signal.throwIfAborted()
      const finished = this.current(branch).expertTasks!.find(t => t.id === task.id)!
      if (!finished.finding) {
        if ((finished.repeatedToolFailure?.count ?? 0) >= 4) throw new RetrievalError('BUDGET_EXHAUSTED', '专家相同参数和错误连续重复四次且没有新证据或有效动作，检测到工具调用死循环；保留证据供主 Agent 接手。')
        if (run.localAgent && (this.repeatedReplies.get(run.localAgent)?.count ?? 0) >= 3) throw new RetrievalError('BUDGET_EXHAUSTED', '专家重复相同文字答复且未提交有效动作，检测到无进展循环；保留证据供主 Agent 接手。')
        throw new Error(`专家结束但没有有效的逐条产物：${result.stopReason}`)
      }
    } catch (error) {
      if (signal.aborted || (this.application.currentOrUndefined(parent)?.inputGeneration ?? 0) !== branch.generation) return
      await this.application.updateExpert(parent, branch.generation, { kind: 'task', taskId: task.id, patch: {
        status: 'failed', failure: error instanceof RetrievalError ? error.publicMessage : '专家运行未完成，保留候选与已读取证据供主 Agent 继续。' } })
    } finally { await run?.dispose() }
  }
  private installTool(): void {
    this.ctx.tools.register(defineTool({ name: 'ticket_expert', description: 'Judge the assigned scope from received cN titles/summaries first and report directly when sufficient. Inspect source only for a concrete missing fact or contradiction, using a small candidate/field set; reuse shared eN evidence. Search for a substantive coverage gap. Wiki guides interpretation and cannot substitute for ticket evidence.',
      parameters: EXPERT_PARAMETERS,
      output: { schema: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.state }] },
      async execute(args, exec) { return coordinator.execute(args, exec) },
    }))
    const coordinator = this
  }
  private async execute(args: ExpertArguments, exec: import('@deepseek-ai/dsh-tools').ToolRunContext): Promise<{ state: string }> {
    const branch = exec.agent && (this.bindings.get(exec.agent) ?? this.creating.getStore())
    if (!branch || exec.agent === branch.parent || exec.agent?.session.header.parentSession !== branch.parent.session.id) throw new RetrievalError('UNAUTHORIZED', '工具只供当前分配的 DSH 子 Agent 使用。')
    await this.validateKnowledge(branch.parent)
    let state = this.current(branch)
    const task = state.expertTasks!.find(t => t.id === branch.task.id)!
    if (task.status !== 'running') throw new RetrievalError('INVALID_TRANSITION', '专家分支已结束或已被新输入替代。')
    await this.application.updateExpert(branch.parent, branch.generation, { kind: 'task', taskId: task.id,
      patch: { actionsUsed: task.actionsUsed + 1, activity: { kind: args.action, at: new Date().toISOString(), ...(args.query ? { query: args.query } : {}) } } })
    const aliases = (a: string[]): TicketCandidateRef[] => a.map(alias => activeRef(state, alias))
    if (args.action === 'report') {
      if (!args.judgments || !args.semantic_gaps) throw new RetrievalError('INVALID_REQUEST', 'report 必须包含 judgments 和 semantic_gaps；没有未决缺口时用 semantic_gaps=[]。inspect/search 不需要这两个字段。')
      const finding: ExpertFinding = { id: `finding-${randomUUID()}`, taskId: task.id, inputGeneration: branch.generation,
        judgments: args.judgments.map((j) => ({ candidateRef: activeRef(state, j.candidate_alias), verdict: j.verdict,
          evidenceRefs: evidenceRefs(state, j.evidence_aliases), reason: j.reason, ...exclusionChecksFromArguments(state, j.exclusion_checks) })),
        gaps: args.semantic_gaps.map((g) => ({ kind: g.kind, status: g.status, evaluator: 'model', description: g.description, evidenceRefs: evidenceRefs(state, g.evidence_aliases) })),
        counterEvidenceRefs: evidenceRefs(state, args.counter_evidence_aliases ?? []), nextAction: args.next_action ?? '',
        ...(args.question ? { question: args.question } : {}), ...(args.disagreement_kind ? { disagreementKind: args.disagreement_kind } : {}) }
      await this.application.updateExpert(branch.parent, branch.generation, { kind: 'finding', finding })
      this.batches.get(branch.parent)?.changed.forEach(notify => notify())
      exec.concludeTurn(); return { state: JSON.stringify({ findingId: finding.id, status: 'submitted_for_main_review' }) }
    }
    // Resolve the current parent authorization before reusing shared I/O.
    const principal = await this.application.principal(branch.parent, 'detail_read', exec.signal)
    if (!state.snapshot) throw new RetrievalError('SNAPSHOT_INVALID', '专家没有有效快照。')
    const status = await this.ctx.ticketRetrievalProvider.status(principal, state.snapshot.snapshotId)
    if (!status.ready || status.snapshotValid === false) throw new RetrievalError('SNAPSHOT_INVALID', '共享证据的来源或访问资格已失效。')
    let extra: unknown
    if (args.action === 'inspect') {
      if (args.next_window) {
        if (args.position || args.fields?.length || args.candidate_aliases?.length) throw new RetrievalError('INVALID_REQUEST', 'next_window 只能单独选择已读取证据视窗。')
        branch.evidenceWindowOffset = (branch.evidenceWindowOffset ?? 0) + 12
        return { state: await this.context(branch) }
      }
      const refs = aliases(args.candidate_aliases ?? [])
      const fields: string[] = args.fields ?? []
      if (!refs.length || refs.length > 8) throw new RetrievalError('INVALID_REQUEST', '专家视窗需指定 1–8 个有效候选。')
      const allowed = state.snapshot.fieldCatalog.filter(f => ['L1', 'L2', 'L3'].includes(f.accessLevel) && f.valueKind !== 'raw_json').map(f => f.key)
      if (fields.some(field => !allowed.includes(field))) throw new RetrievalError('INVALID_REQUEST', `字段不可读；fields 只能从以下选择：${allowed.join(', ')}。title 已在 L1 概览中，fields=[] 可重读概览。`)
      branch.refs = refs
      branch.evidenceWindowOffset = 0
      if (fields.length) {
        const request = { snapshotId: state.snapshot.snapshotId, candidateRefs: refs, fields, tokenBudget: 2400,
          ...(args.position ? { position: { candidateRef: activeRef(state, args.position.candidate_alias), field: args.position.field,
            part: args.position.part, start: args.position.start } } : {}) }
        const key = digest(JSON.stringify([state.retrievalId, branch.generation, request]))
        let read = this.reads.get(key)
        if (!read) { read = this.ctx.ticketRetrievalProvider.readEvidence(principal, request, { signal: exec.signal }); this.reads.set(key, read) }
        let result: TicketEvidenceResult
        try { result = await read } catch (error) { this.reads.delete(key); throw error }
        if (result.evidence.some(e => !refs.includes(e.candidateRef) || !fields.includes(e.field))) throw new RetrievalError('PROTOCOL_MISMATCH', '专家读取响应越界。')
        await this.application.updateExpert(branch.parent, branch.generation, { kind: 'evidence', result })
        branch.evidencePosition = result.nextPosition
        branch.evidenceIds = result.evidence.map(e => e.evidenceId)
        extra = { warnings: result.warnings }
      }
    } else {
      const previous = args.search_key ? state.sharedSearches?.find(s => s.key === args.search_key && s.inputGeneration === branch.generation) : undefined
      if (args.search_key && !previous?.page.nextCursor) throw new RetrievalError('INVALID_REQUEST', '专家搜索没有可继续的当前游标。')
      if (!previous && (!args.query?.trim() || args.query.length > 2000)) throw new RetrievalError('INVALID_REQUEST', '搜索需要具体的关键词或语义表达。')
      const mode = previous?.spec.mode ?? args.mode ?? 'dense'
      if (args.operator && (mode !== 'keyword' || previous)) throw new RetrievalError('INVALID_REQUEST', 'operator 只用于新的 keyword 搜索，不能更改已有搜索游标。')
      const spec = previous?.spec ?? { ...applyQueryDelta(state.query.spec, mode === 'keyword'
        ? { kind: 'batch', changes: [{ kind: 'replace_terms', terms: (args.query ?? '').trim().split(/\s+/u), operator: args.operator ?? 'or' }] }
        : { kind: 'rewrite_semantic_query', text: args.query ?? '' }), mode }
      requireUserConstraints(state, spec)
      const key = digest(JSON.stringify([state.retrievalId, state.snapshot.snapshotId, branch.generation, spec, previous?.page.nextCursor]))
      let page = state.sharedSearches?.find(s => s.key === key)?.page
      if (!page) {
        let flight = this.flights.get(key)
        if (!flight) {
          flight = (async () => {
            const p = await this.ctx.ticketRetrievalProvider.search(principal, state.snapshot!.snapshotId, spec, { topK: 20, maxScan: 50000,
              stage: previous ? 'next_page' : 'repair_search', signal: exec.signal, ...(previous?.page.nextCursor ? { cursor: previous.page.nextCursor } : {}) })
            await this.application.updateExpert(branch.parent, branch.generation, { kind: 'search', taskId: task.id, key, spec, page: p })
            return p
          })(); this.flights.set(key, flight)
        }
        try { page = await flight } finally { this.flights.delete(key) }
      }
      branch.refs = page.candidates.slice(0, 8).map(c => c.ref)
      extra = { searchKey: key, returned: page.returned, nextPageAvailable: Boolean(page.nextCursor), resultPagesExhausted: page.boundary.resultPagesExhausted }
    }
    state = this.current(branch)
    return { state: `${await this.context(branch)}\n${JSON.stringify(extra ?? {})}` }
  }
}
