import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  RetrievalError,
  type CandidateDetailReadReceipt,
  type CandidateExportReceipt,
  type EvidenceContextSelection,
  type RetrievalKnowledgeAssessment,
  type RetrievalState,
  type TicketCandidateRef,
  type TicketEvidenceField,
  type TicketRetrievalRequest,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import {
  EvidenceContextPolicy,
  RetrievalController,
  foldRetrievalEvents,
  type RetrievalControllerConfig,
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
  return state === undefined ? undefined : { events: all, state }
}

/** Per-session product application; model calls only intents on this service. */
export class RetrievalAgentService extends Service {
  static inject = ['ticketRetrievalProvider', 'ticketPrincipalProvider']
  private readonly active = new WeakMap<Agent, ActiveRetrieval>()
  private readonly controllerConfig: RetrievalControllerConfig
  readonly contextTokenBudget: number
  readonly maxContextTokens: number

  constructor(ctx: Context, config: RetrievalAgentServiceConfig = {}) {
    super(ctx, 'retrievalAgent')
    installDshSessionCompatibility()
    this.controllerConfig = config
    this.contextTokenBudget = config.contextTokenBudget ?? 1_500
    this.maxContextTokens = config.maxContextTokens ?? 4_096
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
    return this.finalize(entry)
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
        return entry.controller.stop(state, reason)
      }
    })
  }

  async continueRanking(agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => {
      const principal = await this.resolvePrincipal(agent, 'search', signal)
      return await entry.controller.continueRanking(principal, state, signal)
    })
  }

  async assess(agent: Agent, assessment: RetrievalKnowledgeAssessment): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => {
      const assessed = entry.controller.assess(state, assessment)
      const freeze = assessed.allowedActions.find(action => action.kind === 'freeze')
      return freeze === undefined ? assessed : entry.controller.freeze(assessed, assessed.selectedCandidateRefs)
    })
  }

  async promote(agent: Agent, refs: readonly TicketCandidateRef[], fields: readonly TicketEvidenceField[], tokenBudget: number, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.entry(agent)
    return await this.mutate(entry, async state => {
      if (state.phase === 'stopped') return state
      try {
        const principal = await this.resolvePrincipal(agent, 'evidence_read', signal)
        return await entry.controller.promote(principal, state, refs, fields, tokenBudget, signal)
      } catch (error) {
        const reason = stoppedReason(error)
        if (reason === undefined) throw error
        return entry.controller.stop(state, reason)
      }
    })
  }

  requestClarification(agent: Agent, facet: string, question: string, refs: readonly TicketCandidateRef[]): RetrievalState {
    const entry = this.entry(agent)
    entry.state = entry.controller.requestClarification(entry.state, facet, question, refs)
    return this.finalize(entry)
  }

  answerClarification(agent: Agent, input: { readonly accepted: boolean; readonly answer?: string }): RetrievalState {
    const entry = this.entry(agent)
    entry.state = entry.controller.answerClarification(entry.state, input)
    return this.finalize(entry)
  }

  freeze(agent: Agent, refs: readonly TicketCandidateRef[]): RetrievalState {
    const entry = this.entry(agent)
    entry.state = entry.controller.freeze(entry.state, refs)
    return this.finalize(entry)
  }

  projectContext(agent: Agent, tokenBudget = this.contextTokenBudget): EvidenceContextSelection {
    const entry = this.entry(agent)
    return entry.controller.projectContext(entry.state, tokenBudget)
  }

  async admitModelRequest(agent: Agent, input: {
    readonly estimatedInputTokens: number
    readonly serializationBytes: number
    readonly wallClockElapsedMs: number
  }): Promise<{ readonly accepted: boolean; readonly remainingWallClockMs: number }> {
    const entry = this.entry(agent)
    let accepted = false
    const state = await this.mutate(entry, async current => {
      if (current.phase === 'stopped') return current
      accepted = input.estimatedInputTokens <= this.maxContextTokens
        && (current.budget.modelStepsUsed ?? current.budget.roundsUsed) < current.budget.maxRounds
        && input.wallClockElapsedMs < current.budget.maxLatencyMs
      const measured = entry.controller.recordModelRequest(current, { ...input, accepted })
      return accepted ? measured : entry.controller.stop(measured, 'budget_exhausted')
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
      : entry.controller.stop(state, 'budget_exhausted'))
  }

  async principal(agent: Agent, operation: 'detail_read' | 'export', signal?: AbortSignal): Promise<TrustedPrincipalContext> {
    return await this.resolvePrincipal(agent, operation, signal)
  }

  recordDetailRead(agent: Agent, receipt: CandidateDetailReadReceipt): void {
    const entry = this.entry(agent)
    if (entry.state.retrievalId !== receipt.retrievalId) throw new RetrievalError('INVALID_TRANSITION', '详情回执不属于当前检索。')
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

  private finalize(entry: ActiveRetrieval): RetrievalState {
    entry.state = entry.controller.finalizeExhaustedEmptyResult(entry.state)
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
      return this.finalize(entry)
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
