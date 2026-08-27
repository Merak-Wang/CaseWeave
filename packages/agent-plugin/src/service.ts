import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  RetrievalError,
  type EvidenceContextSelection,
  type FrozenEvidencePack,
  type RetrievalState,
  type TicketCandidateRef,
  type TicketEvidenceField,
  type TicketQueryDelta,
  type TicketRetrievalRequest,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import {
  EvidenceContextPolicy,
  RetrievalController,
  foldRetrievalEvents,
  type RetrievalAssessment,
  type RetrievalControllerConfig,
} from '@retrieval-agent/domain'
import { installDshSessionCompatibility, readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import { SessionRetrievalEventJournal } from './session-journal.js'

interface ActiveRetrieval {
  readonly controller: RetrievalController
  readonly journal: SessionRetrievalEventJournal
  state: RetrievalState
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
  readonly #active = new WeakMap<Agent, ActiveRetrieval>()
  readonly #controllerConfig: RetrievalControllerConfig
  readonly contextTokenBudget: number

  constructor(ctx: Context, config: RetrievalAgentServiceConfig = {}) {
    super(ctx, 'retrievalAgent')
    installDshSessionCompatibility()
    this.#controllerConfig = config
    this.contextTokenBudget = config.contextTokenBudget ?? 1_500
  }

  currentOrUndefined(agent: Agent): RetrievalState | undefined {
    return this.#active.get(agent)?.state ?? latestRetrieval(agent)?.state
  }

  current(agent: Agent): RetrievalState {
    return this.#entry(agent).state
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
      this.#controllerConfig,
    )
    const principal = await this.#principal(agent, 'snapshot_open', signal)
    const state = await controller.start(principal, request, signal)
    this.#active.set(agent, { controller, journal, state })
    return state
  }

  async search(agent: Agent, input: { readonly delta?: TicketQueryDelta; readonly cursor?: string }, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.#entry(agent)
    try {
      const principal = await this.#principal(agent, 'search', signal)
      entry.state = await entry.controller.search(principal, entry.state, input, signal)
    } catch (error) {
      const reason = stoppedReason(error)
      if (reason === undefined) throw error
      entry.state = entry.controller.stop(entry.state, reason)
    }
    return entry.state
  }

  assess(agent: Agent, assessment: RetrievalAssessment): RetrievalState {
    const entry = this.#entry(agent)
    entry.state = entry.controller.assess(entry.state, assessment)
    return entry.state
  }

  async promote(agent: Agent, refs: readonly TicketCandidateRef[], fields: readonly TicketEvidenceField[], tokenBudget: number, signal?: AbortSignal): Promise<RetrievalState> {
    const entry = this.#entry(agent)
    try {
      const principal = await this.#principal(agent, 'evidence_read', signal)
      entry.state = await entry.controller.promote(principal, entry.state, refs, fields, tokenBudget, signal)
    } catch (error) {
      const reason = stoppedReason(error)
      if (reason === undefined) throw error
      entry.state = entry.controller.stop(entry.state, reason)
    }
    return entry.state
  }

  requestClarification(agent: Agent, facet: keyof RetrievalState['candidates'][number]['l0'], question: string, refs: readonly TicketCandidateRef[]): RetrievalState {
    const entry = this.#entry(agent)
    entry.state = entry.controller.requestClarification(entry.state, facet, question, refs)
    return entry.state
  }

  answerClarification(agent: Agent, input: { readonly accepted: boolean; readonly answer?: string; readonly delta?: TicketQueryDelta }): RetrievalState {
    const entry = this.#entry(agent)
    entry.state = entry.controller.answerClarification(entry.state, input)
    return entry.state
  }

  freeze(agent: Agent, refs: readonly TicketCandidateRef[]): RetrievalState {
    const entry = this.#entry(agent)
    entry.state = entry.controller.freeze(entry.state, refs)
    return entry.state
  }

  projectContext(agent: Agent, tokenBudget = this.contextTokenBudget): EvidenceContextSelection {
    const entry = this.#entry(agent)
    return entry.controller.projectContext(entry.state, tokenBudget)
  }

  validateFrozenReferences(agent: Agent, displayIds: readonly string[], evidenceIds: readonly string[]): FrozenEvidencePack {
    const entry = this.#entry(agent)
    return entry.controller.validateFrozenReferences(entry.state, displayIds, evidenceIds)
  }

  async principal(agent: Agent, operation: 'detail_read' | 'export', signal?: AbortSignal): Promise<TrustedPrincipalContext> {
    return await this.#principal(agent, operation, signal)
  }

  #entry(agent: Agent): ActiveRetrieval {
    const active = this.#active.get(agent)
    if (active !== undefined) return active
    const replayed = latestRetrieval(agent)
    if (replayed === undefined) throw new RetrievalError('INVALID_TRANSITION', '当前会话尚未开始检索。')
    const journal = new SessionRetrievalEventJournal(agent.session)
    const controller = new RetrievalController(this.ctx.ticketRetrievalProvider, journal, new EvidenceContextPolicy(), this.#controllerConfig)
    const entry = { controller, journal, state: replayed.state }
    this.#active.set(agent, entry)
    return entry
  }

  async #principal(agent: Agent, operation: 'snapshot_open' | 'search' | 'evidence_read' | 'detail_read' | 'export', signal?: AbortSignal): Promise<TrustedPrincipalContext> {
    return await this.ctx.ticketPrincipalProvider.resolve(
      { sessionId: String(agent.session.id), operation },
      signal === undefined ? undefined : { signal },
    )
  }
}
