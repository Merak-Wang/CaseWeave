import { randomUUID } from 'node:crypto'
import {
  RetrievalError,
  RetrievalId,
  MAX_L3_DETAILS_PER_READ,
  type EvidenceContextSelection,
  type FrozenEvidencePack,
  type RetrievalKnowledgeAssessment,
  type RetrievalState,
  type RetrievalTermination,
  type TicketCandidateRef,
  type TicketL3DetailsResult,
  type TicketQueryDelta,
  type TicketRetrievalMode,
  type TicketRetrievalProvider,
  type TicketRetrievalRequest,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { EvidenceContextPolicy } from './context.js'
import { RetrievalPolicyClient, type RetrievalPolicyGateway } from '@retrieval-agent/retrieval-policy'
import type { RetrievalEventJournal } from './journal.js'
import { applyQueryDelta } from './query.js'
import {
  allowedAction as action,
  candidateFacetValues as facetValues,
  coverageGaps as systemGaps,
  emptyBudget,
  requireAction as hasAction,
  taskCompletionSatisfied,
  stopReason,
  validateCandidateRefs as validateRefs,
} from './state-guards.js'
import { executeSearchTransition } from './search-transition.js'
import { fallbackQueryContract } from './query-contract.js'
import { modelRequestBudget, modelResponseBudget, toolCallBudget } from './runtime-budget.js'
import { advanceRetrievalState, recordMeasuredBudget, recordRetrievalState, retrievalStateId } from './state-transition.js'

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
  readonly retrievalPolicyBaseUrl?: string
  readonly retrievalPolicyDeadlineMs?: number
  /** Test or alternative Provider seam; not part of serialized product configuration. */
  readonly policy?: RetrievalPolicyGateway
  readonly now?: () => Date
  readonly id?: () => string
}

export interface RetrievalSearchInput {
  readonly mode: Extract<TicketRetrievalMode, 'keyword' | 'dense'>
  readonly delta?: TicketQueryDelta; readonly cursor?: string
}
/** Model intent is admitted only through these deterministic transitions. */
export class RetrievalController {
  readonly #provider: TicketRetrievalProvider
  readonly #journal: RetrievalEventJournal
  readonly #contextPolicy: EvidenceContextPolicy
  readonly #policy: RetrievalPolicyGateway
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
    this.#policy = config.policy ?? new RetrievalPolicyClient({
      baseUrl: config.retrievalPolicyBaseUrl ?? 'http://127.0.0.1:8012',
      deadlineMs: config.retrievalPolicyDeadlineMs ?? 5_000,
    })
    this.#rulesVersion = config.rulesVersion ?? 'retrieval-rules-v1'
    this.#promptVersion = config.promptVersion ?? 'retrieval-prompt-v2'
    this.#maxRounds = config.maxRounds ?? 8
    this.#maxSearches = config.maxSearches ?? 2_500
    this.#maxPromotions = config.maxPromotions ?? 3
    this.#maxEvidenceTokens = config.maxEvidenceTokens ?? 1_500
    this.#maxLatencyMs = config.maxLatencyMs ?? 120_000
    this.#noProgressLimit = config.noProgressLimit ?? 2
    this.#searchTopK = config.searchTopK ?? 20
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
      ...(spec.requestedCount === undefined ? {} : { requestedCount: spec.requestedCount }),
      countPolicy: spec.countPolicy,
      answerabilityPolicy: 'current_snapshot_evidence_only' as const,
      completenessRequirement: spec.countPolicy === 'exhaustive' ? 'exhaustive' as const : 'top_k' as const,
    }
    const contracted = this.#journal.append(retrievalId, 'retrieval/query-contracted', { contract: task, queryContract, spec })
    const snapshot = await this.#provider.openSnapshot(principal, { ...(signal === undefined ? {} : { signal }) })
    const opened = this.#journal.append(retrievalId, 'retrieval/snapshot-opened', { snapshot })
    const now = this.#now().toISOString()
    const state: RetrievalState = {
      retrievalId,
      stateId: retrievalStateId(retrievalId, 0, this.#id()),
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
    recordRetrievalState(this.#journal, state)
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

  async assess(state: RetrievalState, assessment: RetrievalKnowledgeAssessment, signal?: AbortSignal): Promise<RetrievalState> {
    hasAction(state, 'assess')
    const assessed = this.#journal.append(state.retrievalId, 'retrieval/knowledge-assessed', { assessment })
    const patch = await this.#policy.planKnowledgeAssessment(
      state, assessment, { noProgressLimit: this.#noProgressLimit }, signal,
    )
    const next = advanceRetrievalState(state, {
      ...patch,
      provenance: {
        ...state.provenance,
        ...(assessment.model === undefined ? {} : { model: assessment.model }),
        sourceEventIds: [assessed.eventId],
      },
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, state)
    return next
  }
  /** Only an exhausted empty Provider result is semantically safe to finish without a model assessment. */
  async finalizeExhaustedEmptyResult(state: RetrievalState, signal?: AbortSignal): Promise<RetrievalState> {
    const pagesExhausted = state.lastPage?.boundary?.resultPagesExhausted
      ?? (state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined)
    if (state.phase === 'stopped' || state.candidates.length > 0 || !pagesExhausted) return state
    const assessAction = state.allowedActions.find(candidate => candidate.kind === 'assess')
    if (assessAction === undefined) return state
    const assessed = await this.assess(state, {
      decision: 'no_result', evaluator: 'system',
      selectedCandidateRefs: [], excludedCandidateRefs: [], gaps: [],
      nextAction: 'finish_no_result',
    }, signal)
    return this.freeze(assessed, [])
  }

  /** Reauthorize one atomic batch of complete L3 source payloads. */
  async readL3Details(
    principal: TrustedPrincipalContext,
    state: RetrievalState,
    refs: readonly TicketCandidateRef[],
    signal?: AbortSignal,
  ): Promise<TicketL3DetailsResult> {
    const allowed = hasAction(state, 'read_l3_details')
    if (refs.length === 0 || refs.length > MAX_L3_DETAILS_PER_READ || new Set(refs).size !== refs.length) {
      throw new RetrievalError('INVALID_REQUEST', `L3 批量读取必须包含 1–${MAX_L3_DETAILS_PER_READ} 个不重复候选。`)
    }
    const selected = validateRefs(state, refs)
    if (selected.some(ref => !allowed.candidateAllowlist.includes(ref))) {
      throw new RetrievalError('UNAUTHORIZED', '批次中存在不在当前 L3 读取 allowlist 中的候选。')
    }
    if (state.snapshot === undefined || state.snapshot.capabilities.l3DetailsRead !== true) {
      throw new RetrievalError('SNAPSHOT_INVALID', '当前检索快照不支持批量 L3 原始详情读取。')
    }
    const result = await this.#provider.readL3Details(principal, {
      snapshotId: state.snapshot.snapshotId,
      candidateRefs: selected,
      purpose: 'model_ticket_load',
    }, signal === undefined ? undefined : { signal })
    if (result.snapshotId !== state.snapshot.snapshotId
      || result.requestedCandidateRefs.length !== selected.length
      || result.details.length !== selected.length) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回了错误数量或不同快照的批量 L3 原始详情。')
    }
    for (let index = 0; index < selected.length; index += 1) {
      const ref = selected[index]!
      const candidate = state.candidates.find(item => item.ref === ref)
      const detail = result.details[index]
      if (result.requestedCandidateRefs[index] !== ref || detail?.candidateRef !== ref
        || candidate === undefined || detail.displayId !== candidate.displayId
        || detail.sourceVersion !== candidate.sourceVersion || detail.contentHash !== candidate.contentHash) {
        throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 批量 L3 结果的顺序、身份、版本或内容 hash 不一致。')
      }
    }
    this.#journal.append(state.retrievalId, 'retrieval/l3-details-read', { details: result.details })
    return result
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
    const next = advanceRetrievalState(state, {
      phase: 'awaiting_clarification',
      clarification: { facet, question: normalizedQuestion, candidateRefs: selected },
      allowedActions: [action('answer_clarification', selected), action('read_state')],
      termination: 'needs_clarification',
      provenance: { ...state.provenance, sourceEventIds: [event.eventId] },
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, state)
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
    const next = advanceRetrievalState(state, {
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
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, state)
    return next
  }
  projectContext(state: RetrievalState, tokenBudget?: number): EvidenceContextSelection {
    const selection = this.#contextPolicy.select(state, tokenBudget)
    this.#journal.append(state.retrievalId, 'retrieval/context-projected', { selection })
    return selection
  }

  /** Persist one full-request admission decision before any model bytes are sent. */
  recordModelRequest(state: RetrievalState, input: Parameters<typeof modelRequestBudget>[1]): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/model-request-measured', input)
    return recordMeasuredBudget(this.#journal, state, event.eventId, modelRequestBudget(state.budget, input), this.#now, this.#id)
  }
  /** Persist settled model latency and provider-reported output use. */
  recordModelResponse(state: RetrievalState, input: Parameters<typeof modelResponseBudget>[1]): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/model-response-measured', {
      modelLatencyMs: input.modelLatencyMs,
      outputTokens: input.outputTokens,
    })
    return recordMeasuredBudget(this.#journal, state, event.eventId, modelResponseBudget(state.budget, input), this.#now, this.#id)
  }
  recordToolCall(state: RetrievalState, input: { readonly success: boolean; readonly serializationBytes: number }): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/tool-call-measured', input)
    return recordMeasuredBudget(this.#journal, state, event.eventId, toolCallBudget(state.budget, input), this.#now, this.#id)
  }
  freeze(state: RetrievalState, refs: readonly TicketCandidateRef[], reason?: Exclude<RetrievalTermination, 'active' | 'needs_clarification'>): RetrievalState {
    hasAction(state, 'freeze')
    return this.#freeze(state, refs, reason)
  }
  /**
   * Preserve already-authorized candidates when an execution safety ceiling is
   * reached before the model can submit a normal terminal assessment.
   */
  freezeForBudget(state: RetrievalState): RetrievalState {
    if (state.candidates.length === 0 || state.snapshot === undefined) return this.stop(state, 'budget_exhausted')
    return this.#freeze(state, state.candidates.map(candidate => candidate.ref), 'budget_exhausted')
  }
  stop(state: RetrievalState, reason: Extract<RetrievalTermination, 'budget_exhausted' | 'permission_blocked' | 'backend_error' | 'snapshot_invalid' | 'cancelled'>): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/stopped', { reason, remainingGapKinds: state.gaps.map(gap => gap.kind) })
    const next = advanceRetrievalState(state, {
      phase: 'stopped',
      allowedActions: [],
      termination: reason,
      provenance: { ...state.provenance, sourceEventIds: [event.eventId] },
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, state)
    return next
  }

  #freeze(
    state: RetrievalState,
    refs: readonly TicketCandidateRef[],
    reason?: Exclude<RetrievalTermination, 'active' | 'needs_clarification'>,
  ): RetrievalState {
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '当前检索没有有效快照。')
    const selected = validateRefs(state, refs)
    const taskSatisfied = taskCompletionSatisfied(
      state.task, state.candidates.length, state.lastPage, state.lastAssessment,
    )
    const resultPagesExhausted = state.lastPage?.boundary?.resultPagesExhausted
      ?? (state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined)
    const semanticRecallKnown = state.lastPage?.boundary?.semanticRecallKnown ?? false
    const nextPageAvailable = state.lastPage?.nextCursor !== undefined
    const searchBudgetExhausted = state.budget.searchesUsed >= state.budget.maxSearches
      || (state.budget.modelStepsUsed ?? state.budget.roundsUsed) >= state.budget.maxRounds
      || (state.budget.wallClockElapsedMs ?? state.budget.latencyMs) >= state.budget.maxLatencyMs
    const hasBlockingGap = state.gaps.some(gap => (gap.status === 'open' || gap.status === 'unknown')
      && gap.kind !== 'coverage' && gap.kind !== 'boundary')
    const stoppingReason = reason ?? (!taskSatisfied
      ? searchBudgetExhausted ? 'budget_exhausted' : 'partial'
      : selected.length === 0
        ? 'no_result'
        : hasBlockingGap ? 'partial' : 'top_k_accepted')
    if ((stoppingReason === 'top_k_accepted' || stoppingReason === 'no_result') && !taskSatisfied) {
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
          evidenceLevel: 'L2' as const,
          evidenceIds,
        }
      }),
      stoppingReason,
      remainingGaps: state.gaps.filter(gap => gap.status === 'open' || gap.status === 'unknown'),
      budget: state.budget,
      complete: semanticRecallKnown && resultPagesExhausted
        && (stoppingReason === 'top_k_accepted' || stoppingReason === 'no_result'),
      decisionFinalized: true,
      topKAccepted: state.task.completenessRequirement === 'top_k' && stoppingReason === 'top_k_accepted',
      resultPagesExhausted,
      semanticRecallKnown,
      resultMayBeIncomplete: (stoppingReason !== 'top_k_accepted' && stoppingReason !== 'no_result')
        || !semanticRecallKnown || !resultPagesExhausted,
      nextPageAvailable,
      providerId: state.snapshot.providerId,
      promptVersion: state.provenance.promptVersion,
    }
    const frozen = this.#journal.append(state.retrievalId, 'retrieval/evidence-frozen', { pack })
    const stopped = this.#journal.append(state.retrievalId, 'retrieval/stopped', {
      reason: stoppingReason,
      remainingGapKinds: pack.remainingGaps.map(gap => gap.kind),
    })
    const next = advanceRetrievalState(state, {
      phase: 'stopped',
      allowedActions: [],
      termination: stoppingReason,
      frozenEvidence: pack,
      provenance: { ...state.provenance, sourceEventIds: [frozen.eventId, stopped.eventId] },
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, state)
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
      policy: this.#policy,
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
    const next = advanceRetrievalState(state, result.patch, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, state)
    return next
  }
}
