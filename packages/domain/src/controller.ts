import { randomUUID } from 'node:crypto'
import {
  RetrievalError,
  RetrievalId,
  RetrievalStateId,
  type EvidenceContextSelection,
  type FrozenEvidencePack,
  type RetrievalActionKind,
  type RetrievalAllowedAction,
  type RetrievalBudgetState,
  type RetrievalGap,
  type RetrievalGapKind,
  type RetrievalState,
  type RetrievalTermination,
  type TicketCandidateRef,
  type TicketEvidenceField,
  type TicketFilter,
  type TicketQueryDelta,
  type TicketRetrievalProvider,
  type TicketRetrievalRequest,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { EvidenceContextPolicy } from './context.js'
import type { RetrievalEventJournal } from './journal.js'
import { applyQueryDelta } from './query.js'
import {
  allowedAction as action,
  candidateFacetValues as facetValues,
  candidateRankOverlap as rankOverlap,
  coverageGaps as systemGaps,
  requireAction as hasAction,
  validateCandidateRefs as validateRefs,
} from './state-guards.js'

export interface RetrievalControllerConfig {
  readonly rulesVersion?: string
  readonly promptVersion?: string
  readonly maxRounds?: number
  readonly maxSearches?: number
  readonly maxPromotions?: number
  readonly maxEvidenceTokens?: number
  readonly maxLatencyMs?: number
  readonly noProgressLimit?: number
  readonly searchTopK?: number
  readonly searchMaxScan?: number
  readonly now?: () => Date
  readonly id?: () => string
}

export interface RetrievalAssessment {
  readonly decision: 'sufficient' | 'no_result' | 'needs_clarification' | 'partial' | 'continue'
  readonly selectedCandidateRefs: readonly TicketCandidateRef[]
  readonly gaps: readonly RetrievalGap[]
  readonly model?: string
}

function emptyBudget(config: Required<Pick<RetrievalControllerConfig, 'maxRounds' | 'maxSearches' | 'maxPromotions' | 'maxEvidenceTokens' | 'maxLatencyMs'>>): RetrievalBudgetState {
  return {
    maxRounds: config.maxRounds,
    maxSearches: config.maxSearches,
    maxPromotions: config.maxPromotions,
    maxEvidenceTokens: config.maxEvidenceTokens,
    maxLatencyMs: config.maxLatencyMs,
    roundsUsed: 0,
    searchesUsed: 0,
    promotionsUsed: 0,
    evidenceTokensUsed: 0,
    latencyMs: 0,
  }
}

/** Model intent is admitted only through these deterministic transitions. */
export class RetrievalController {
  readonly #provider: TicketRetrievalProvider
  readonly #journal: RetrievalEventJournal
  readonly #contextPolicy: EvidenceContextPolicy
  readonly #rulesVersion: string
  readonly #promptVersion: string
  readonly #maxRounds: number
  readonly #maxSearches: number
  readonly #maxPromotions: number
  readonly #maxEvidenceTokens: number
  readonly #maxLatencyMs: number
  readonly #noProgressLimit: number
  readonly #searchTopK: number
  readonly #searchMaxScan: number
  readonly #now: () => Date
  readonly #id: () => string

  constructor(provider: TicketRetrievalProvider, journal: RetrievalEventJournal, contextPolicy = new EvidenceContextPolicy(), config: RetrievalControllerConfig = {}) {
    this.#provider = provider
    this.#journal = journal
    this.#contextPolicy = contextPolicy
    this.#rulesVersion = config.rulesVersion ?? 'retrieval-rules-v1'
    this.#promptVersion = config.promptVersion ?? 'retrieval-prompt-v1'
    this.#maxRounds = config.maxRounds ?? 8
    this.#maxSearches = config.maxSearches ?? 4
    this.#maxPromotions = config.maxPromotions ?? 3
    this.#maxEvidenceTokens = config.maxEvidenceTokens ?? 1_500
    this.#maxLatencyMs = config.maxLatencyMs ?? 120_000
    this.#noProgressLimit = config.noProgressLimit ?? 2
    this.#searchTopK = config.searchTopK ?? 8
    this.#searchMaxScan = config.searchMaxScan ?? 50_000
    this.#now = config.now ?? (() => new Date())
    this.#id = config.id ?? (() => randomUUID())
  }

  async start(principal: TrustedPrincipalContext, request: TicketRetrievalRequest, signal?: AbortSignal): Promise<RetrievalState> {
    const retrievalId = RetrievalId(this.#id())
    const spec = this.#provider.resolve(request)
    const task = {
      target: spec.target,
      requestedCount: spec.requestedCount,
      answerabilityPolicy: 'current_snapshot_evidence_only' as const,
      completenessRequirement: spec.target === 'constrained_list' || spec.target === 'cohort_collection' ? 'exhaustive' as const : 'top_k' as const,
    }
    const contracted = this.#journal.append(retrievalId, 'retrieval/query-contracted', { contract: task, spec })
    const snapshot = await this.#provider.openSnapshot(principal, { ...(signal === undefined ? {} : { signal }) })
    const opened = this.#journal.append(retrievalId, 'retrieval/snapshot-opened', { snapshot })
    const now = this.#now().toISOString()
    const state: RetrievalState = {
      retrievalId,
      stateId: RetrievalStateId(this.#stateId(retrievalId, 0)),
      revision: 0,
      createdAt: now,
      updatedAt: now,
      phase: 'snapshot_opened',
      task,
      principalBindingHash: snapshot.principalBindingHash,
      snapshot,
      query: { original: spec.originalQuery, spec, confirmedConstraints: [...spec.filters], unresolvedConstraints: [] },
      candidates: [],
      promotedEvidence: [],
      gaps: [{ kind: 'coverage', status: 'unknown', evidenceRefs: [], evaluator: 'system' }],
      allowedActions: [action('search'), action('read_state')],
      budget: emptyBudget({
        maxRounds: this.#maxRounds,
        maxSearches: this.#maxSearches,
        maxPromotions: this.#maxPromotions,
        maxEvidenceTokens: this.#maxEvidenceTokens,
        maxLatencyMs: this.#maxLatencyMs,
      }),
      progress: { newCandidateRefs: [], rankOverlap: 0, newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0 },
      termination: 'active',
      provenance: {
        rulesVersion: this.#rulesVersion,
        promptVersion: this.#promptVersion,
        contextPolicyVersion: this.#contextPolicy.version,
        sourceEventIds: [contracted.eventId, opened.eventId],
      },
    }
    this.#record(state)
    return state
  }

  async search(principal: TrustedPrincipalContext, state: RetrievalState, input: { readonly delta?: TicketQueryDelta; readonly cursor?: string } = {}, signal?: AbortSignal): Promise<RetrievalState> {
    const kind: RetrievalActionKind = input.cursor !== undefined ? 'search_next' : input.delta === undefined ? 'search' : 'repair_search'
    if (kind === 'search' && state.budget.searchesUsed > 0) hasAction(state, 'search_next')
    else hasAction(state, kind)
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '当前检索没有有效快照。')
    if (state.budget.searchesUsed >= state.budget.maxSearches
      || state.budget.roundsUsed >= state.budget.maxRounds
      || state.budget.latencyMs >= state.budget.maxLatencyMs) {
      throw new RetrievalError('BUDGET_EXHAUSTED', '检索预算已耗尽。')
    }
    const spec = applyQueryDelta(state.query.spec, input.delta)
    const page = await this.#provider.search(principal, state.snapshot.snapshotId, spec, {
      topK: this.#searchTopK,
      maxScan: this.#searchMaxScan,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (page.snapshotId !== state.snapshot.snapshotId || page.candidates.some(candidate => candidate.snapshotId !== state.snapshot!.snapshotId)) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回了不同快照的候选。')
    }
    if (new Set(page.candidates.map(candidate => candidate.ref)).size !== page.candidates.length) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回了重复候选引用。')
    }
    const searched = this.#journal.append(state.retrievalId, 'retrieval/search-completed', { spec, page })
    const previousRefs = state.candidates.map(candidate => candidate.ref)
    const pageRefs = page.candidates.map(candidate => candidate.ref)
    const candidates = input.cursor === undefined ? [...page.candidates] : [...state.candidates, ...page.candidates]
    const newRefs = pageRefs.filter(ref => !previousRefs.includes(ref))
    const overlap = rankOverlap(previousRefs, candidates.map(candidate => candidate.ref))
    const noProgressStreak = newRefs.length === 0 ? state.progress.noProgressStreak + 1 : 0
    const budget = {
      ...state.budget,
      roundsUsed: state.budget.roundsUsed + 1,
      searchesUsed: state.budget.searchesUsed + 1,
      latencyMs: state.budget.latencyMs + page.elapsedMs,
    }
    const candidateRefs = candidates.map(candidate => candidate.ref)
    const canContinue = budget.searchesUsed < budget.maxSearches
      && budget.roundsUsed < budget.maxRounds
      && budget.latencyMs < budget.maxLatencyMs
      && noProgressStreak < this.#noProgressLimit
    const canPromote = budget.promotionsUsed < budget.maxPromotions
      && budget.roundsUsed < budget.maxRounds
      && budget.latencyMs < budget.maxLatencyMs
      && budget.evidenceTokensUsed < budget.maxEvidenceTokens
    const evidenceFields: readonly TicketEvidenceField[] = ['problemDescription', 'conversationOrUpdates', 'resolutionSteps', 'rootCause', 'answer']
    const allowedActions: RetrievalAllowedAction[] = [action('assess', candidateRefs), action('read_state')]
    if (page.nextCursor !== undefined && canContinue) allowedActions.push(action('search_next'))
    if (canContinue) allowedActions.push(action('repair_search'))
    if (candidateRefs.length > 0 && canPromote) {
      allowedActions.push(action('promote', candidateRefs, evidenceFields, budget.maxEvidenceTokens - budget.evidenceTokensUsed))
    }
    const next = this.#next(state, {
      phase: 'assessed',
      query: { ...state.query, spec, confirmedConstraints: [...spec.filters] },
      candidates,
      lastPage: page,
      gaps: systemGaps(candidateRefs),
      allowedActions,
      budget,
      progress: {
        newCandidateRefs: newRefs,
        rankOverlap: overlap,
        newDecisiveEvidence: false,
        resolvedGaps: candidateRefs.length > 0 ? ['coverage'] : [],
        noProgressStreak,
      },
      provenance: { ...state.provenance, sourceEventIds: [searched.eventId] },
    })
    this.#record(next)
    return next
  }

  assess(state: RetrievalState, assessment: RetrievalAssessment): RetrievalState {
    hasAction(state, 'assess')
    const selected = validateRefs(state, assessment.selectedCandidateRefs)
    const knownEvidence = new Set<string>([
      ...state.candidates.map(candidate => candidate.ref),
      ...state.promotedEvidence.map(evidence => evidence.evidenceId),
    ])
    for (const gap of assessment.gaps) {
      if (gap.evidenceRefs.some(ref => !knownEvidence.has(ref))) throw new RetrievalError('INVALID_REQUEST', 'Gap 引用了当前状态外的证据。')
    }
    const candidateRefs = state.candidates.map(candidate => candidate.ref)
    const fields: readonly TicketEvidenceField[] = ['problemDescription', 'conversationOrUpdates', 'resolutionSteps', 'rootCause', 'answer']
    const actions: RetrievalAllowedAction[] = [action('read_state')]
    const canSearch = state.budget.searchesUsed < state.budget.maxSearches
      && state.budget.roundsUsed < state.budget.maxRounds
      && state.budget.latencyMs < state.budget.maxLatencyMs
      && state.progress.noProgressStreak < this.#noProgressLimit
    const canPromote = state.budget.promotionsUsed < state.budget.maxPromotions
      && state.budget.roundsUsed < state.budget.maxRounds
      && state.budget.latencyMs < state.budget.maxLatencyMs
      && state.budget.evidenceTokensUsed < state.budget.maxEvidenceTokens
    let termination: RetrievalTermination = 'active'
    switch (assessment.decision) {
      case 'sufficient':
        if (selected.length === 0) throw new RetrievalError('INVALID_REQUEST', '证据充分时必须选择至少一个当前候选。')
        actions.unshift(action('freeze', selected))
        break
      case 'no_result':
        if (state.candidates.length > 0 || selected.length > 0) throw new RetrievalError('INVALID_REQUEST', '存在候选时不能评估为无结果。')
        actions.unshift(action('freeze'))
        break
      case 'needs_clarification':
        if (candidateRefs.length < 2) throw new RetrievalError('INVALID_REQUEST', '候选不足时不能生成候选差异澄清。')
        actions.unshift(action('request_clarification', candidateRefs))
        termination = 'needs_clarification'
        break
      case 'partial':
        actions.unshift(action('freeze', selected.length === 0 ? candidateRefs : selected))
        if (canPromote && candidateRefs.length > 0) {
          actions.unshift(action('promote', candidateRefs, fields, state.budget.maxEvidenceTokens - state.budget.evidenceTokensUsed))
        }
        break
      case 'continue':
        if (canSearch) actions.unshift(action('repair_search'))
        if (canPromote && candidateRefs.length > 0) {
          actions.unshift(action('promote', candidateRefs, fields, state.budget.maxEvidenceTokens - state.budget.evidenceTokensUsed))
        }
        if (actions.length === 1) actions.unshift(action('freeze', candidateRefs))
        break
      default:
        return assessment.decision satisfies never
    }
    const next = this.#next(state, {
      gaps: [...assessment.gaps],
      allowedActions: actions,
      termination,
      provenance: {
        ...state.provenance,
        ...(assessment.model === undefined ? {} : { model: assessment.model }),
        sourceEventIds: [],
      },
    })
    this.#record(next)
    return next
  }

  async promote(principal: TrustedPrincipalContext, state: RetrievalState, refs: readonly TicketCandidateRef[], fields: readonly TicketEvidenceField[], tokenBudget: number, signal?: AbortSignal): Promise<RetrievalState> {
    const allowed = hasAction(state, 'promote')
    const selected = validateRefs(state, refs)
    if (selected.length === 0) throw new RetrievalError('INVALID_REQUEST', '必须选择至少一个候选读取证据。')
    if (selected.some(ref => !allowed.candidateAllowlist.includes(ref))) throw new RetrievalError('UNAUTHORIZED', '候选不在当前读取 allowlist 中。')
    if (fields.length === 0 || fields.some(field => !allowed.fieldAllowlist.includes(field))) throw new RetrievalError('FIELD_NOT_ALLOWED', '字段不在当前读取 allowlist 中。')
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > allowed.maxTokens) throw new RetrievalError('BUDGET_EXHAUSTED', '证据读取预算无效或已耗尽。')
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '当前检索没有有效快照。')
    const result = await this.#provider.readEvidence(principal, {
      snapshotId: state.snapshot.snapshotId,
      candidateRefs: selected,
      fields,
      tokenBudget,
    }, signal === undefined ? undefined : { signal })
    if (result.snapshotId !== state.snapshot.snapshotId) throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回了不同快照的证据。')
    if (result.rejectedCandidateRefs.length > 0) throw new RetrievalError('UNAUTHORIZED', '候选证据授权已变化，请重新检索。')
    if (result.tokensUsed > tokenBudget || result.evidence.some(evidence => !selected.includes(evidence.candidateRef))) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回的证据超出本次 allowlist 或预算。')
    }
    const promoted = this.#journal.append(state.retrievalId, 'retrieval/evidence-promoted', { evidence: result.evidence, tokensUsed: result.tokensUsed })
    const budget = {
      ...state.budget,
      roundsUsed: state.budget.roundsUsed + 1,
      promotionsUsed: state.budget.promotionsUsed + 1,
      evidenceTokensUsed: state.budget.evidenceTokensUsed + result.tokensUsed,
    }
    const next = this.#next(state, {
      phase: 'assessed',
      promotedEvidence: [...state.promotedEvidence, ...result.evidence],
      allowedActions: [action('assess', state.candidates.map(candidate => candidate.ref)), action('read_state')],
      budget,
      progress: { ...state.progress, newDecisiveEvidence: result.evidence.length > 0, noProgressStreak: result.evidence.length > 0 ? 0 : state.progress.noProgressStreak + 1 },
      provenance: { ...state.provenance, sourceEventIds: [promoted.eventId] },
    })
    this.#record(next)
    return next
  }

  requestClarification(state: RetrievalState, facet: keyof NonNullable<RetrievalState['candidates'][number]>['l0'], question: string, refs: readonly TicketCandidateRef[]): RetrievalState {
    hasAction(state, 'request_clarification')
    const selected = validateRefs(state, refs)
    if (selected.length < 2 || facetValues(state, facet, selected).size < 2) {
      throw new RetrievalError('INVALID_REQUEST', '澄清必须来自至少两个候选的真实字段差异。')
    }
    const normalizedQuestion = question.trim()
    if (normalizedQuestion.length < 2 || normalizedQuestion.length > 500) throw new RetrievalError('INVALID_REQUEST', '澄清问题无效。')
    const event = this.#journal.append(state.retrievalId, 'retrieval/clarification-requested', { facet, question: normalizedQuestion, candidateRefs: selected })
    const next = this.#next(state, {
      phase: 'awaiting_clarification',
      clarification: { facet, question: normalizedQuestion, candidateRefs: selected },
      allowedActions: [action('answer_clarification', selected), action('read_state')],
      termination: 'needs_clarification',
      provenance: { ...state.provenance, sourceEventIds: [event.eventId] },
    })
    this.#record(next)
    return next
  }

  answerClarification(state: RetrievalState, input: { readonly accepted: boolean; readonly answer?: string; readonly delta?: TicketQueryDelta }): RetrievalState {
    hasAction(state, 'answer_clarification')
    if (state.clarification === undefined) throw new RetrievalError('INVALID_TRANSITION', '当前没有待回答的澄清问题。')
    const answer = input.answer?.trim()
    if (input.accepted && (answer === undefined || answer.length === 0 || input.delta === undefined)) {
      throw new RetrievalError('INVALID_REQUEST', '接受澄清时必须提供答案和类型化查询修改。')
    }
    const spec = input.accepted ? applyQueryDelta(state.query.spec, input.delta) : state.query.spec
    const event = this.#journal.append(state.retrievalId, 'retrieval/clarification-answered', {
      facet: state.clarification.facet,
      accepted: input.accepted,
      ...(answer === undefined ? {} : { answer }),
    })
    const actions = input.accepted && state.budget.searchesUsed < state.budget.maxSearches
      ? [action('repair_search'), action('read_state')]
      : [action('freeze', state.candidates.map(candidate => candidate.ref)), action('read_state')]
    const next = this.#next(state, {
      phase: 'assessed',
      query: {
        ...state.query,
        spec,
        confirmedConstraints: [...spec.filters],
        unresolvedConstraints: input.accepted ? [] : [...state.query.unresolvedConstraints, state.clarification.facet],
      },
      clarification: { ...state.clarification, ...(answer === undefined ? {} : { answer }) },
      allowedActions: actions,
      termination: 'active',
      provenance: { ...state.provenance, sourceEventIds: [event.eventId] },
    })
    this.#record(next)
    return next
  }

  projectContext(state: RetrievalState, tokenBudget: number): EvidenceContextSelection {
    const selection = this.#contextPolicy.select(state, tokenBudget)
    this.#journal.append(state.retrievalId, 'retrieval/context-projected', { selection })
    return selection
  }

  freeze(state: RetrievalState, refs: readonly TicketCandidateRef[], reason?: Exclude<RetrievalTermination, 'active' | 'needs_clarification'>): RetrievalState {
    hasAction(state, 'freeze')
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '当前检索没有有效快照。')
    const selected = validateRefs(state, refs)
    const stoppingReason = reason ?? (selected.length === 0 ? 'no_result' : state.gaps.some(gap => gap.status === 'open') ? 'partial' : 'sufficient')
    if (stoppingReason === 'no_result' && state.candidates.length > 0) throw new RetrievalError('INVALID_TRANSITION', '存在候选时不能冻结为无结果。')
    const pack: FrozenEvidencePack = {
      packId: this.#id(),
      retrievalId: state.retrievalId,
      query: { original: state.query.original, normalized: state.query.spec.normalizedQuery },
      target: state.task.target,
      confirmedConstraints: [...state.query.confirmedConstraints],
      snapshot: state.snapshot,
      candidates: selected.map(ref => {
        const candidate = state.candidates.find(item => item.ref === ref)
        if (candidate === undefined) throw new RetrievalError('CANDIDATE_NOT_FOUND', '冻结候选不在当前状态中。')
        const evidenceIds = state.promotedEvidence.filter(evidence => evidence.candidateRef === ref).map(evidence => evidence.evidenceId)
        return {
          ref,
          displayId: candidate.displayId,
          sourceVersion: candidate.sourceVersion,
          contentHash: candidate.contentHash,
          evidenceLevel: evidenceIds.length > 0 ? 'L2' as const : 'L1' as const,
          evidenceIds,
        }
      }),
      stoppingReason,
      remainingGaps: state.gaps.filter(gap => gap.status === 'open' || gap.status === 'unknown'),
      budget: state.budget,
      complete: stoppingReason === 'sufficient' || stoppingReason === 'no_result',
      providerId: state.snapshot.providerId,
      promptVersion: state.provenance.promptVersion,
    }
    const frozen = this.#journal.append(state.retrievalId, 'retrieval/evidence-frozen', { pack })
    const stopped = this.#journal.append(state.retrievalId, 'retrieval/stopped', {
      reason: stoppingReason,
      remainingGapKinds: pack.remainingGaps.map(gap => gap.kind),
    })
    const next = this.#next(state, {
      phase: 'stopped',
      allowedActions: [],
      termination: stoppingReason,
      frozenEvidence: pack,
      provenance: { ...state.provenance, sourceEventIds: [frozen.eventId, stopped.eventId] },
    })
    this.#record(next)
    return next
  }

  stop(state: RetrievalState, reason: Extract<RetrievalTermination, 'budget_exhausted' | 'permission_blocked' | 'backend_error' | 'snapshot_invalid' | 'cancelled'>): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/stopped', { reason, remainingGapKinds: state.gaps.map(gap => gap.kind) })
    const next = this.#next(state, {
      phase: 'stopped',
      allowedActions: [],
      termination: reason,
      provenance: { ...state.provenance, sourceEventIds: [event.eventId] },
    })
    this.#record(next)
    return next
  }

  validateFrozenReferences(state: RetrievalState, displayIds: readonly string[], evidenceIds: readonly string[]): FrozenEvidencePack {
    const pack = state.frozenEvidence
    if (pack === undefined) throw new RetrievalError('INVALID_TRANSITION', '回答前必须冻结证据。')
    const allowedDisplayIds = new Set(pack.candidates.map(candidate => candidate.displayId))
    const allowedEvidenceIds = new Set<string>(pack.candidates.flatMap(candidate => candidate.evidenceIds))
    if (displayIds.some(id => !allowedDisplayIds.has(id)) || evidenceIds.some(id => !allowedEvidenceIds.has(id))) {
      throw new RetrievalError('UNAUTHORIZED', '最终回答引用了冻结证据包以外的工单或证据。')
    }
    return pack
  }

  #next(state: RetrievalState, patch: Partial<RetrievalState>): RetrievalState {
    const revision = state.revision + 1
    return {
      ...state,
      ...patch,
      stateId: RetrievalStateId(this.#stateId(state.retrievalId, revision)),
      previousStateId: state.stateId,
      revision,
      updatedAt: this.#now().toISOString(),
    }
  }

  #record(state: RetrievalState): void {
    this.#journal.append(state.retrievalId, 'retrieval/state-recorded', { state })
  }

  #stateId(retrievalId: string, revision: number): string {
    return `state_${retrievalId}_${revision}_${this.#id()}`
  }
}

export function openGapKinds(state: RetrievalState): RetrievalGapKind[] {
  return state.gaps.filter(gap => gap.status === 'open' || gap.status === 'unknown').map(gap => gap.kind)
}

export function confirmedFilters(state: RetrievalState): readonly TicketFilter[] {
  return state.query.confirmedConstraints
}
