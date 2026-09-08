import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RetrievalId, RetrievalError, type RetrievalState, type TicketRetrievalRequest, type RetrievalDecision,
  type EvidenceContextSelection, type CandidateDetailReadReceipt, type TicketDetailResult, type CandidateExportReceipt } from '@retrieval-agent/contracts'
import { RetrievalController, type RetrievalClarificationAnswer, type RetrievalSearchInput } from '@retrieval-agent/domain'
import { compileUserConditions, compileUserResultPolicy } from '@retrieval-agent/query-understanding'
import { randomUUID } from 'node:crypto'
import { appendRetrievalSessionEvent, readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import { RetrievalAgentService, type RetrievalAgentServiceConfig } from './service.js'
import { MySqlTaskStore, TaskJournal, staleTask, taskOwner, type TaskRecord, type TaskJob } from './task-store.js'

/** Same DSH tools and Controller, with MySQL-owned state and optimistic, short commits. */
export class DurableRetrievalAgentService extends RetrievalAgentService {
  learning?: { run(agent: Agent, job: TaskJob, signal: AbortSignal): Promise<void> }
  readonly store: MySqlTaskStore
  private readonly states = new WeakMap<Agent, TaskRecord>()
  private readonly jobs = new WeakMap<Agent, TaskJob>()
  private readonly mirrorFlights = new WeakMap<Agent, Promise<void>>()
  private readonly persistentConfig: RetrievalAgentServiceConfig
  constructor(ctx: Context, config: RetrievalAgentServiceConfig, store: MySqlTaskStore) {
    super(ctx, config); this.store = store; this.persistentConfig = config
  }
  override currentOrUndefined(agent: Agent): RetrievalState | undefined { return this.states.get(agent)?.state_json ?? undefined }
  override current(agent: Agent): RetrievalState {
    const state = this.currentOrUndefined(agent)
    if (!state) throw new RetrievalError('INVALID_TRANSITION', '任务尚未产生检索状态。')
    return state
  }
  override async loadTask(agent: Agent): Promise<void> {
    const task = await this.executionTask(agent)
    if (task) this.states.set(agent, task)
  }
  override async updateExpert(agent: Agent, generation: number, update: import('@retrieval-agent/domain').ExpertUpdate): Promise<RetrievalState> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.execute(agent, async (c, s) => c.expertUpdate(s, generation, update)) }
      catch (error) {
        if (attempt >= 12 || !(error instanceof RetrievalError) || !error.retryable
          || (this.currentOrUndefined(agent)?.inputGeneration ?? 0) !== generation) throw error
      }
    }
  }
  private async executionTask(agent: Agent): Promise<TaskRecord | undefined> {
    const job = this.jobs.get(agent)
    return job ? this.store.read(job.task_id) : this.store.forSession(String(agent.session.id))
  }
  private async executionIdentity(agent: Agent): Promise<Pick<TaskRecord, 'id' | 'owner_hash'> | undefined> {
    await this.store.ready
    const job = this.jobs.get(agent)
    return (await this.store.rows<Pick<TaskRecord, 'id' | 'owner_hash'>>(job
      ? 'SELECT id,owner_hash FROM ra_task WHERE id=?'
      : 'SELECT id,owner_hash FROM ra_task WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [job?.task_id ?? String(agent.session.id)]))[0]
  }
  override async stateForTask(agent: Agent, retrievalId: RetrievalId): Promise<RetrievalState | undefined> {
    const task = await this.store.read(retrievalId)
    if (!task || task.session_id !== String(agent.session.id)) return undefined
    return task.state_json ?? undefined
  }
  async mirror(agent: Agent): Promise<void> {
    const active = this.mirrorFlights.get(agent)
    if (active) return active
    const work = this.copyMirror(agent)
    this.mirrorFlights.set(agent, work)
    try { await work } finally { if (this.mirrorFlights.get(agent) === work) this.mirrorFlights.delete(agent) }
  }
  private async copyMirror(agent: Agent): Promise<void> {
    const mirrored = readRetrievalSessionEvents(agent.session)
    const existing = new Set(mirrored.map(e => e.eventId))
    // Recover a crash after outbox acknowledgement but before the DSH file flush as well.
    const tasks = await this.store.rows<Pick<TaskRecord, 'id' | 'event_seq'>>('SELECT id,event_seq FROM ra_task WHERE session_id=? ORDER BY created_at,id', [String(agent.session.id)])
    for (const task of tasks) {
      // Derive the checkpoint from the actual Session, including gaps after an interrupted flush.
      // Only hydrate the missing suffix; no process-local acknowledgement can hide lost events.
      const sequences = new Set(mirrored.filter(e => e.retrievalId === task.id).map(e => e.sequence))
      let afterSequence = -1
      while (sequences.has(afterSequence + 1)) afterSequence++
      for (const event of await this.store.domainEvents(task.id, this.store.pool, afterSequence)) {
        if (!existing.has(event.eventId)) { appendRetrievalSessionEvent(agent.session, event); existing.add(event.eventId) }
      }
      await this.store.delivered(task.id, task.event_seq)
    }
  }
  async withJob<T>(agent: Agent, job: TaskJob, work: () => Promise<T>): Promise<T> {
    if (this.jobs.has(agent)) throw staleTask()
    this.jobs.set(agent, job)
    try { return await work() } finally {
      if (this.jobs.get(agent) === job) { this.jobs.delete(agent); await this.loadTask(agent) }
    }
  }
  driveAllowed(agent: Agent): boolean { return this.jobs.get(agent)?.kind === 'agent' }
  async receiveUserInput(agent: Agent, text: string, operationId: string): Promise<void> {
    const principal = await this.resolve(agent, 'search')
    const received = await this.store.rows<{ command_json: { text?: string } }>('SELECT c.command_json FROM ra_task_command c JOIN ra_task t ON t.id=c.task_id WHERE t.session_id=? AND c.operation_id=?', [String(agent.session.id), operationId])
    if (received.length) {
      if (received[0]!.command_json.text !== undefined && received[0]!.command_json.text !== text) throw new RetrievalError('INVALID_REQUEST', '已保存消息的内容不能改变。')
      await this.loadTask(agent); return
    }
    const task = await this.store.forSession(String(agent.session.id))
    const newTask = /^(?:新任务|另一个任务|重新检索|new task)\s*[:：]?/iu.test(text.trim())
    if (!task || newTask) {
      if (task) await this.store.submit(task.id, principal, `${operationId}:cancel`, { kind: 'cancel' })
      await this.store.create(randomUUID(), String(agent.session.id), principal, text, operationId)
    } else if (/^(?:取消|停止|算了|cancel|stop)[。.!！\s]*$/iu.test(text.trim())) {
      await this.store.submit(task.id, principal, operationId, { kind: 'cancel' })
    } else {
      const information = compileTaskInformation(text)
      const question = await this.store.question(task.id)
      await this.store.submit(task.id, principal, operationId, question
        ? { kind: 'answer', text, information, questionId: question.id }
        : { kind: 'supplement', text, information })
    }
    await this.loadTask(agent)
  }
  private async resolve(agent: Agent, operation: 'snapshot_open' | 'search' | 'evidence_read' | 'detail_read' | 'export', signal?: AbortSignal) {
    const principal = await this.ctx.ticketPrincipalProvider.resolve({ sessionId: String(agent.session.id), operation }, signal ? { signal } : undefined)
    const task = await this.executionIdentity(agent)
    if (task && task.owner_hash !== taskOwner(principal)) throw new RetrievalError('UNAUTHORIZED', '当前身份无权访问任务。')
    return principal
  }
  private async execute(agent: Agent, work: (controller: RetrievalController, state: RetrievalState, journal: TaskJournal) => Promise<RetrievalState>,
    options: { start?: boolean; information?: readonly RetrievalClarificationAnswer[]; semantic?: boolean; taskId?: string } = {}): Promise<RetrievalState> {
    const execution = options.taskId ? undefined : await this.executionTask(agent)
    const active = execution ?? await this.executionIdentity(agent)
    let base = options.taskId ? await this.store.read(options.taskId) : execution
    if (base && base.session_id !== String(agent.session.id)) throw new RetrievalError('UNAUTHORIZED', '任务不属于此会话。')
    if (!base || (!base.state_json && !options.start)) throw new RetrievalError('INVALID_TRANSITION', '当前任务尚未开始。')
    const journal = new TaskJournal([], await this.store.domainEventCount(base.id))
    let committed = 0
    const job = options.taskId ? undefined : this.jobs.get(agent)
    if (job && job.input_revision !== base.input_revision) throw staleTask()
    const commit = async (state: RetrievalState): Promise<void> => {
      if (state.stateId === base!.state_json?.stateId && journal.pending.length === committed) return
      base = await this.store.commit(base!, state, journal.pending.slice(committed), job, options.semantic ?? true)
      committed = journal.pending.length
      if (active?.id === base.id) this.states.set(agent, base)
      // Mirror delivery is recoverable and cannot roll back or replace the authoritative commit.
      try { await this.mirror(agent) } catch { /* persistent outbox is drained by the Host */ }
    }
    const controller = new RetrievalController(this.ctx.ticketRetrievalProvider, journal, undefined,
      { ...this.persistentConfig, retrievalId: RetrievalId(base.id), ...(options.information ? { initialInformation: options.information } : {}), onState: commit })
    try {
      let state = await work(controller, base.state_json!, journal)
      state = await controller.finalizeExhaustedEmptyResult(state)
      await commit(state)
      if (active?.id === base.id) this.states.set(agent, base)
      return state
    } catch (error) { await this.loadTask(agent); throw error }
  }
  /** Recompute only local projections/measurements after concurrent expert commits; never repeat Provider I/O. */
  private async observe<T>(agent: Agent, work: () => Promise<T>): Promise<T> {
    const before = await this.executionTask(agent)
    for (let attempt = 0; ; attempt++) {
      try { return await work() }
      catch (error) {
        if (attempt >= 12 || !(error instanceof RetrievalError) || !error.retryable) throw error
        const current = await this.executionTask(agent)
        if (!current || current.id !== before?.id || current.input_revision !== before.input_revision) throw error
      }
    }
  }
  override async start(agent: Agent, request: TicketRetrievalRequest, signal?: AbortSignal): Promise<RetrievalState> {
    const principal = await this.resolve(agent, 'snapshot_open', signal)
    let task = await this.executionTask(agent)
    if (!task) {
      await this.store.create(String(agent.session.id), String(agent.session.id), principal, request.query)
      task = (await this.store.forSession(String(agent.session.id)))!
    }
    if (task.state_json) throw new RetrievalError('INVALID_TRANSITION', '任务已开始，请补充当前任务或创建新任务。')
    const information = (await this.store.commands(task.id)).flatMap(command => command.kind === 'supplement' || command.kind === 'answer' ? [command.information] : [])
    return this.execute(agent, controller => controller.start(principal, request, signal), { start: true, information })
  }
  async refresh(agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
    const principal = await this.resolve(agent, 'search', signal)
    return this.execute(agent, (c, s) => c.refreshSearch(principal, s, signal))
  }
  async continueIndependentPage(agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
    const principal = await this.resolve(agent, 'search', signal)
    return this.execute(agent, (controller, state) => controller.continueIndependentPage(principal, state, signal))
  }
  override async search(agent: Agent, input: RetrievalSearchInput, signal?: AbortSignal): Promise<RetrievalState> {
    const p = await this.resolve(agent, 'search', signal); return this.execute(agent, (c, s) => c.search(p, s, input, signal))
  }
  override async continueRanking(agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
    const p = await this.resolve(agent, 'search', signal); return this.execute(agent, (c, s) => c.continueRanking(p, s, signal))
  }
  override async decide(agent: Agent, decision: RetrievalDecision, signal?: AbortSignal): Promise<RetrievalState> {
    await this.coordinator?.validateKnowledge?.(agent)
    const p = await this.resolve(agent, decision.action.kind === 'inspect' ? 'evidence_read' : 'search', signal)
    return this.execute(agent, (c, s) => c.decide(p, s, decision, signal))
  }
  override async resumeClarification(agent: Agent, input: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState> {
    const p = await this.resolve(agent, 'search', signal); return this.execute(agent, (c, s) => c.resumeClarification(p, s, input, signal))
  }
  override async applyUserFeedback(agent: Agent, input: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState> {
    const p = await this.resolve(agent, 'search', signal); return this.execute(agent, (c, s) => c.applyUserFeedback(p, s, input, signal))
  }
  override async cancel(agent: Agent): Promise<RetrievalState> { return this.execute(agent, async (c, s) => c.stop(s, 'cancelled')) }
  override async stopIncomplete(agent: Agent, explanation: string): Promise<RetrievalState> {
    return this.execute(agent, async (c, s) => c.stopIncomplete(s, explanation))
  }
  override async authorizePresentation(agent: Agent, id: RetrievalId, signal?: AbortSignal): Promise<RetrievalState> {
    const p = await this.resolve(agent, 'detail_read', signal)
    return this.execute(agent, (c, s) => c.reauthorize(p, s, signal), { semantic: false, taskId: id })
  }
  override async ensureModelAccess(agent: Agent, signal?: AbortSignal): Promise<RetrievalState | undefined> {
    await this.loadTask(agent)
    const state = this.currentOrUndefined(agent)
    return state ? this.authorizePresentation(agent, state.retrievalId, signal) : undefined
  }
  override async projectContext(agent: Agent, tokenBudget?: number): Promise<EvidenceContextSelection> {
    let selection!: EvidenceContextSelection
    await this.observe(agent, () => this.execute(agent, async (c, s) => {
      if (s.accessValidation !== 'current') throw new RetrievalError('UNAUTHORIZED', '当前证据尚未重新授权。')
      const budget = tokenBudget ?? this.contextTokenBudget ?? this.workingContextBudget(agent)
      const recorded = c.recordContextSelection(s, c.projectContext(s, budget, { journal: false }))
      selection = c.projectContext(recorded, budget)
      return recorded
    }, { semantic: false }))
    return selection
  }
  override async admitModelRequest(agent: Agent, input: Parameters<RetrievalAgentService['admitModelRequest']>[1]): Promise<{ accepted: boolean }> {
    let accepted = false
    await this.observe(agent, () => this.execute(agent, async (c, s) => {
      if (s.phase === 'stopped') return s
      const limit = Math.min(input.modelContextWindow ?? Infinity, this.maxContextTokens ?? Infinity)
      accepted = input.estimatedInputTokens + (input.outputReservedTokens ?? 0) + (input.protocolMarginTokens ?? 0) <= limit
      const state = c.recordModelRequest(s, { ...input, accepted, ...(Number.isFinite(limit) ? { effectiveContextLimit: limit } : {}),
        ...(!accepted ? { rejectionReason: 'model_context' as const } : {}) })
      return accepted ? state : c.freezeForInterruption(state, 'budget_exhausted')
    }, { semantic: false }))
    return { accepted }
  }
  override async recordModelResponse(agent: Agent, input: Parameters<RetrievalAgentService['recordModelResponse']>[1]): Promise<RetrievalState> {
    return this.observe(agent, () => this.execute(agent, async (c, s) => c.recordModelResponse(s, input), { semantic: false }))
  }
  override async recordToolCall(agent: Agent, input: Parameters<RetrievalAgentService['recordToolCall']>[1]): Promise<RetrievalState> {
    return this.observe(agent, () => this.execute(agent, async (c, s) => c.recordToolCall(s, input), { semantic: false }))
  }
  override async principal(agent: Agent, operation: 'detail_read' | 'export' | 'snapshot_open', signal?: AbortSignal) { return this.resolve(agent, operation, signal) }
  override async recordDetailRead(agent: Agent, receipt: CandidateDetailReadReceipt, result: TicketDetailResult): Promise<RetrievalState> {
    const before = await this.store.read(receipt.retrievalId)
    // Two tabs can finish independent Provider reads together. Rebase only the local
    // visibility receipt; never repeat I/O or carry it across a changed user input.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.execute(agent, async (c, s, journal) => {
          if (s.inputGeneration !== before?.state_json?.inputGeneration) throw staleTask()
          const state = c.recordDetailRead(s, receipt, result)
          journal.append(s.retrievalId, 'retrieval/detail-read', { receipt }); return state
        }, { taskId: receipt.retrievalId, semantic: false })
      } catch (error) {
        const current = await this.store.read(receipt.retrievalId)
        if (attempt >= 3 || !(error instanceof RetrievalError) || !error.retryable
          || !current || current.input_revision !== before?.input_revision) throw error
      }
    }
  }
  override async recordExport(agent: Agent, receipt: CandidateExportReceipt): Promise<void> {
    await this.execute(agent, async (_c, s, journal) => {
      if (s.phase !== 'stopped' || s.retrievalId !== receipt.retrievalId || (s.frozenEvidence?.packId ?? s.stateId) !== receipt.resultRevision) throw staleTask()
      journal.append(s.retrievalId, 'retrieval/exported', { receipt }); return s
    }, { semantic: false, taskId: receipt.retrievalId })
  }
}

export function compileTaskInformation(text: string): RetrievalClarificationAnswer {
  const conditions = compileUserConditions(text, [], new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)
  const result = compileUserResultPolicy(text)
  return { accepted: true, answer: text, filters: conditions.filters, requirements: conditions.userRequirements, ambiguities: conditions.ambiguities,
    ...(result?.countPolicy ? { result: { ...result, countPolicy: result.countPolicy } } : {}) }
}
