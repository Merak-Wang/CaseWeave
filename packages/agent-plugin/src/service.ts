import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  RetrievalError,
  type CandidateDetailReadReceipt,
  type CandidateExportReceipt,
  type EvidenceContextSelection,
  type RetrievalDecision,
  type RetrievalId,
  type RetrievalState,
  type TicketDetailResult,
  type TicketRetrievalRequest,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import {
  EvidenceContextPolicy,
  RetrievalController,
  foldRetrievalEvents,
  type RetrievalControllerConfig,
  type RetrievalClarificationAnswer,
  type RetrievalSearchInput,
} from '@retrieval-agent/domain'
import { installDshSessionCompatibility, readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import { SessionRetrievalEventJournal } from './session-journal.js'

interface ActiveRetrieval {
  readonly controller: RetrievalController
  readonly journal: SessionRetrievalEventJournal
  state: RetrievalState
  mutationTail: Promise<void>
}

function stoppedReason(error: unknown): 'budget_exhausted' | 'permission_blocked' | 'backend_error' | 'snapshot_invalid' | 'cancelled' | undefined {
  if (!(error instanceof RetrievalError)) return undefined
  switch (error.code) {
    case 'BUDGET_EXHAUSTED': return 'budget_exhausted'
    case 'UNAUTHORIZED': return 'permission_blocked'
    case 'SNAPSHOT_INVALID':
    case 'SNAPSHOT_NOT_FOUND': return 'snapshot_invalid'
    case 'CANCELLED': return 'cancelled'
    case 'PROVIDER_UNAVAILABLE':
    case 'TIMEOUT': return 'backend_error'
    default: return undefined
  }
}

export interface RetrievalAgentServiceConfig extends RetrievalControllerConfig {
  readonly contextTokenBudget?: number
  readonly maxContextTokens?: number
}

function latestRetrieval(agent: Agent): { readonly events: ReturnType<typeof readRetrievalSessionEvents>; readonly state: RetrievalState } | undefined {
  const all = readRetrievalSessionEvents(agent.session)
  const groups = new Map<string, typeof all[number][]>()
  let latestId: string | undefined
  for (const event of all) {
    const events = groups.get(event.retrievalId) ?? []
    events.push(event)
    groups.set(event.retrievalId, events)
    latestId = event.retrievalId
  }
  if (latestId === undefined) return undefined
  const events = groups.get(latestId) ?? []
  const state = foldRetrievalEvents(events)
  return state === undefined ? undefined : { events: all, state: { ...state, accessValidation: 'required' } }
}

/** Per-session product application; model calls only intents on this service. */
export class RetrievalAgentService extends Service {
  static inject = ['ticketRetrievalProvider', 'ticketPrincipalProvider']
  private readonly active = new WeakMap<Agent, ActiveRetrieval>()
  private readonly controllerConfig: RetrievalControllerConfig
  readonly contextTokenBudget: number | undefined
  readonly maxContextTokens: number | undefined

  constructor(ctx: Context, config: RetrievalAgentServiceConfig = {}) {
    super(ctx, 'retrievalAgent')
    installDshSessionCompatibility()
    this.controllerConfig = config
    this.contextTokenBudget = config.contextTokenBudget
    this.maxContextTokens = config.maxContextTokens
  }

  currentOrUndefined(agent: Agent): RetrievalState | undefined {
    return this.active.get(agent)?.state ?? latestRetrieval(agent)?.state
  }

  current(agent: Agent): RetrievalState {
    return this.entry(agent).state
  }

  async start(agent: Agent, request: TicketRetrievalRequest, signal?: AbortSignal): Promise<RetrievalState> {
    const previous = this.currentOrUndefined(agent)
    if (previous !== undefined && previous.phase !== 'stopped') {
      throw new RetrievalError('INVALID_TRANSITION', '当前会话已有未结束的检索。')
    }
    const journal = new SessionRetrievalEventJournal(agent.session)
    const controller = new RetrievalController(
      this.ctx.ticketRetrievalProvider,
      journal,
      new EvidenceContextPolicy(),
      this.controllerConfig,
    )
    const principal = await this.resolvePrincipal(agent, 'snapshot_open', signal)
    const entry = {
      controller,
      journal,
      state: await controller.start(principal, request, signal),
      mutationTail: Promise.resolve(),
    }
    this.active.set(agent, entry)
    return await this.finalize(entry, signal)
  }

  async search(agent: Agent, input: RetrievalSearchInput, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => {
      if (state.phase === 'stopped') return state
      try {
        const principal = await this.resolvePrincipal(agent, 'search', signal)
        return await entry.controller.search(principal, state, input, signal)
      } catch (error) {
        const reason = stoppedReason(error)
        if (reason === undefined) throw error
        return this.stopForReason(entry, state, reason)
      }
    })
  }

  async continueRanking(agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => {
      if (state.phase === 'stopped') return state
      try {
        const principal = await this.resolvePrincipal(agent, 'search', signal)
        return await entry.controller.continueRanking(principal, state, signal)
      } catch (error) {
        const reason = stoppedReason(error)
        if (reason === undefined) throw error
        return this.stopForReason(entry, state, reason)
      }
    })
  }

  async decide(agent: Agent, decision: RetrievalDecision, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => {
      const operation = decision.action.kind === 'inspect' ? 'evidence_read' : 'search'
      try {
        const principal = await this.resolvePrincipal(agent, operation, signal)
        return await entry.controller.decide(principal, state, decision, signal)
      } catch (error) {
        const reason = stoppedReason(error)
        if (reason === undefined) throw error
        return this.stopForReason(entry, state, reason)
      }
    })
  }

  async resumeClarification(agent: Agent, answer: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => {
      try {
        const principal = await this.resolvePrincipal(agent, 'search', signal)
        return await entry.controller.resumeClarification(principal, state, answer, signal)
      } catch (error) {
        const reason = stoppedReason(error)
        if (reason === undefined) throw error
        return this.stopForReason(entry, state, reason)
      }
    })
  }

  async applyUserFeedback(agent: Agent, answer: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => {
      try {
        const principal = await this.resolvePrincipal(agent, 'search', signal)
        return await entry.controller.applyUserFeedback(principal, state, answer, signal)
      } catch (error) {
        const reason = stoppedReason(error)
        if (reason === undefined) throw error
        return this.stopForReason(entry, state, reason)
      }
    })
  }

  async cancel(agent: Agent): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => entry.controller.stop(state, 'cancelled'))
  }

  async stopIncomplete(agent: Agent, explanation: string): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => entry.controller.stopIncomplete(state, explanation))
  }

  async authorizePresentation(agent: Agent, retrievalId: RetrievalId, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.entry(agent)
    if (entry.state.retrievalId !== retrievalId) throw new RetrievalError('INVALID_REQUEST', '当前会话没有对应的检索结果。')
    return await this.mutate(entry, async state => {
      const principal = await this.resolvePrincipal(agent, 'detail_read', signal)
      return await entry.controller.reauthorize(principal, state, signal)
    })
  }

  async ensureModelAccess(agent: Agent, signal?: AbortSignal): Promise<RetrievalState | undefined> {
    if (this.currentOrUndefined(agent) === undefined) return undefined
    const entry = this.entry(agent)
    if (entry.state.accessValidation !== 'required') return entry.state
    return await this.authorizePresentation(agent, entry.state.retrievalId, signal)
  }

  projectContext(agent: Agent, tokenBudget?: number): EvidenceContextSelection {
    const entry = this.entry(agent)
    if (entry.state.accessValidation === 'required') throw new RetrievalError('UNAUTHORIZED', '历史证据必须先经当前身份重新授权。')
    const configured = tokenBudget ?? this.contextTokenBudget
    const budget = typeof configured === 'number' ? configured : undefined
    const selection = entry.controller.projectContext(entry.state, budget)
    entry.state = entry.controller.recordContextSelection(entry.state, selection)
    return entry.controller.projectContext(entry.state, budget)
  }

  /** Resolve the selected route's capacity with an optional narrower deployment override. */
  modelContextTokenLimit(agent: Agent): number | undefined {
    return this.effectiveContextLimit(agent.session.requestContext()?.contextWindow)
  }

  async admitModelRequest(agent: Agent, input: {
    readonly estimatedInputTokens: number
    readonly serializationBytes: number
    readonly wallClockElapsedMs: number
    readonly modelContextWindow?: number
  }): Promise<{ readonly accepted: boolean; readonly remainingWallClockMs: number }> {
    const entry = this.entry(agent)
    let accepted = false
    const state = await this.mutate(entry, async current => {
      if (current.phase === 'stopped') return current
      const effectiveContextLimit = this.effectiveContextLimit(input.modelContextWindow)
      const contextExceeded = effectiveContextLimit !== undefined
        && input.estimatedInputTokens > effectiveContextLimit
      const modelStepsExceeded = current.budget.modelStepsUsed >= current.budget.maxRounds
      const wallClockExceeded = input.wallClockElapsedMs >= current.budget.maxLatencyMs
      const rejectionReason = contextExceeded
        ? this.maxContextTokens !== undefined
          && (input.modelContextWindow === undefined || this.maxContextTokens < input.modelContextWindow)
          ? 'deployment_context' as const
          : 'model_context' as const
        : modelStepsExceeded ? 'model_steps' as const
          : wallClockExceeded ? 'wall_clock' as const : undefined
      accepted = rejectionReason === undefined
      const measured = entry.controller.recordModelRequest(current, {
        ...input,
        ...(this.maxContextTokens === undefined ? {} : { deploymentContextLimit: this.maxContextTokens }),
        ...(effectiveContextLimit === undefined ? {} : { effectiveContextLimit }),
        ...(rejectionReason === undefined ? {} : { rejectionReason }),
        accepted,
      })
      return accepted ? measured : entry.controller.freezeForBudget(measured)
    })
    return {
      accepted,
      remainingWallClockMs: Math.max(0, state.budget.maxLatencyMs - (state.budget.wallClockElapsedMs ?? 0)),
    }
  }

  async recordModelResponse(agent: Agent, input: {
    readonly modelLatencyMs: number
    readonly outputTokens: number
    readonly wallClockElapsedMs: number
  }): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => entry.controller.recordModelResponse(state, input))
  }

  async recordToolCall(agent: Agent, input: { readonly success: boolean; readonly serializationBytes: number }): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => entry.controller.recordToolCall(state, input))
  }

  async stopForWallClockBudget(agent: Agent): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => state.phase === 'stopped'
      ? state
      : entry.controller.freezeForBudget(state))
  }

  async principal(agent: Agent, operation: 'detail_read' | 'export', signal?: AbortSignal): Promise<TrustedPrincipalContext> {
    return await this.resolvePrincipal(agent, operation, signal)
  }

  recordDetailRead(agent: Agent, receipt: CandidateDetailReadReceipt, result: TicketDetailResult): void {
    const entry = this.entry(agent)
    if (entry.state.retrievalId !== receipt.retrievalId) throw new RetrievalError('INVALID_TRANSITION', '详情回执不属于当前检索。')
    entry.state = entry.controller.recordDetailRead(entry.state, receipt, result)
    entry.journal.append(entry.state.retrievalId, 'retrieval/detail-read', { receipt })
  }
  recordExport(agent: Agent, receipt: CandidateExportReceipt): void {
    const entry = this.entry(agent)
    if (entry.state.retrievalId !== receipt.retrievalId) throw new RetrievalError('INVALID_TRANSITION', '导出回执不属于当前检索。')
    entry.journal.append(entry.state.retrievalId, 'retrieval/exported', { receipt })
  }

  private entry(agent: Agent): ActiveRetrieval {
    const active = this.active.get(agent)
    if (active !== undefined) return active
    const replayed = latestRetrieval(agent)
    if (replayed === undefined) throw new RetrievalError('INVALID_TRANSITION', '当前会话尚未开始检索。')
    const journal = new SessionRetrievalEventJournal(agent.session)
    const controller = new RetrievalController(this.ctx.ticketRetrievalProvider, journal, new EvidenceContextPolicy(), this.controllerConfig)
    const entry = { controller, journal, state: replayed.state, mutationTail: Promise.resolve() }
    this.active.set(agent, entry)
    return entry
  }

  private effectiveContextLimit(modelContextWindow: number | undefined): number | undefined {
    if (modelContextWindow === undefined) return this.maxContextTokens
    if (this.maxContextTokens === undefined) return modelContextWindow
    return Math.min(modelContextWindow, this.maxContextTokens)
  }

  private stopForReason(
    entry: ActiveRetrieval,
    state: RetrievalState,
    reason: NonNullable<ReturnType<typeof stoppedReason>>,
  ): RetrievalState {
    return reason === 'budget_exhausted'
      ? entry.controller.freezeForBudget(state)
      : entry.controller.stop(state, reason)
  }

  private async finalize(entry: ActiveRetrieval, signal?: AbortSignal): Promise<RetrievalState> {
    entry.state = await entry.controller.finalizeExhaustedEmptyResult(entry.state, signal)
    return entry.state
  }

  /** Serialize state-changing tools so parallel model tool calls cannot lose updates. */
  private async mutate(
    entry: ActiveRetrieval,
    operation: (state: RetrievalState) => Promise<RetrievalState>,
  ): Promise<RetrievalState> {
    const previous = entry.mutationTail
    let release = (): void => undefined
    entry.mutationTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      entry.state = await operation(entry.state)
      return await this.finalize(entry)
    } finally {
      release()
    }
  }

  private async resolvePrincipal(agent: Agent, operation: 'snapshot_open' | 'search' | 'evidence_read' | 'detail_read' | 'export', signal?: AbortSignal): Promise<TrustedPrincipalContext> {
    return await this.ctx.ticketPrincipalProvider.resolve(
      { sessionId: String(agent.session.id), operation },
      signal === undefined ? undefined : { signal },
    )
  }
}
