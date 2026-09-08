import {
  RetrievalError,
  type RetrievalAllowedAction,
  type RetrievalState,
  type TicketQueryDelta,
  type TicketRetrievalMode,
  type TicketRetrievalProvider,
  type TicketSearchStage,
  type TicketUserRequirement,
  type TicketSearchProgress,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import type { RetrievalEventJournal } from './journal.js'
import { updateCandidateRanking } from './policy.js'
import { applyQueryDelta, deltaRequirementResolutions, requireUserConstraints, resolvePlanRequirements } from './query.js'
import {
  allowedAction as action,
  candidateRankOverlap as rankOverlap,
  coverageGaps as systemGaps,
  requireAction as hasAction,
} from './state-guards.js'

export interface SearchTransitionInput {
  readonly onProgress?: (state: RetrievalState, progress: TicketSearchProgress) => RetrievalState | Promise<RetrievalState>
  readonly provider: TicketRetrievalProvider
  readonly journal: RetrievalEventJournal
  readonly principal: TrustedPrincipalContext
  readonly state: RetrievalState
  readonly stage: TicketSearchStage
  readonly mode?: TicketRetrievalMode
  readonly delta?: TicketQueryDelta
  readonly cursor?: string
  readonly signal?: AbortSignal
  readonly topK: number
  readonly maxScan: number
}

export interface SearchTransitionResult {
  readonly patch: Partial<RetrievalState>
}

/** Execute one admitted search and return a deterministic state patch. */
export async function executeSearchTransition(input: SearchTransitionInput): Promise<SearchTransitionResult> {
  let { state } = input
  if (input.stage === 'initial_hybrid') {
    hasAction(state, 'search')
    if (input.mode !== undefined || input.delta !== undefined || input.cursor !== undefined) {
      throw new RetrievalError('INVALID_REQUEST', '首轮混合检索不接受通道选择、修复或游标。')
    }
  } else if (input.stage === 'repair_search') {
    hasAction(state, 'repair_search')
    if (input.mode === undefined || input.delta === undefined || input.cursor !== undefined) {
      throw new RetrievalError('INVALID_REQUEST', '修复检索必须提供 keyword/dense 通道和 QueryDelta。')
    }
  } else if (input.stage === 'next_page') {
    hasAction(state, 'search_next')
    if (input.mode === undefined || input.cursor === undefined || input.delta !== undefined) {
      throw new RetrievalError('INVALID_REQUEST', '下一页检索必须提供当前通道和 Provider 游标。')
    }
    if (input.mode !== state.query.spec.mode) throw new RetrievalError('INVALID_REQUEST', '下一页检索通道与当前查询不一致。')
  } else {
    throw new RetrievalError('INVALID_REQUEST', 'Controller 不执行 baseline 检索阶段。')
  }
  if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '当前检索没有有效快照。')
  // Model steps and wall-clock time stay observational; only the Provider page ceiling stops a task.
  if (state.budget.searchesUsed >= state.budget.maxSearches) {
    throw new RetrievalError('BUDGET_EXHAUSTED', '检索页数已达上限。')
  }
  const updated = applyQueryDelta(state.query.spec, input.delta)
  requireUserConstraints(state, updated)
  const resolutions = deltaRequirementResolutions(input.delta)
  const pendingRequirements = state.query.contract?.userRequirements ?? []
  const pendingByText = new Map<string, TicketUserRequirement>()
  for (const requirement of pendingRequirements) {
    if (requirement.status === 'unresolved') pendingByText.set(requirement.text, requirement)
  }
  for (const text of state.query.unresolvedConstraints) {
    const raw = text.split('：')[0]!
    if (!pendingByText.has(raw)) pendingByText.set(raw, { text: raw, status: 'unresolved', filters: [] })
  }
  const resolvedFields = new Map<string, Set<string>>()
  for (const resolution of resolutions) {
    const target = pendingByText.get(resolution.text) ?? pendingByText.get(resolution.text.split('：')[0]!)
    if (target === undefined) throw new RetrievalError('INVALID_REQUEST', `修复声明解决的待确认条件不存在：${resolution.text}。`)
    const fields = resolvedFields.get(target.text) ?? new Set<string>()
    fields.add(resolution.field)
    resolvedFields.set(target.text, fields)
  }
  const resolvedAmbiguity = (text: string): boolean =>
    [...resolvedFields.keys()].some(pending => text === pending || text.startsWith(`${pending}：`))
  const hardConditionsChanged = JSON.stringify(updated.filters) !== JSON.stringify(state.query.spec.filters)
    || (state.lastPage === undefined && state.candidateHistory.length > 0)
  const activeRankingStart = hardConditionsChanged ? state.rankingHistory.length : state.activeRankingStart ?? 0
  const planned = updated.queryPlan && resolvedFields.size ? { ...updated, queryPlan: resolvePlanRequirements(updated.queryPlan,
    [...resolvedFields].map(([text, fields]) => ({ text, filters: updated.filters.filter(f => fields.has(f.field)) }))) } : updated
  const spec = input.stage === 'repair_search' ? { ...planned, mode: input.mode! } : planned
  const resolvedSpec = resolutions.length === 0 ? spec
    : { ...spec, ambiguities: spec.ambiguities.filter(ambiguity => !resolvedAmbiguity(ambiguity.text)) }
  const updatedRequirements = resolutions.length === 0 ? pendingRequirements
    : pendingRequirements.map(requirement => {
      const fields = resolvedFields.get(requirement.text)
      if (fields === undefined || requirement.status !== 'unresolved') return requirement
      const filters = resolvedSpec.filters.filter(filter => fields.has(filter.field))
      if (filters.length === 0) {
        throw new RetrievalError('INVALID_REQUEST', `修复声明解决的条件没有留下对应过滤条件：${requirement.text}。`)
      }
      return { ...requirement, status: 'compiled' as const, filters }
    })
  const unresolvedConstraints = state.query.unresolvedConstraints.filter(text => !resolvedAmbiguity(text))
  const page = await input.provider.search(input.principal, state.snapshot.snapshotId, resolvedSpec, {
    onProgress: async progress => {
      if (progress.page.snapshotId !== state.snapshot?.snapshotId || progress.page.candidates.some(c => c.snapshotId !== state.snapshot?.snapshotId)) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '增量搜索返回了不同快照的候选。')
      }
      if (input.signal?.aborted) throw new RetrievalError('CANCELLED', '检索已取消。')
      if (input.onProgress) state = await input.onProgress(state, progress)
    },
    topK: input.topK,
    maxScan: input.maxScan,
    stage: input.stage,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (page.snapshotId !== state.snapshot.snapshotId || page.trace.stage !== input.stage
    || page.candidates.some(candidate => candidate.snapshotId !== state.snapshot!.snapshotId)) {
    throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回了不同快照或阶段的候选。')
  }
  if (new Set(page.candidates.map(candidate => candidate.ref)).size !== page.candidates.length
    || page.trace.signals.some(signal => !page.candidates.some(candidate => candidate.ref === signal.candidateRef))) {
    throw new RetrievalError('PROTOCOL_MISMATCH', 'Provider 返回了重复候选或越界排名信号。')
  }
  const searched = input.journal.append(state.retrievalId, 'retrieval/search-completed', { stage: input.stage, spec: resolvedSpec, page })
  const previousRefs = state.candidates.map(candidate => candidate.ref)
  const pageRefs = page.candidates.map(candidate => candidate.ref)
  const ranking = updateCandidateRanking({
    previousHistory: state.candidateHistory,
    previousActive: state.candidates,
    resetEligibility: hardConditionsChanged,
    observationStart: activeRankingStart,
    previousObservations: state.rankingHistory,
    page: page.candidates,
    searchEventId: searched.eventId,
    stage: input.stage,
    queryFingerprint: page.queryFingerprint,
  })
  const candidates = ranking.active
  const newRefs = pageRefs.filter(ref => !previousRefs.includes(ref))
  const overlap = rankOverlap(previousRefs, candidates.map(candidate => candidate.ref))
  const noProgressStreak = newRefs.length === 0 ? state.progress.noProgressStreak + 1 : 0
  const budget = {
    ...state.budget,
    searchesUsed: state.budget.searchesUsed + 1,
    providerLatencyMs: (state.budget.providerLatencyMs ?? 0) + page.elapsedMs,
  }
  const candidateRefs = candidates.map(candidate => candidate.ref)
  const searchOpen = budget.searchesUsed < budget.maxSearches
  // 零候选但仍有待确认条件时，向用户澄清是唯一不依赖候选差异的合法出口。
  const clarificationOpen = candidateRefs.length >= 2
    || (candidates.length === 0 && unresolvedConstraints.length > 0)
  const allowedActions: RetrievalAllowedAction[] = [
    action('assess', candidateRefs),
    ...(searchOpen && page.nextCursor !== undefined ? [action('search_next')] : []),
    ...(searchOpen ? [action('repair_search')] : []),
    ...(clarificationOpen ? [action('request_clarification', candidateRefs)] : []),
    action('read_state'),
  ]
  const gaps = [
    ...systemGaps(candidateRefs, page),
    ...state.gaps.filter(gap => gap.evaluator !== 'system' || !['coverage', 'boundary'].includes(gap.kind)),
  ].filter(gap => !(gap.evaluator === 'system' && ['ambiguity', 'constraint'].includes(gap.kind)
    && resolvedAmbiguity(gap.description ?? '')))
  const coverageResolved = gaps.some(gap => gap.kind === 'coverage' && gap.status === 'resolved')
  return {
    patch: {
      phase: 'assessed',
      query: {
        ...state.query,
        spec: resolvedSpec,
        ...(state.query.contract === undefined ? {} : {
          contract: {
            ...state.query.contract,
            normalized: resolvedSpec.normalizedQuery,
            ...(resolvedSpec.queryPlan ? { queryPlan: resolvedSpec.queryPlan } : {}),
            constraints: [...resolvedSpec.filters],
            ...(resolutions.length === 0 ? {} : {
              userRequirements: updatedRequirements,
              ambiguities: state.query.contract.ambiguities.filter(ambiguity => !resolvedAmbiguity(ambiguity.text)),
            }),
          },
        }),
        confirmedConstraints: [...resolvedSpec.filters],
        unresolvedConstraints,
      },
      candidates,
      evidenceWindowOffset: 0,
      candidateHistory: ranking.history,
      rankingHistory: ranking.observations,
      activeRankingStart,
      excludedCandidateRefs: hardConditionsChanged ? [] : state.excludedCandidateRefs,
      selectedCandidateRefs: hardConditionsChanged ? [] : state.selectedCandidateRefs,
      ...(hardConditionsChanged ? { judgments: [], modelVisibleCandidateRefs: [], modelVisibleEvidenceIds: [], candidateWindowOffset: 0 } : {}),
      lastAssessment: undefined,
      lastPage: page,
      gaps,
      allowedActions,
      budget,
      progress: {
        newCandidateRefs: newRefs,
        newEvidenceIds: [],
        rankOverlap: overlap,
        newDecisiveEvidence: false,
        resolvedGaps: coverageResolved ? ['coverage'] : [],
        noProgressStreak,
      },
      provenance: { ...state.provenance, sourceEventIds: [searched.eventId] },
    },
  }
}
