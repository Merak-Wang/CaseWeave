import {
  RetrievalError,
  type RetrievalAllowedAction,
  type RetrievalState,
  type TicketQueryDelta,
  type TicketRetrievalMode,
  type TicketRetrievalProvider,
  type TicketSearchStage,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import type { RetrievalEventJournal } from './journal.js'
import { updateCandidateRanking } from '@retrieval-agent/retrieval-policy'
import { applyQueryDelta } from './query.js'
import {
  allowedAction as action,
  candidateRankOverlap as rankOverlap,
  coverageGaps as systemGaps,
  requireAction as hasAction,
} from './state-guards.js'

export interface SearchTransitionInput {
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
  const { state } = input
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
  if (state.budget.searchesUsed >= state.budget.maxSearches
    || (state.budget.modelStepsUsed ?? state.budget.roundsUsed) >= state.budget.maxRounds
    || (state.budget.wallClockElapsedMs ?? state.budget.latencyMs) >= state.budget.maxLatencyMs) {
    throw new RetrievalError('BUDGET_EXHAUSTED', '检索预算已耗尽。')
  }
  const updated = applyQueryDelta(state.query.spec, input.delta)
  const spec = input.stage === 'repair_search' ? { ...updated, mode: input.mode! } : updated
  const page = await input.provider.search(input.principal, state.snapshot.snapshotId, spec, {
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
  const searched = input.journal.append(state.retrievalId, 'retrieval/search-completed', { stage: input.stage, spec, page })
  const previousRefs = state.candidates.map(candidate => candidate.ref)
  const pageRefs = page.candidates.map(candidate => candidate.ref)
  const ranking = updateCandidateRanking({
    previousHistory: state.candidateHistory,
    previousObservations: state.rankingHistory,
    page: page.candidates,
    searchEventId: searched.eventId,
    stage: input.stage,
    queryFingerprint: page.queryFingerprint,
    excludedRefs: state.excludedCandidateRefs,
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
  const allowedActions: RetrievalAllowedAction[] = [action('assess', candidateRefs), action('read_state')]
  const gaps = [
    ...systemGaps(candidateRefs, page),
    ...state.gaps.filter(gap => gap.kind !== 'coverage'),
  ]
  const coverageResolved = gaps.some(gap => gap.kind === 'coverage' && gap.status === 'resolved')
  return {
    patch: {
      phase: 'assessed',
      query: {
        ...state.query,
        spec,
        ...(state.query.contract === undefined ? {} : {
          contract: { ...state.query.contract, normalized: spec.normalizedQuery, constraints: [...spec.filters] },
        }),
        confirmedConstraints: [...spec.filters],
      },
      candidates,
      candidateHistory: ranking.history,
      rankingHistory: ranking.observations,
      selectedCandidateRefs: [],
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
