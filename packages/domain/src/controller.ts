import { randomUUID } from 'node:crypto'
import {
  RetrievalError,
  RetrievalId,
  RetrievalStateId,
  type EvidenceContextSelection,
  type FrozenEvidencePack,
  type RetrievalKnowledgeAssessment,
  type RetrievalState,
  type RetrievalTermination,
  type TicketCandidateRef,
  type TicketEvidenceField,
  type TicketQueryDelta,
  type TicketRetrievalMode,
  type TicketRetrievalProvider,
  type TicketRetrievalRequest,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { EvidenceContextPolicy } from './context.js'
import { planKnowledgeAssessment } from '@retrieval-agent/retrieval-policy'
import type { RetrievalEventJournal } from './journal.js'
import { applyQueryDelta } from './query.js'
import {
  allowedAction as action,
  candidateFacetValues as facetValues,
  coverageGaps as systemGaps,
  emptyBudget,
  requireAction as hasAction,
  taskCompletionSatisfied,
  snapshotEvidenceFields,
  stopReason,
  validateCandidateRefs as validateRefs,
} from './state-guards.js'
import { executeSearchTransition } from './search-transition.js'
import { fallbackQueryContract } from './query-contract.js'
import { modelRequestBudget, modelResponseBudget, toolCallBudget } from './runtime-budget.js'

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

export interface RetrievalSearchInput {
  readonly mode: Extract<TicketRetrievalMode, 'keyword' | 'dense'>
  readonly delta?: TicketQueryDelta
  readonly cursor?: string
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
    const spec = this.#provider.resolve({ ...request, mode: 'hybrid' })
    const queryContract = request.queryContract ?? fallbackQueryContract(spec)
    const task = {
      target: spec.target,
      requestedCount: spec.requestedCount,
      countPolicy: spec.countPolicy,
      answerabilityPolicy: 'current_snapshot_evidence_only' as const,
      completenessRequirement: spec.target === 'constrained_list' || spec.target === 'cohort_collection' ? 'exhaustive' as const : 'top_k' as const,
    }
    const contracted = this.#journal.append(retrievalId, 'retrieval/query-contracted', { contract: task, queryContract, spec })
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
      query: { original: spec.originalQuery, spec, contract: queryContract, confirmedConstraints: [...spec.filters], unresolvedConstraints: [] },
      candidates: [],
      candidateHistory: [],
      rankingHistory: [],
      excludedCandidateRefs: [],
      selectedCandidateRefs: [],
      promotedEvidence: [],
      gaps: [
        { kind: 'coverage', status: 'unknown', evidenceRefs: [], evaluator: 'system' },
        ...spec.ambiguities.filter(ambiguity => ambiguity.kind !== 'quantity').map(ambiguity => ({
          kind: 'ambiguity' as const,
          status: 'open' as const,
          evidenceRefs: [],
          evaluator: 'system' as const,
          description: ambiguity.text,
        })),
      ],
      allowedActions: [action('search'), action('read_state')],
      budget: emptyBudget({
        maxRounds: this.#maxRounds,
        maxSearches: this.#maxSearches,
        maxPromotions: this.#maxPromotions,
        maxEvidenceTokens: this.#maxEvidenceTokens,
        maxLatencyMs: this.#maxLatencyMs,
      }),
      progress: { newCandidateRefs: [], newEvidenceIds: [], rankOverlap: 0, newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0 },
      termination: 'active',
      provenance: {
        rulesVersion: this.#rulesVersion,
        promptVersion: this.#promptVersion,
        contextPolicyVersion: this.#contextPolicy.version,
        sourceEventIds: [contracted.eventId, opened.eventId],
      },
    }
    this.#record(state)
    try {
      if (!snapshot.capabilities.keywordSearch || !snapshot.capabilities.denseSearch || !snapshot.capabilities.hybridFusion) {
        throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Provider 未声明首轮 Hybrid 所需的真实双通道能力。')
      }
      return await this.#executeSearch(principal, state, 'initial_hybrid', {}, signal)
    } catch (error) {
      const reason = stopReason(error)
      if (reason === undefined) throw error
      return this.stop(state, reason)
    }
  }

  async search(principal: TrustedPrincipalContext, state: RetrievalState, input: RetrievalSearchInput, signal?: AbortSignal): Promise<RetrievalState> {
    if (input.mode !== 'keyword' && input.mode !== 'dense') {
      throw new RetrievalError('INVALID_REQUEST', '后续检索通道必须是 keyword 或 dense。')
    }
    if ((input.delta === undefined) === (input.cursor === undefined)) {
      throw new RetrievalError('INVALID_REQUEST', '后续检索必须且只能提供 QueryDelta 或 Provider 游标之一。')
    }
    const expectedAction = state.lastAssessment?.decision === 'continue' ? state.lastAssessment.nextAction : undefined
    if (input.cursor === undefined && ((expectedAction === 'keyword_search' && input.mode !== 'keyword')
      || (expectedAction === 'vector_search' && input.mode !== 'dense'))) {
      throw new RetrievalError('INVALID_TRANSITION', '检索通道与已接受的知识状态下一动作不一致。')
    }
    return this.#executeSearch(principal, state, input.cursor === undefined ? 'repair_search' : 'next_page', input, signal)
  }
  /** Continue the current provider ranking without exposing its cursor to the model. */
  async continueRanking(principal: TrustedPrincipalContext, state: RetrievalState, signal?: AbortSignal): Promise<RetrievalState> {
    if (state.lastPage?.nextCursor === undefined) {
      throw new RetrievalError('INVALID_TRANSITION', '当前检索没有可继续的 Provider 排名页。')
    }
    return this.#executeSearch(principal, state, 'next_page', {
      mode: state.query.spec.mode,
      cursor: state.lastPage.nextCursor,
    }, signal)
  }

  assess(state: RetrievalState, assessment: RetrievalKnowledgeAssessment): RetrievalState {
    hasAction(state, 'assess')
    const assessed = this.#journal.append(state.retrievalId, 'retrieval/knowledge-assessed', { assessment })
    const patch = planKnowledgeAssessment(state, assessment, { noProgressLimit: this.#noProgressLimit })
    const next = this.#next(state, {
      ...patch,
      provenance: {
        ...state.provenance,
        ...(assessment.model === undefined ? {} : { model: assessment.model }),
        sourceEventIds: [assessed.eventId],
      },
    })
    this.#record(next)
    return next
  }
  /** Only an exhausted empty Provider result is semantically safe to finish without a model assessment. */
  finalizeExhaustedEmptyResult(state: RetrievalState): RetrievalState {
    const providerExhausted = state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined
    if (state.phase === 'stopped' || state.candidates.length > 0 || !providerExhausted) return state
    const assessAction = state.allowedActions.find(candidate => candidate.kind === 'assess')
    if (assessAction === undefined) return state
    const assessed = this.assess(state, {
      decision: 'no_result', coverage: 1, candidateQuality: 1,
      selectedCandidateRefs: [], excludedCandidateRefs: [], gaps: [],
      nextAction: 'finish', stop: true,
    })
    return this.freeze(assessed, [])
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
      promotionsUsed: state.budget.promotionsUsed + 1,
      evidenceTokensUsed: state.budget.evidenceTokensUsed + result.tokensUsed,
    }
    const next = this.#next(state, {
      phase: 'assessed',
      promotedEvidence: [...state.promotedEvidence, ...result.evidence],
      allowedActions: [
        action('assess', state.candidates.map(candidate => candidate.ref)),
        ...state.allowedActions.filter(candidate => candidate.kind === 'search_next' || candidate.kind === 'repair_search'),
        action('read_state'),
      ],
      budget,
      progress: { ...state.progress, newEvidenceIds: result.evidence.map(evidence => evidence.evidenceId), newDecisiveEvidence: result.evidence.length > 0, noProgressStreak: result.evidence.length > 0 ? 0 : state.progress.noProgressStreak + 1 },
      provenance: { ...state.provenance, sourceEventIds: [promoted.eventId] },
    })
    this.#record(next)
    return next
  }
  requestClarification(state: RetrievalState, facet: string, question: string, refs: readonly TicketCandidateRef[]): RetrievalState {
    hasAction(state, 'request_clarification')
    const field = state.snapshot?.fieldCatalog.find(candidate => candidate.key === facet && candidate.accessLevel === 'L0')
    if (field === undefined) throw new RetrievalError('FIELD_NOT_ALLOWED', '澄清字段未由当前授权快照声明为 L0。')
    if (!field.filterOperators.includes('eq') && !field.filterOperators.includes('contains')) {
      throw new RetrievalError('FIELD_NOT_ALLOWED', '澄清字段必须能转换为当前 Provider 支持的类型化过滤条件。')
    }
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
  answerClarification(state: RetrievalState, input: { readonly accepted: boolean; readonly answer?: string }): RetrievalState {
    hasAction(state, 'answer_clarification')
    if (state.clarification === undefined) throw new RetrievalError('INVALID_TRANSITION', '当前没有待回答的澄清问题。')
    const answer = input.answer?.trim()
    if (input.accepted && (answer === undefined || answer.length === 0)) {
      throw new RetrievalError('INVALID_REQUEST', '接受澄清时必须提供非空答案。')
    }
    const descriptor = state.snapshot?.fieldCatalog.find(field => field.key === state.clarification!.facet)
    const operator = descriptor?.filterOperators.includes('eq') === true
      ? 'eq' as const
      : descriptor?.filterOperators.includes('contains') === true ? 'contains' as const : undefined
    if (input.accepted && operator === undefined) {
      throw new RetrievalError('FIELD_NOT_ALLOWED', '澄清答案无法转换为 Provider 支持的类型化过滤条件。')
    }
    const spec = input.accepted
      ? applyQueryDelta(state.query.spec, {
          kind: 'add_filter',
          filter: { field: state.clarification.facet, op: operator!, value: answer! },
        })
      : state.query.spec
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
        ...(state.query.contract === undefined ? {} : {
          contract: { ...state.query.contract, normalized: spec.normalizedQuery, constraints: [...spec.filters] },
        }),
        confirmedConstraints: [...spec.filters],
        unresolvedConstraints: input.accepted ? [] : [...state.query.unresolvedConstraints, state.clarification.facet],
      },
      gaps: state.gaps.map(gap => input.accepted
        && ['ambiguity', 'boundary', 'constraint'].includes(gap.kind)
        && (gap.status === 'open' || gap.status === 'unknown')
        ? { ...gap, status: 'resolved' as const }
        : gap),
      clarification: { ...state.clarification, ...(answer === undefined ? {} : { answer }) },
      selectedCandidateRefs: [],
      lastAssessment: undefined,
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

  /** Persist one full-request admission decision before any model bytes are sent. */
  recordModelRequest(state: RetrievalState, input: Parameters<typeof modelRequestBudget>[1]): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/model-request-measured', input)
    return this.#recordMeasuredBudget(state, event.eventId, modelRequestBudget(state.budget, input))
  }
  /** Persist settled model latency and provider-reported output use. */
  recordModelResponse(state: RetrievalState, input: Parameters<typeof modelResponseBudget>[1]): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/model-response-measured', {
      modelLatencyMs: input.modelLatencyMs,
      outputTokens: input.outputTokens,
    })
    return this.#recordMeasuredBudget(state, event.eventId, modelResponseBudget(state.budget, input))
  }
  recordToolCall(state: RetrievalState, input: { readonly success: boolean; readonly serializationBytes: number }): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/tool-call-measured', input)
    return this.#recordMeasuredBudget(state, event.eventId, toolCallBudget(state.budget, input))
  }
  freeze(state: RetrievalState, refs: readonly TicketCandidateRef[], reason?: Exclude<RetrievalTermination, 'active' | 'needs_clarification'>): RetrievalState {
    hasAction(state, 'freeze')
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '当前检索没有有效快照。')
    const selected = validateRefs(state, refs)
    const taskSatisfied = taskCompletionSatisfied(
      state.task, state.candidates.length, state.lastPage, state.lastAssessment,
    )
    const sourceExhausted = state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined
    const nextPageAvailable = state.lastPage?.nextCursor !== undefined
    const searchBudgetExhausted = state.budget.searchesUsed >= state.budget.maxSearches
      || (state.budget.modelStepsUsed ?? state.budget.roundsUsed) >= state.budget.maxRounds
      || (state.budget.wallClockElapsedMs ?? state.budget.latencyMs) >= state.budget.maxLatencyMs
    const hasBlockingGap = state.gaps.some(gap => (gap.status === 'open' || gap.status === 'unknown')
      && (gap.kind !== 'coverage' || state.task.completenessRequirement === 'exhaustive'))
    const stoppingReason = reason ?? (!taskSatisfied
      ? searchBudgetExhausted ? 'budget_exhausted' : 'partial'
      : selected.length === 0
        ? 'no_result'
        : hasBlockingGap ? 'partial' : 'sufficient')
    if ((stoppingReason === 'sufficient' || stoppingReason === 'no_result') && !taskSatisfied) {
      throw new RetrievalError('INVALID_TRANSITION', '当前检索尚未满足任务停止条件，不能冻结为充分结果。')
    }
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
      complete: sourceExhausted && (stoppingReason === 'sufficient' || stoppingReason === 'no_result'),
      decisionFinalized: true,
      topKAccepted: state.task.completenessRequirement === 'top_k' && stoppingReason === 'sufficient',
      sourceExhausted,
      resultMayBeIncomplete: !sourceExhausted,
      nextPageAvailable,
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

  async #executeSearch(
    principal: TrustedPrincipalContext,
    state: RetrievalState,
    stage: 'initial_hybrid' | 'repair_search' | 'next_page',
    input: {
      readonly mode?: TicketRetrievalMode
      readonly delta?: TicketQueryDelta
      readonly cursor?: string
    },
    signal?: AbortSignal,
  ): Promise<RetrievalState> {
    const result = await executeSearchTransition({
      provider: this.#provider,
      journal: this.#journal,
      principal,
      state,
      stage,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.delta === undefined ? {} : { delta: input.delta }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(signal === undefined ? {} : { signal }),
      topK: this.#searchTopK,
      maxScan: this.#searchMaxScan,
    })
    const next = this.#next(state, result.patch)
    this.#record(next)
    return next
  }

  #next(state: RetrievalState, patch: Partial<RetrievalState>): RetrievalState {
    const revision = state.revision + 1
    const next: RetrievalState = {
      ...state,
      ...patch,
      stateId: RetrievalStateId(this.#stateId(state.retrievalId, revision)),
      previousStateId: state.stateId,
      revision,
      updatedAt: this.#now().toISOString(),
    }
    if (next.lastAssessment !== undefined) return next
    const { lastAssessment: _lastAssessment, ...serializable } = next
    return serializable
  }

  #record(state: RetrievalState): void {
    this.#journal.append(state.retrievalId, 'retrieval/state-recorded', { state })
  }

  #recordMeasuredBudget(state: RetrievalState, eventId: string, budget: RetrievalState['budget']): RetrievalState {
    const next = this.#next(state, { budget, provenance: { ...state.provenance, sourceEventIds: [eventId] } })
    this.#record(next)
    return next
  }

  #stateId(retrievalId: string, revision: number): string {
    return `state_${retrievalId}_${revision}_${this.#id()}`
  }
}
