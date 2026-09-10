import { createHash, randomUUID } from 'node:crypto'
import {
  RetrievalError,
  asRetrievalError,
  RetrievalId,
  MAX_EVIDENCE_CANDIDATES_PER_READ,
  type EvidenceContextSelection,
  type FrozenEvidencePack,
  type RetrievalDecision,
  type TicketEvidenceSegment,
  type TicketDetailResult,
  type CandidateDetailReadReceipt,
  type TicketFilter,
  type TicketUserRequirement,
  type TicketQueryAmbiguity,
  type RetrievalState,
  type RetrievalTermination,
  type TicketCandidateRef,
  type TicketCandidate,
  type TicketQueryDelta,
  type TicketRetrievalMode,
  type TicketRetrievalProvider,
  type TicketRetrievalRequest,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { EvidenceContextPolicy } from './context.js'
import type { RetrievalEventJournal } from './journal.js'
import { admitDecision, finishReason, validateVisibleEvidence } from './decision.js'
import {
  allowedAction as action,
  emptyBudget,
  requireAction as hasAction,
  stopReason,
  validateCandidateRefs as validateRefs,
} from './state-guards.js'
import { executeSearchTransition } from './search-transition.js'
import { fallbackQueryContract } from './query-contract.js'
import { reviseQueryPlan, resolvePlanRequirements } from './query.js'
import { modelRequestBudget, modelResponseBudget, toolCallBudget } from './runtime-budget.js'
import { advanceRetrievalState, recordMeasuredBudget, recordRetrievalState, retrievalStateId } from './state-transition.js'
import { planExperts, findingPatch, type ExpertUpdate } from './experts.js'
import { updateCandidateRanking } from './policy.js'

function frozenCandidate(candidate: TicketCandidate, evidence: readonly TicketEvidenceSegment[]): FrozenEvidencePack['candidates'][number] {
  const supporting = evidence.filter(item => item.candidateRef === candidate.ref)
  return { ref: candidate.ref, displayId: candidate.displayId, sourceVersion: candidate.sourceVersion,
    contentHash: candidate.contentHash, evidenceIds: supporting.map(item => item.evidenceId),
    evidenceLevel: supporting.some(item => item.evidenceLevel === 'L2') ? 'L2' : 'L1' }
}

export interface RetrievalControllerConfig {
  readonly onState?: (state: RetrievalState) => void | Promise<void>
  readonly retrievalId?: RetrievalId
  readonly initialInformation?: readonly RetrievalClarificationAnswer[]
  readonly rulesVersion?: string
  readonly promptVersion?: string
  readonly maxSearches?: number
  readonly maxRepeatedToolErrors?: number
  readonly searchTopK?: number
  readonly searchMaxScan?: number
  /** Test or alternative Provider seam; not part of serialized product configuration. */
  readonly now?: () => Date
  readonly id?: () => string
}

export interface RetrievalClarificationAnswer {
  readonly accepted: boolean
  readonly answer?: string
  readonly filters?: readonly TicketFilter[]
  /** Direct user revisions only. Agent search tools cannot grant this permission. */
  readonly removedFilterFields?: readonly string[]
  readonly requirements?: readonly TicketUserRequirement[]
  readonly ambiguities?: readonly TicketQueryAmbiguity[]
  readonly result?: { readonly countPolicy: 'explicit' | 'adaptive' | 'exhaustive'; readonly requestedCount?: number }
}

export interface RetrievalSearchInput {
  readonly mode: Extract<TicketRetrievalMode, 'keyword' | 'dense'>
  readonly delta?: TicketQueryDelta; readonly cursor?: string
}
/** Model intent is admitted only through these deterministic transitions. */
export class RetrievalController {
  /** Uncommitted decision proposals keep their original durable base until the action succeeds. */
  readonly #proposalBases = new WeakMap<RetrievalState, RetrievalState>()
  readonly #provider: TicketRetrievalProvider
  readonly #journal: RetrievalEventJournal
  readonly #contextPolicy: EvidenceContextPolicy
  readonly #rulesVersion: string
  readonly #promptVersion: string
  readonly #maxSearches: number
  readonly #maxRepeatedToolErrors: number | undefined
  readonly #searchTopK: number
  readonly #searchMaxScan: number
  readonly #now: () => Date
  readonly #id: () => string
  readonly #onState: RetrievalControllerConfig['onState']
  readonly #retrievalId: RetrievalId | undefined
  readonly #initialInformation: readonly RetrievalClarificationAnswer[]

  constructor(provider: TicketRetrievalProvider, journal: RetrievalEventJournal, contextPolicy = new EvidenceContextPolicy(), config: RetrievalControllerConfig = {}) {
    this.#provider = provider
    this.#journal = journal
    this.#contextPolicy = contextPolicy
    this.#rulesVersion = config.rulesVersion ?? 'retrieval-rules-v1'
    this.#promptVersion = config.promptVersion ?? 'retrieval-prompt-v2'
    this.#maxSearches = config.maxSearches ?? 2_500
    this.#maxRepeatedToolErrors = config.maxRepeatedToolErrors ?? 4
    if (this.#maxRepeatedToolErrors !== undefined && (!Number.isSafeInteger(this.#maxRepeatedToolErrors) || this.#maxRepeatedToolErrors < 1)) throw new TypeError('maxRepeatedToolErrors must be a positive integer')
    this.#searchTopK = config.searchTopK ?? 20
    this.#searchMaxScan = config.searchMaxScan ?? 50_000
    this.#now = config.now ?? (() => new Date())
    this.#id = config.id ?? (() => randomUUID())
    this.#onState = config.onState
    this.#retrievalId = config.retrievalId
    this.#initialInformation = config.initialInformation ?? []
  }

  async start(principal: TrustedPrincipalContext, request: TicketRetrievalRequest, signal?: AbortSignal): Promise<RetrievalState> {
    const retrievalId = this.#retrievalId ?? RetrievalId(this.#id())
    let spec = this.#provider.resolve({ ...request, mode: 'hybrid' })
    let queryContract = request.queryContract ?? fallbackQueryContract(spec)
    const task = {
      target: spec.target,
      ...(spec.requestedCount === undefined ? {} : { requestedCount: spec.requestedCount }),
      countPolicy: spec.countPolicy,
      answerabilityPolicy: 'current_snapshot_evidence_only' as const,
      completenessRequirement: spec.countPolicy === 'exhaustive' ? 'exhaustive' as const : 'top_k' as const,
    }
    const contracted = this.#journal.append(retrievalId, 'retrieval/query-contracted', { contract: task, queryContract, spec })
    const snapshot = await this.#provider.openSnapshot(principal, { ...(signal === undefined ? {} : { signal }) })
    const queryFields = snapshot.queryFields ?? snapshot.fieldCatalog.flatMap(f => f.capability ? [f.capability] : [])
    if (spec.queryPlan && queryFields.length) {
      spec = { ...spec, queryPlan: { ...spec.queryPlan, fields: queryFields } }
      queryContract = { ...queryContract, queryPlan: spec.queryPlan! }
    }
    const unavailable = new Set(queryFields.filter(f => f.availability === 'unavailable').map(f => f.key))
    if (spec.queryPlan && unavailable.size) {
      const referencesUnavailable = (e: import('@retrieval-agent/contracts').QueryExpression): boolean => {
        if (e.kind === 'field') return e.op !== 'exists' && unavailable.has(e.field)
        if (e.kind === 'literal') return e.field !== undefined && unavailable.has(e.field)
        if (e.kind === 'and' || e.kind === 'or') return e.children.some(referencesUnavailable)
        if (e.kind === 'not') return referencesUnavailable(e.child)
        return false
      }
      const missing = spec.queryPlan.requirements.filter(r => r.expression && referencesUnavailable(r.expression))
      if (missing.length) {
        const ambiguities = [...spec.ambiguities, ...missing.map(r => ({ kind: 'constraint' as const, text: `${r.span.text}：当前数据源没有可核验的字段值。` }))]
        spec = { ...spec, ambiguities }
        queryContract = { ...queryContract, queryPlan: spec.queryPlan!, ambiguities }
      }
    }
    const opened = this.#journal.append(retrievalId, 'retrieval/snapshot-opened', { snapshot })
    const now = this.#now().toISOString()
    let state: RetrievalState = {
      retrievalId,
      stateId: retrievalStateId(retrievalId, 0, this.#id()),
      revision: 0,
      createdAt: now,
      updatedAt: now,
      phase: 'snapshot_opened',
      task,
      principalBindingHash: snapshot.principalBindingHash,
      snapshot,
      query: { original: spec.originalQuery, spec, contract: queryContract, confirmedConstraints: [...spec.filters],
        unresolvedConstraints: spec.ambiguities.filter(ambiguity => ambiguity.kind !== 'quantity').map(ambiguity => ambiguity.text) },
      candidates: [],
      candidateHistory: [],
      rankingHistory: [],
      excludedCandidateRefs: [],
      selectedCandidateRefs: [],
      promotedEvidence: [], projectionVersion: 2, inputGeneration: 0, contextManifests: [], expertTasks: [], expertConflicts: [],
      judgments: [], modelVisibleCandidateRefs: [], modelVisibleEvidenceIds: [], candidateWindowOffset: 0,
      executionClock: { totalWaitingMs: 0 }, accessValidation: 'current',
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
      budget: { ...emptyBudget({ maxSearches: this.#maxSearches }), ...(this.#maxRepeatedToolErrors === undefined ? {} : { maxRepeatedToolErrors: this.#maxRepeatedToolErrors }), consecutiveToolErrors: 0 },
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
    for (const information of this.#initialInformation) state = this.#applyUserInformation(state, information, false)
    // Initial information admission precedes any I/O; restore first-pass admission after its transition.
    if (this.#initialInformation.length) {
      state = this.#record(state, { phase: 'snapshot_opened', allowedActions: [action('search'), action('read_state')] })
    }
    await this.#onState?.(state)
    try {
      if (!snapshot.capabilities.keywordSearch || !snapshot.capabilities.denseSearch || !snapshot.capabilities.hybridFusion) {
        throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Provider 未声明首轮 Hybrid 所需的真实双通道能力。')
      }
      return await this.#executeSearch(principal, state, 'initial_hybrid', {}, signal)
    } catch (error) {
      if (!(error instanceof RetrievalError)) throw error
      const reason = stopReason(error)
      if (reason === undefined) throw error
      return this.stop(state, reason, error)
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

  /** Exhausted empty Provider pages can finish without a semantic model judgment. */
  async finalizeExhaustedEmptyResult(state: RetrievalState, _signal?: AbortSignal): Promise<RetrievalState> {
    if (state.phase === 'stopped' || state.candidates.length > 0 || !state.lastPage?.boundary.resultPagesExhausted
      || state.query.unresolvedConstraints.length > 0) return state
    const current = this.#record(state, {
      stopExplanation: '当前查询范围的结果页已用尽，未找到候选工单。',
    })
    return this.#freeze(current, [], 'no_result')
  }

  #requestClarification(state: RetrievalState, facet: string, question: string, refs: readonly TicketCandidateRef[],
    evidenceRefs: readonly string[] = refs, options?: readonly string[]): RetrievalState {
    hasAction(state, 'request_clarification')
    const selected = validateRefs(state, refs)
    const pendingConstraint = state.candidates.length === 0 && selected.length === 0
      && state.query.unresolvedConstraints.length > 0
    const groundedAmbiguity = selected.length > 0 && state.gaps.some(g => g.kind === 'ambiguity'
      && g.evaluator === 'model' && ['open', 'unknown'].includes(g.status) && selected.some(ref => g.evidenceRefs.includes(ref)))
    if (selected.length < 2 && !pendingConstraint && !groundedAmbiguity) throw new RetrievalError('INVALID_REQUEST', '澄清需引用真实候选差异，或有候选证据支持的未解决业务歧义。')
    const normalizedQuestion = question.trim()
    const questionKey = (text: string): string => text.normalize('NFKC').replace(/[\s\p{P}]+/gu, '')
    if ((state.clarification?.answer && questionKey(state.clarification.question) === questionKey(normalizedQuestion))
      || state.userFeedback?.some(item => item.question && questionKey(item.question) === questionKey(normalizedQuestion))) {
      throw new RetrievalError('INVALID_REQUEST', '用户已回答这个问题。读取 userFeedback 和 clarification，沿已确认口径继续取证与判断，不要再次询问或重新启动检索。')
    }
    if (normalizedQuestion.length < 2 || normalizedQuestion.length > 500) {
      throw new RetrievalError('INVALID_REQUEST', '澄清问题或候选差异依据无效。')
    }
    if (pendingConstraint) {
      const quoted = state.query.unresolvedConstraints.some(text => normalizedQuestion.includes(text.split('：')[0]!))
      if (!quoted) throw new RetrievalError('INVALID_REQUEST', '没有候选差异时，澄清问题必须引用具体的待确认条件。')
    } else if (evidenceRefs.length === 0) {
      throw new RetrievalError('INVALID_REQUEST', '澄清问题或候选差异依据无效。')
    }
    validateVisibleEvidence(state, [...selected, ...evidenceRefs])
    const event = this.#journal.append(state.retrievalId, 'retrieval/clarification-requested', { facet, question: normalizedQuestion, candidateRefs: selected })
    const next = advanceRetrievalState(state, {
      phase: 'awaiting_clarification',
      clarification: { facet, question: normalizedQuestion, candidateRefs: selected, evidenceRefs,
        ...(options === undefined ? {} : { options }) },
      executionClock: { totalWaitingMs: state.executionClock?.totalWaitingMs ?? 0, waitingSince: this.#now().toISOString() },
      allowedActions: [action('answer_clarification', selected), action('read_state')],
      termination: 'needs_clarification',
      provenance: { ...state.provenance, sourceEventIds: [event.eventId] },
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, this.#proposalBases.get(state) ?? state)
    return next
  }

  /** Preserve free-form user information; interpreting it is a model/query contract task. */
  #applyUserInformation(state: RetrievalState, input: RetrievalClarificationAnswer, answering: boolean): RetrievalState {
    const unavailable = new Set(state.snapshot?.queryFields?.filter(field => field.availability === 'unavailable').map(field => field.key) ?? [])
    const unsupported = (input.filters ?? []).filter(filter => unavailable.has(filter.field))
    if (unsupported.length) {
      input = { ...input,
        requirements: (input.requirements ?? []).map(requirement => requirement.filters.some(filter => unavailable.has(filter.field))
          ? { ...requirement, status: 'unresolved' as const } : requirement),
        ambiguities: [...(input.ambiguities ?? []), ...unsupported.map(filter => ({ kind: 'constraint' as const,
          text: `${filter.field}=${filter.value}：当前数据源没有可核验的字段值。` }))],
      }
    }
    if (answering) {
      hasAction(state, 'answer_clarification')
      if (state.clarification === undefined) throw new RetrievalError('INVALID_TRANSITION', '当前没有待回答的澄清问题。')
    }
    const answer = input.answer?.trim()
    if (input.accepted && !answer) throw new RetrievalError('INVALID_REQUEST', '接受澄清时必须提供非空答案。')
    if (input.result?.countPolicy === 'explicit' && (!Number.isSafeInteger(input.result.requestedCount) || input.result.requestedCount! < 1)) {
      throw new RetrievalError('INVALID_REQUEST', '用户结果数量必须是正安全整数。')
    }
    const event = answering
      ? this.#journal.append(state.retrievalId, 'retrieval/clarification-answered', {
        facet: state.clarification!.facet, accepted: input.accepted, ...(answer === undefined ? {} : { answer }),
      })
      : this.#journal.append(state.retrievalId, 'retrieval/user-feedback-received', { text: answer ?? '' })
    const waitingSince = state.executionClock?.waitingSince ?? (state.phase === 'stopped' ? state.updatedAt : undefined)
    const waiting = waitingSince === undefined ? 0 : Math.max(0, this.#now().getTime() - Date.parse(waitingSince))
    const changedFields = new Set([...(input.filters ?? []).map(filter => filter.field), ...(input.removedFilterFields ?? [])])
    const updatedFilters = [...state.query.spec.filters.filter(filter => !changedFields.has(filter.field)), ...(input.filters ?? [])]
    const replacedQuantityTexts = input.result === undefined ? [] : state.query.spec.ambiguities
      .filter(item => item.kind === 'quantity').map(item => item.text)
    const oldRequirements = state.query.contract?.userRequirements ?? []
    const normalizedText = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, '')
    const answerText = normalizedText(answer ?? '')
    // 用户重述得更精确的待确认条件由本次补充取代；否则空 filters 的旧 unresolved 条件永远无法清除。
    const superseded = (requirement: TicketUserRequirement): boolean => {
      if (requirement.filters.some(filter => changedFields.has(filter.field))) return true
      if (replacedQuantityTexts.includes(requirement.text)) return true
      if (requirement.status !== 'unresolved' || requirement.text.trim().length === 0) return false
      const text = normalizedText(requirement.text)
      return answerText.includes(text)
        || (input.requirements ?? []).some(item => normalizedText(item.text).includes(text))
    }
    const supersededTexts = oldRequirements.filter(superseded).map(requirement => requirement.text)
    const supersededAmbiguity = (text: string): boolean =>
      supersededTexts.some(superseded => text === superseded || text.startsWith(`${superseded}：`))
    const requirements = [...oldRequirements.filter(requirement => !superseded(requirement)),
      ...(input.requirements ?? [])]
    const changesConditions = changedFields.size > 0
    const hasNewRequirements = (input.requirements?.length ?? 0) > 0 || (input.ambiguities?.length ?? 0) > 0
    const ambiguities = [...state.query.spec.ambiguities
      .filter(item => (input.result === undefined || item.kind !== 'quantity') && !supersededAmbiguity(item.text)),
      ...(input.ambiguities ?? [])]
    const unresolved = [...new Set([
      ...requirements.filter(requirement => requirement.status === 'unresolved').map(requirement => requirement.text),
      ...(input.ambiguities ?? []).filter(ambiguity => ambiguity.kind !== 'quantity').map(ambiguity => ambiguity.text),
    ])]
    const result = input.result
    const { requestedCount: _previousTaskCount, ...taskWithoutCount } = state.task
    const { requestedCount: _previousSpecCount, ...specWithoutCount } = state.query.spec
    const task = result === undefined ? state.task : { ...taskWithoutCount, countPolicy: result.countPolicy,
      ...(result.countPolicy === 'explicit' ? { requestedCount: result.requestedCount! } : {}),
      completenessRequirement: result.countPolicy === 'exhaustive' ? 'exhaustive' as const : 'top_k' as const }
    const baseSpec = state.query.spec.queryPlan && changesConditions ? { ...state.query.spec,
      queryPlan: resolvePlanRequirements(reviseQueryPlan(state.query.spec.queryPlan, input.filters ?? [], input.removedFilterFields ?? [],
        input.removedFilterFields?.length ? supersededTexts : []),
        supersededTexts.map(text => ({ text, filters: input.filters ?? [] }))) } : state.query.spec
    const spec = result === undefined ? baseSpec : { ...specWithoutCount, ...(baseSpec.queryPlan ? { queryPlan: baseSpec.queryPlan } : {}), countPolicy: result.countPolicy,
      ...(result.countPolicy === 'explicit' ? { requestedCount: result.requestedCount! } : {}) }
    let contract = state.query.contract
    if (result !== undefined && contract !== undefined) {
      const { resultLimit: _previousLimit, maxResults: _legacyLimit, ...withoutCount } = contract
      contract = { ...withoutCount, resultPolicy: result.countPolicy === 'explicit' ? 'explicit_top_k'
        : result.countPolicy === 'exhaustive' ? 'exhaustive_current_snapshot' : 'adaptive_top_k',
        ...(result.countPolicy === 'explicit' ? { resultLimit: result.requestedCount! } : {}) }
    }
    const query = changesConditions || hasNewRequirements || result !== undefined ? {
      ...state.query, spec: { ...spec, filters: updatedFilters, ambiguities }, confirmedConstraints: updatedFilters,
      ...(contract === undefined ? {} : { contract: { ...contract, ...(spec.queryPlan ? { queryPlan: spec.queryPlan } : {}), constraints: updatedFilters, userRequirements: requirements, ambiguities } }),
      unresolvedConstraints: unresolved,
    } : state.query
    const next = advanceRetrievalState(state, {
      phase: 'assessed', query, task, evidenceWindowOffset: 0, coordinatorActivity: 'working',
      // A user may change a semantic business requirement without changing an L0 filter.
      // Previous accepts/excludes then need a fresh judgment against the new information.
      selectedCandidateRefs: [], excludedCandidateRefs: [], judgments: [],
      frozenEvidence: undefined, stopExplanation: undefined, stopErrorCode: undefined,
      inputGeneration: (state.inputGeneration ?? 0) + 1,
      budget: { ...state.budget, consecutiveToolErrors: 0 },
      expertTasks: state.expertTasks?.map(t => ({ ...t, status: 'superseded' as const })) ?? [], expertConflicts: [],
      contextCandidateRefs: undefined, evidenceReadPosition: undefined,
      gaps: [...state.gaps.filter(gap => gap.evaluator === 'system' && !replacedQuantityTexts.includes(gap.description ?? '')
        && !(['ambiguity', 'constraint'].includes(gap.kind) && supersededAmbiguity(gap.description ?? ''))),
        ...unresolved.filter(text => !state.query.unresolvedConstraints.includes(text)).map(description => ({
        kind: 'constraint' as const, status: 'open' as const, evaluator: 'system' as const, evidenceRefs: [], description,
      }))],
      ...(changesConditions ? { candidates: [], lastPage: undefined,
        modelVisibleCandidateRefs: [], modelVisibleEvidenceIds: [], candidateWindowOffset: 0 } : {}),
      ...(answering ? { clarification: { ...state.clarification!, ...(answer === undefined ? {} : { answer }) } } : {}),
      userFeedback: [...(state.userFeedback ?? []), ...(answer === undefined ? [] : [{ text: answer, receivedAt: this.#now().toISOString(),
        ...(answering && state.clarification ? { question: state.clarification.question } : {}) }])],
      executionClock: { totalWaitingMs: (state.executionClock?.totalWaitingMs ?? 0) + waiting },
      lastAssessment: undefined,
      allowedActions: [action('assess', changesConditions ? [] : state.candidates.map(candidate => candidate.ref)), action('repair_search'),
        ...(changesConditions || state.lastPage?.nextCursor === undefined ? [] : [action('search_next')]), action('read_state')],
      termination: 'active',
      provenance: { ...state.provenance, sourceEventIds: [event.eventId] },
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, this.#proposalBases.get(state) ?? state)
    return next
  }

  async resumeClarification(principal: TrustedPrincipalContext, state: RetrievalState,
    input: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState> {
    const current = await this.reauthorize(principal, state, signal)
    if (current.phase === 'stopped') return current
    const answered = this.#applyUserInformation(current, input, true)
    return this.#requalifyUserInformation(principal, answered, input, signal)
  }

  /** Direct user supplements update the existing active task through the same authority boundary. */
  async applyUserFeedback(principal: TrustedPrincipalContext, state: RetrievalState,
    input: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState> {
    const current = await this.reauthorize(principal, state, signal)
    if (['permission_blocked', 'snapshot_invalid', 'backend_error'].includes(current.termination)) return current
    const updated = this.#applyUserInformation(current, input, current.phase === 'awaiting_clarification')
    return this.#requalifyUserInformation(principal, updated, input, signal)
  }

  /** A pending business question does not block enumeration of the already authorized query. */
  async continueIndependentPage(principal: TrustedPrincipalContext, state: RetrievalState, signal?: AbortSignal): Promise<RetrievalState> {
    if (state.phase !== 'awaiting_clarification' || !state.lastPage?.nextCursor) throw new RetrievalError('INVALID_TRANSITION', '当前没有独立于问题的待取结果页。')
    const admitted = { ...state, allowedActions: [...state.allowedActions, action('search_next')] }
    this.#proposalBases.set(admitted, state)
    return this.#executeSearch(principal, admitted, 'next_page', { mode: state.query.spec.mode, cursor: state.lastPage.nextCursor }, signal)
  }

  /** Trusted command admission is synchronous; requalification runs as a separate durable job. */
  acceptUserInformation(state: RetrievalState, input: RetrievalClarificationAnswer, answering = false): RetrievalState {
    return this.#applyUserInformation(state, input, answering)
  }

  /** Resume an interrupted first pass or requalify the current requirements without inventing a new task. */
  async refreshSearch(principal: TrustedPrincipalContext, state: RetrievalState, signal?: AbortSignal): Promise<RetrievalState> {
    let current = await this.reauthorize(principal, state, signal)
    if (current.phase === 'stopped' && current.termination === 'backend_error' && current.accessValidation === 'current') {
      current = this.#record(current, { phase: 'assessed', termination: 'active', stopExplanation: undefined, stopErrorCode: undefined,
        allowedActions: [action('repair_search'), action('read_state')] })
    }
    if (current.phase === 'stopped') return current
    return this.#executeSearch(principal, current,
      current.phase === 'snapshot_opened' ? 'initial_hybrid' : 'repair_search',
      current.phase === 'snapshot_opened' ? {} : { mode: 'hybrid', delta: { kind: 'semantic_hint', text: current.query.original } }, signal)
  }

  async #requalifyUserInformation(principal: TrustedPrincipalContext, state: RetrievalState,
    input: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState> {
    if ((input.filters?.length ?? 0) === 0) return state
    // A failed refresh must retain the already committed user information in the returned state too.
    try {
      return await this.#executeSearch(principal, state, 'repair_search', {
        mode: 'keyword', delta: { kind: 'semantic_hint', text: input.answer! },
      }, signal)
    } catch (error) {
      const failure = asRetrievalError(error)
      const failed = { ...state, stopExplanation: failure.publicMessage }
      this.#proposalBases.set(failed, state)
      return this.stop(failed, stopReason(failure) ?? 'backend_error', failure)
    }
  }

  /** Every replay presentation and resumed wait checks the trusted Provider again. */
  async reauthorize(principal: TrustedPrincipalContext, state: RetrievalState, signal?: AbortSignal): Promise<RetrievalState> {
    try {
      if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '没有可重新授权的历史快照。')
      const status = await this.#provider.status(principal, state.snapshot.snapshotId)
      if (status.snapshotValid !== true || (status.sourceVersion !== undefined && status.sourceVersion !== state.snapshot.sourceVersion)) {
        throw new RetrievalError('SNAPSHOT_INVALID', '历史快照或来源版本已失效，必须重新检索。')
      }
      if (!status.ready) throw new RetrievalError('PROVIDER_UNAVAILABLE', '当前工单来源不可用。')
      if (state.candidates.length > 0) {
        const result = await this.#provider.readEvidence(principal, {
          snapshotId: state.snapshot.snapshotId, candidateRefs: state.candidates.map(candidate => candidate.ref), fields: [], tokenBudget: 1,
        }, signal === undefined ? undefined : { signal })
        if (result.snapshotId !== state.snapshot.snapshotId || result.requestedCandidateRefs.length !== state.candidates.length
          || result.requestedCandidateRefs.some((ref, index) => ref !== state.candidates[index]?.ref)) {
          throw new RetrievalError('PROTOCOL_MISMATCH', '重新授权返回了不一致的快照或候选集合。')
        }
        if (result.rejectedCandidateRefs.length > 0) throw new RetrievalError('UNAUTHORIZED', '历史候选的当前访问授权已撤销。')
      }
      return state.accessValidation === 'required' ? this.#record(state, { accessValidation: 'current' }) : state
    } catch (error) {
      const failure = asRetrievalError(error)
      const reason = stopReason(failure) ?? 'backend_error'
      if (state.accessValidation === 'required' && state.phase === 'stopped' && state.termination === reason) return state
      const inaccessible: RetrievalState = { ...state, accessValidation: 'required', stopExplanation: failure.publicMessage }
      this.#proposalBases.set(inaccessible, state)
      return this.stop(inaccessible, reason, failure)
    }
  }

  /** Only call after these exact rendered items have entered the model request/tool response. */
  recordContextSelection(state: RetrievalState, selection: EvidenceContextSelection): RetrievalState {
    if (selection.stateId !== state.stateId) throw new RetrievalError('INVALID_TRANSITION', '上下文对应的状态版本已过期。')
    const candidateRefs = [...new Set([...(state.modelVisibleCandidateRefs ?? []), ...selection.includedCandidateRefs])]
    const evidenceIds = [...new Set([...(state.modelVisibleEvidenceIds ?? []), ...selection.includedEvidenceIds])]
    validateRefs(state, selection.includedCandidateRefs)
    if (selection.includedEvidenceIds.some(id => !state.promotedEvidence.some(evidence => evidence.evidenceId === id))) {
      throw new RetrievalError('INVALID_REQUEST', '上下文引用了尚未取得的证据。')
    }
    if (candidateRefs.length === state.modelVisibleCandidateRefs?.length && evidenceIds.length === state.modelVisibleEvidenceIds?.length
      && state.contextManifests?.some(m => m.id === selection.manifest?.id)) return state
    const next = advanceRetrievalState(state, {
      measurementStateIds: [...(state.measurementStateIds ?? []), state.stateId],
      modelVisibleCandidateRefs: candidateRefs, modelVisibleEvidenceIds: evidenceIds,
      promotedEvidence: state.promotedEvidence.map(evidence => evidenceIds.includes(evidence.evidenceId)
        ? { ...evidence, readers: [...new Set([...(evidence.readers ?? ['provider']), 'model' as const])] } : evidence),
    }, this.#now, this.#id)
    const manifest = this.#contextPolicy.select(next, selection.tokenBudget).manifest
    const recorded = { ...next, contextManifests: [...(state.contextManifests ?? []), ...(manifest ? [manifest] : [])] }
    recordRetrievalState(this.#journal, recorded, state)
    return recorded
  }

  async decide(principal: TrustedPrincipalContext, state: RetrievalState, decision: RetrievalDecision, signal?: AbortSignal): Promise<RetrievalState> {
    const patch = admitDecision(state, decision)
    const proposed = { ...state, ...patch }
    const nextAction = decision.action
    // Validate terminal and clarification intent before accepting any of the judgments.
    const reason = nextAction.kind === 'finish' ? finishReason(proposed, nextAction) : undefined
    if (nextAction.kind === 'clarify') validateVisibleEvidence(proposed, [...nextAction.candidateRefs, ...nextAction.evidenceRefs])
    const event = this.#journal.append(state.retrievalId, 'retrieval/decision-submitted', { decision })
    let current: RetrievalState = { ...proposed, provenance: { ...state.provenance, sourceEventIds: [event.eventId] } }
    this.#proposalBases.set(current, state)
    try {
      switch (nextAction.kind) {
        case 'delegate': return this.#record(current, { expertTasks: [...(current.expertTasks ?? []), ...planExperts(current, nextAction.assignments, this.#id)] })
        case 'search':
          if (nextAction.continueRanking) {
            if (nextAction.delta !== undefined) throw new RetrievalError('INVALID_REQUEST', '继续排名不能同时变更查询。')
            return await this.continueRanking(principal, current, signal)
          }
          if (nextAction.mode === undefined || nextAction.delta === undefined) throw new RetrievalError('INVALID_REQUEST', '搜索动作需要通道和查询变更。')
          return await this.search(principal, current, { mode: nextAction.mode, delta: nextAction.delta }, signal)
        case 'inspect':
          if (nextAction.nextWindow) {
            if (nextAction.candidateRefs?.length || nextAction.fields?.length) throw new RetrievalError('INVALID_REQUEST', '摘要翻窗与正文字段读取必须分开指定。')
            const unseen = current.candidateHistory.filter(candidate => current.candidates.some(c => c.ref === candidate.ref)
              && !(current.modelVisibleCandidateRefs ?? []).includes(candidate.ref)).slice(0, 8).map(c => c.ref)
            if (unseen.length) return this.#record(current, { contextCandidateRefs: unseen, evidenceWindowOffset: 0 })
            const evidenceOffset = this.#contextPolicy.nextEvidenceWindowOffset(current)
            if (evidenceOffset < 0) throw new RetrievalError('INVALID_TRANSITION', '当前候选摘要与已取得证据已全部提供；如需更多候选请继续检索。')
            return this.#record(current, { evidenceWindowOffset: evidenceOffset })
          }
          if (nextAction.history) {
            const refs = validateRefs(current, nextAction.candidateRefs ?? [])
            if (!refs.length || refs.length > 8) throw new RetrievalError('INVALID_REQUEST', '历史重读每次指定 1–8 个仍有效的候选。')
            if (!nextAction.fields?.length) return this.#record(current, { contextCandidateRefs: refs, evidenceWindowOffset: 0 })
          }
          return await this.inspect(principal, current, nextAction, signal)
        case 'clarify':
          return this.#requestClarification(current, nextAction.facet ?? 'business_scope', nextAction.question,
            nextAction.candidateRefs, nextAction.evidenceRefs, nextAction.options)
        case 'finish':
          current = this.#record(current, { stopExplanation: nextAction.explanation })
          return this.#freeze(current, current.selectedCandidateRefs, reason!)
      }
    } catch (error) {
      const stopped = stopReason(error)
      if (stopped !== undefined) return this.stop(current, stopped, error instanceof RetrievalError ? error : undefined)
      // A rejected action never commits its proposed judgments or advances the state chain.
      throw error
    }
  }

  async inspect(principal: TrustedPrincipalContext, state: RetrievalState,
    input: Extract<RetrievalDecision['action'], { kind: 'inspect' }> | { readonly candidateRefs?: readonly TicketCandidateRef[]; readonly fields?: readonly string[]; readonly tokenBudget?: number; readonly position?: import('@retrieval-agent/contracts').EvidencePosition; readonly level?: 'L2' | 'L3' }, signal?: AbortSignal): Promise<RetrievalState> {
    const refs = validateRefs(state, input.candidateRefs ?? [])
    const fields = [...new Set(input.fields ?? [])]
    if (refs.length === 0 || refs.length > MAX_EVIDENCE_CANDIDATES_PER_READ || fields.length === 0) throw new RetrievalError('INVALID_REQUEST', '读取必须指定有限候选和受控字段。')
    // Reading establishes visibility; it must not require a previous summary read.
    // Candidate identity, current access and controlled fields remain authorized
    // here and by the Provider. Decisions still require actual model delivery.
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '没有可用快照。')
    const allowedFields = state.snapshot.fieldCatalog.filter(field => ['L1', 'L2', 'L3'].includes(field.accessLevel) && field.valueKind !== 'raw_json').map(field => field.key)
    if (fields.some(field => !allowedFields.includes(field))) throw new RetrievalError('FIELD_NOT_ALLOWED', `深读字段必须从当前 inspectFields 原样选择，不能猜测名称或读取完整原始载荷。当前可选字段：${allowedFields.join('、')}。`)
    const tokenBudget = input.tokenBudget ?? 4000
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 16000) throw new RetrievalError('INVALID_REQUEST', '单次证据读取容量必须在 1–16000 token。')
    const result = await this.#provider.readEvidence(principal, { snapshotId: state.snapshot.snapshotId,
      candidateRefs: refs, fields, tokenBudget, ...(input.position ? { position: input.position } : {}), ...(input.level ? { level: input.level } : {}) }, signal === undefined ? undefined : { signal })
    if (result.snapshotId !== state.snapshot.snapshotId || result.requestedCandidateRefs.length !== refs.length
      || result.requestedCandidateRefs.some((ref, index) => ref !== refs[index])
      || result.evidence.some(evidence => !refs.includes(evidence.candidateRef) || !fields.includes(evidence.field))) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 深读响应的引用、字段或快照不一致。')
    }
    if (result.rejectedCandidateRefs.length > 0) throw new RetrievalError('UNAUTHORIZED', '一个或多个候选已失去读取权限。')
    if (result.evidence.length === 0) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求字段没有可读取的授权内容，请选择其他字段或说明仍缺少依据。')
    return this.#recordEvidence(state, result.evidence, 'provider', result.tokensUsed, result.nextPosition, refs)
  }

  recordDetailRead(state: RetrievalState, receipt: CandidateDetailReadReceipt, result: TicketDetailResult): RetrievalState {
    if (receipt.retrievalId !== state.retrievalId || receipt.snapshotShortId !== state.snapshot?.shortId) {
      throw new RetrievalError('INVALID_REQUEST', '详情读取回执属于另一任务或快照。')
    }
    if (result.snapshotId !== state.snapshot?.snapshotId || result.rejectedCandidateRefs.length > 0) {
      throw new RetrievalError('UNAUTHORIZED', '详情结果未获得当前快照的完整授权。')
    }
    const refs = validateRefs(state, receipt.candidateRefs)
    if (refs.length !== result.details.length || result.details.some((detail, index) => detail.candidateRef !== refs[index])) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '详情响应的候选集合或顺序与读取回执不一致。')
    }
    const visibleValues = new Map<string, number>()
    const key = (ref: string, field: string, text: string): string => JSON.stringify([ref, field, text])
    for (const detail of result.details) {
      const candidate = state.candidates.find(candidate => candidate.ref === detail.candidateRef)!
      if (detail.sourceVersion !== candidate.sourceVersion || detail.displayId !== candidate.displayId
        || detail.title !== candidate.title || detail.summary !== candidate.summary) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '详情内容的候选身份或来源版本与当前状态不一致。')
      }
      for (const [field, values] of Object.entries(detail.fields)) {
        if (!receipt.fields.includes(field) || !Array.isArray(values) || values.some(value => typeof value !== 'string')) {
          throw new RetrievalError('PROTOCOL_MISMATCH', '详情返回了未请求的字段或无效字段内容。')
        }
        for (const text of values) {
          const id = key(detail.candidateRef, field, text)
          visibleValues.set(id, (visibleValues.get(id) ?? 0) + 1)
        }
      }
    }
    for (const item of result.evidence ?? []) {
      const id = key(item.candidateRef, item.field, item.text)
      const count = visibleValues.get(id) ?? 0
      if (count === 0 || item.start !== 0 || item.end !== item.text.length || item.truncated) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '详情证据与用户实际可见字段或读取范围不一致。')
      }
      visibleValues.set(id, count - 1)
    }
    if ([...visibleValues.values()].some(count => count > 0)) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 详情缺少实际可见正文的权威证据身份。')
    }
    return this.#recordEvidence(state, result.evidence ?? [], 'user')
  }

  #recordEvidence(state: RetrievalState, received: readonly TicketEvidenceSegment[], reader: 'provider' | 'user', tokensUsed = 0,
    nextPosition?: import('@retrieval-agent/contracts').EvidencePosition, focusRefs?: readonly TicketCandidateRef[], background = reader === 'user'): RetrievalState {
    const evidence = new Map(state.promotedEvidence.map(item => [item.evidenceId, item]))
    const added: TicketEvidenceSegment[] = []
    const receivedIds = new Set<string>()
    for (const item of received) {
      const candidate = state.candidates.find(candidate => candidate.ref === item.candidateRef)
      const descriptor = state.snapshot?.fieldCatalog.find(field => field.key === item.field)
      if (receivedIds.has(item.evidenceId) || typeof item.text !== 'string' || !Number.isSafeInteger(item.start) || item.start < 0
        || !Number.isSafeInteger(item.end) || item.end - item.start !== item.text.length || typeof item.truncated !== 'boolean'
        || item.trust !== 'untrusted_ticket_evidence'
        || candidate === undefined || item.sourceVersion !== candidate.sourceVersion || item.contentHash !== candidate.contentHash
        || item.displayId !== candidate.displayId || descriptor === undefined || !['L0', 'L1', 'L2', 'L3'].includes(descriptor.accessLevel) || descriptor.valueKind === 'raw_json'
        || (item.spanHash !== undefined && item.spanHash !== createHash('sha256').update(item.text).digest('hex'))) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '证据的候选、来源版本、内容身份或字段授权不一致。')
      }
      receivedIds.add(item.evidenceId)
      const previous = evidence.get(item.evidenceId)
      if (previous !== undefined && (previous.text !== item.text || previous.start !== item.start || previous.end !== item.end)) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '同一证据身份返回了不同字段片段；读取范围必须拥有独立身份。')
      }
      const value: TicketEvidenceSegment = { ...item,
        evidenceLevel: ['title', 'summary'].includes(item.field) ? 'L1' : 'L2',
        readers: [...new Set([...(previous?.readers ?? []), 'provider' as const, reader])],
        snapshotId: state.snapshot!.snapshotId, authorizationVersion: state.snapshot!.authorizationVersion,
        principalBindingHash: state.principalBindingHash,
      }
      evidence.set(item.evidenceId, value); added.push(value)
    }
    if (added.length === 0) return state
    const event = this.#journal.append(state.retrievalId, 'retrieval/evidence-promoted', { evidence: added, tokensUsed })
    const promotedEvidence = [...evidence.values()]
    const sourceEventIds = [event.eventId]
    // A later detail click records user visibility; it does not revise an Agent-confirmed result.
    return this.#record(state, { promotedEvidence,
      // A UI read adds user-visible evidence; it does not invalidate an in-flight model decision.
      ...(background ? { measurementStateIds: [...(state.measurementStateIds ?? []), state.stateId] } : {}),
      ...(background ? {} : { evidenceReadPosition: nextPosition, evidenceWindowOffset: 0,
        progress: { ...state.progress, newEvidenceIds: added.map(item => item.evidenceId) } }),
      // A model-requested read changes its focus; an independent UI detail read does not.
      ...(focusRefs ? { contextCandidateRefs: focusRefs } : {}),
      candidates: state.candidates.map(candidate => added.some(item => item.candidateRef === candidate.ref && item.evidenceLevel === 'L2')
        ? { ...candidate, evidenceLevel: 'L2' as const } : candidate),
      provenance: { ...state.provenance, sourceEventIds } })
  }

  /** Trusted coordinator commits only provider receipts and role-bound artifacts, never arbitrary state patches. */
  setCoordinatorWaiting(state: RetrievalState, waiting: boolean): RetrievalState {
    if (state.phase === 'stopped') return state
    return this.#record(state, { coordinatorActivity: waiting ? 'waiting_experts' : 'working',
      measurementStateIds: [...(state.measurementStateIds ?? []), state.stateId] })
  }

  expertUpdate(state: RetrievalState, generation: number, update: ExpertUpdate): RetrievalState {
    if (generation !== (state.inputGeneration ?? 0) || state.phase === 'stopped') throw new RetrievalError('INVALID_TRANSITION', '专家作业属于过期输入或已停止任务。')
    switch (update.kind) {
      case 'knowledge_invalidated': {
        const affected = state.expertTasks?.filter(t => t.inputGeneration === generation && t.status !== 'failed'
          && t.knowledgeRefs.some(ref => update.references.includes(ref))) ?? []
        if (!affected.length) return state
        const ids = new Set(affected.map(t => t.id))
        const refs = new Set(affected.flatMap(t => [...t.candidateRefs, ...(t.finding?.judgments.map(j => j.candidateRef) ?? [])]))
        return this.#record(state, { knowledgeCatalog: update.catalog,
          expertTasks: state.expertTasks!.map(t => {
            if (!ids.has(t.id)) return t
            const { finding: _retiredFinding, ...retained } = t
            return { ...retained, status: 'failed' as const,
              failure: '本分支使用的知识已停用，旧产物不得采纳；主 Agent 需要重读当前来源或重新分派专家。' }
          }),
          judgments: (state.judgments ?? []).filter(j => !refs.has(j.candidateRef)),
          selectedCandidateRefs: state.selectedCandidateRefs.filter(ref => !refs.has(ref)),
          excludedCandidateRefs: state.excludedCandidateRefs.filter(ref => !refs.has(ref)),
          expertConflicts: (state.expertConflicts ?? []).filter(c => !refs.has(c.candidateRef)), measurementStateIds: [],
        })
      }
      case 'catalog':
        if (state.knowledgeCatalog) return state
        return this.#record(state, { knowledgeCatalog: update.catalog })
      case 'task': {
        const task = state.expertTasks?.find(t => t.id === update.taskId)
        if (!task || task.inputGeneration !== generation) throw new RetrievalError('INVALID_REQUEST', '专家分支不存在。')
        if (task.status === 'failed' && update.patch.status && update.patch.status !== 'failed') throw new RetrievalError('INVALID_TRANSITION', '已失败或失效的专家分支不能由迟到写入重新启用。')
        return this.#record(state, { expertTasks: state.expertTasks!.map(t => t.id === task.id ? { ...t, ...update.patch } : t),
          measurementStateIds: [...(state.measurementStateIds ?? []), state.stateId] })
      }
      case 'manifest': {
        const m = update.manifest
        if (m.inputGeneration !== generation || (m.roleId !== 'main' && !state.expertTasks?.some(t => t.id === m.roleId))
          || m.candidateRefs.some(ref => !state.candidates.some(c => c.ref === ref))
          || m.evidenceIds.some(id => !state.promotedEvidence.some(e => e.evidenceId === id))) throw new RetrievalError('INVALID_REQUEST', '专家上下文引用越界。')
        if (state.contextManifests?.some(item => item.id === m.id)) return state
        return this.#record(state, { contextManifests: [...(state.contextManifests ?? []), m],
          measurementStateIds: [...(state.measurementStateIds ?? []), state.stateId] })
      }
      case 'finding': return this.#record(state, { ...findingPatch(state, update.finding),
        measurementStateIds: [...(state.measurementStateIds ?? []), state.stateId] })
      case 'evidence': {
        if (update.result.snapshotId !== state.snapshot?.snapshotId || update.result.rejectedCandidateRefs.length) throw new RetrievalError('UNAUTHORIZED', '专家证据未通过当前快照授权。')
        return this.#recordEvidence(state, update.result.evidence, 'provider', update.result.tokensUsed, undefined, undefined, true)
      }
      case 'search': {
        const { page, spec } = update
        if (state.sharedSearches?.some(s => s.key === update.key && s.inputGeneration === generation)) return state
        if (page.snapshotId !== state.snapshot?.snapshotId || page.candidates.some(c => c.snapshotId !== state.snapshot?.snapshotId)) throw new RetrievalError('PROTOCOL_MISMATCH', '专家搜索快照不一致。')
        if (state.budget.searchesUsed >= state.budget.maxSearches) throw new RetrievalError('BUDGET_EXHAUSTED', '检索页数已达上限。')
        const event = this.#journal.append(state.retrievalId, 'retrieval/search-completed', { stage: 'repair_search', spec, page })
        const ranking = updateCandidateRanking({ previousHistory: state.candidateHistory, previousActive: state.candidates,
          resetEligibility: false, observationStart: state.activeRankingStart ?? 0, previousObservations: state.rankingHistory,
          page: page.candidates, searchEventId: event.eventId, stage: 'repair_search', queryFingerprint: page.queryFingerprint })
        return this.#record(state, { candidates: ranking.active, candidateHistory: ranking.history, rankingHistory: ranking.observations,
          measurementStateIds: [...(state.measurementStateIds ?? []), state.stateId],
          sharedSearches: [...(state.sharedSearches ?? []), { key: update.key, spec, page, inputGeneration: generation }],
          budget: { ...state.budget, searchesUsed: state.budget.searchesUsed + 1, providerLatencyMs: (state.budget.providerLatencyMs ?? 0) + page.elapsedMs },
          progress: { ...state.progress, newCandidateRefs: page.candidates.filter(c => !state.candidates.some(old => old.ref === c.ref)).map(c => c.ref) } })
      }
    }
  }

  #record(state: RetrievalState, patch: Partial<RetrievalState>): RetrievalState {
    const next = advanceRetrievalState(state, patch, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, this.#proposalBases.get(state) ?? state)
    return next
  }

  projectContext(state: RetrievalState, tokenBudget?: number, options?: { readonly journal?: boolean }): EvidenceContextSelection {
    const selection = this.#contextPolicy.select(state, tokenBudget)
    if (options?.journal !== false) this.#journal.append(state.retrievalId, 'retrieval/context-projected', { selection })
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
      ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    })
    return recordMeasuredBudget(this.#journal, state, event.eventId, modelResponseBudget(state.budget, input), this.#now, this.#id)
  }
  recordToolCall(state: RetrievalState, input: { readonly success: boolean; readonly serializationBytes: number; readonly failureSignature?: string }): RetrievalState {
    const event = this.#journal.append(state.retrievalId, 'retrieval/tool-call-measured', input)
    const measured = recordMeasuredBudget(this.#journal, state, event.eventId, toolCallBudget(state.budget, input), this.#now, this.#id)
    if (measured.phase !== 'stopped' && this.#maxRepeatedToolErrors !== undefined && (measured.budget.repeatedToolFailure?.count ?? 0) >= this.#maxRepeatedToolErrors) {
      const explained = this.#record(measured, { stopExplanation: `检测到工具调用死循环：相同参数和相同错误连续出现 ${measured.budget.repeatedToolFailure!.count} 次，期间没有有效动作或新证据。已保留任务与证据，需要调整模型或补充处理方式后继续。` })
      return this.freezeForInterruption(explained, 'budget_exhausted')
    }
    return measured
  }
  /**
   * Preserve already-authorized candidates when an execution safety ceiling is
   * reached before the model can submit a normal terminal assessment.
   */
  stopIncomplete(state: RetrievalState, explanation: string): RetrievalState {
    if (explanation.trim().length === 0) throw new RetrievalError('INVALID_REQUEST', '未完成停止必须说明具体原因。')
    const current = this.#record(state, { stopExplanation: explanation })
    return current.snapshot === undefined ? this.stop(current, 'backend_error') : this.#freeze(current, current.selectedCandidateRefs, 'partial')
  }
  freezeForInterruption(state: RetrievalState, reason: 'budget_exhausted' | 'capacity_exceeded'): RetrievalState {
    if (state.candidates.length === 0 || state.snapshot === undefined) return this.stop(state, reason)
    return this.#freeze(state, state.selectedCandidateRefs, reason)
  }
  stop(state: RetrievalState, reason: Extract<RetrievalTermination, 'budget_exhausted' | 'capacity_exceeded' | 'permission_blocked' | 'backend_error' | 'snapshot_invalid' | 'cancelled'>,
    failure?: RetrievalError): RetrievalState {
    if (state.phase === 'stopped' && state.termination === reason
      && (failure === undefined || state.stopErrorCode === failure.code)
      && (!['permission_blocked', 'snapshot_invalid'].includes(reason) || state.candidates.length === 0)
      && !this.#proposalBases.has(state)) return state
    const event = this.#journal.append(state.retrievalId, 'retrieval/stopped', {
      reason,
      remainingGapKinds: state.gaps.map(gap => gap.kind),
      ...(failure === undefined ? {} : { errorCode: failure.code }),
    })
    const next = advanceRetrievalState(state, {
      phase: 'stopped',
      allowedActions: [],
      termination: reason,
      executionClock: { totalWaitingMs: state.executionClock?.totalWaitingMs ?? 0,
        waitingSince: state.executionClock?.waitingSince ?? this.#now().toISOString() },
      ...(state.searchProgress ? { searchProgress: { ...state.searchProgress, channels: state.searchProgress.channels.map(channel => channel.status === 'running'
        ? { ...channel, status: 'failed' as const, error: failure?.code ?? reason } : channel) } } : {}),
      ...(failure === undefined ? {} : { stopErrorCode: failure.code, stopExplanation: failure.publicMessage }),
      ...(['permission_blocked', 'snapshot_invalid'].includes(reason)
        ? { candidates: [], selectedCandidateRefs: [], promotedEvidence: [], judgments: [], frozenEvidence: undefined, searchProgress: undefined,
          modelVisibleCandidateRefs: [], modelVisibleEvidenceIds: [], accessValidation: 'required' as const }
        : {}),
      provenance: { ...state.provenance, sourceEventIds: [event.eventId] },
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, this.#proposalBases.get(state) ?? state)
    return next
  }

  #freeze(
    state: RetrievalState,
    refs: readonly TicketCandidateRef[],
    reason: Exclude<RetrievalTermination, 'active' | 'needs_clarification'>,
  ): RetrievalState {
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '当前检索没有有效快照。')
    const selected = validateRefs(state, refs)
    const resultPagesExhausted = state.lastPage?.boundary?.resultPagesExhausted
      ?? (state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined)
    const semanticRecallKnown = state.lastPage?.boundary?.semanticRecallKnown ?? false
    const nextPageAvailable = state.lastPage?.nextCursor !== undefined
    const stoppingReason = reason
    if (stoppingReason === 'no_result' && state.candidates.some(candidate => !state.excludedCandidateRefs.includes(candidate.ref))) throw new RetrievalError('INVALID_TRANSITION', '存在候选时不能冻结为无结果。')
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
        const citations = new Set(state.judgments?.find(judgment => judgment.candidateRef === ref)?.evidenceRefs ?? [])
        return frozenCandidate(candidate, state.promotedEvidence.filter(evidence => citations.has(evidence.evidenceId)
          && evidence.sourceVersion === candidate.sourceVersion && evidence.contentHash === candidate.contentHash))
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
      executionClock: { totalWaitingMs: state.executionClock?.totalWaitingMs ?? 0,
        waitingSince: state.executionClock?.waitingSince ?? this.#now().toISOString() },
      frozenEvidence: pack,
      provenance: { ...state.provenance, sourceEventIds: [frozen.eventId, stopped.eventId] },
    }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, this.#proposalBases.get(state) ?? state)
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
    let result
    try { result = await executeSearchTransition({
      onProgress: async (current, progress) => {
        const candidates = [...new Map([...current.candidates, ...progress.page.candidates].map(c => [c.ref, c])).values()]
        const next = advanceRetrievalState(current, { searchProgress: progress, candidates,
          candidateHistory: [...new Map([...current.candidateHistory, ...progress.page.candidates].map(c => [c.ref, c])).values()],
          ...(current.phase === 'awaiting_clarification' ? { allowedActions: current.allowedActions.filter(item => item.kind !== 'search_next') } : {}),
        }, this.#now, this.#id)
        recordRetrievalState(this.#journal, next, this.#proposalBases.get(current) ?? current)
        state = next
        await this.#onState?.(next)
        return next
      },
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
    }) } catch (error) {
      if (error instanceof RetrievalError && stopReason(error) !== undefined) return this.stop(state, stopReason(error)!, error)
      throw error
    }
    const next = advanceRetrievalState(state, { ...result.patch, ...(state.phase === 'awaiting_clarification' ? {
      phase: state.phase, termination: state.termination,
      allowedActions: state.allowedActions.filter(item => item.kind !== 'search_next'),
    } : {}) }, this.#now, this.#id)
    recordRetrievalState(this.#journal, next, this.#proposalBases.get(state) ?? state)
    await this.#onState?.(next)
    return next
  }
}
