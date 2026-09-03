import {
  RetrievalError,
  type RetrievalActionKind,
  type RetrievalAllowedAction,
  type RetrievalGap,
  type RetrievalKnowledgeAssessment,
  type RetrievalRankingObservation,
  type RetrievalState,
  type TicketCandidate,
  type TicketCandidateRef,
  type TicketEvidenceField,
} from '@retrieval-agent/contracts'
import type { CandidateRankingInputParams, RetrievalPolicyGateway } from '@retrieval-agent/retrieval-policy'

function action(
  kind: RetrievalActionKind,
  candidateAllowlist: readonly TicketCandidateRef[] = [],
  fieldAllowlist: readonly TicketEvidenceField[] = [],
  maxTokens = 0,
): RetrievalAllowedAction {
  return { kind, candidateAllowlist, fieldAllowlist, maxTokens }
}

function updateRanking(input: CandidateRankingInputParams) {
  const seen = new Set<string>()
  const history: TicketCandidate[] = []
  for (const candidate of [...input.previousHistory, ...input.page]) {
    if (seen.has(candidate.ref)) continue
    seen.add(candidate.ref)
    history.push(candidate)
  }
  const next: RetrievalRankingObservation = {
    searchEventId: input.searchEventId,
    stage: input.stage,
    queryFingerprint: input.queryFingerprint,
    ranking: input.page.map(candidate => ({ ref: candidate.ref, rank: candidate.rank })),
  }
  const same = (left: RetrievalRankingObservation, right: RetrievalRankingObservation): boolean =>
    left.queryFingerprint === right.queryFingerprint && left.stage === right.stage
    && left.ranking.length === right.ranking.length
    && left.ranking.every((item, index) => item.ref === right.ranking[index]?.ref && item.rank === right.ranking[index]?.rank)
  const observations = input.previousObservations.some(item => same(item, next))
    ? [...input.previousObservations] : [...input.previousObservations, next]
  const scores = new Map<TicketCandidateRef, number>()
  for (const observation of observations) {
    const weight = observation.stage === 'repair_search' ? 1.25 : 1
    for (const item of observation.ranking) {
      if (!history.some(candidate => candidate.ref === item.ref)) continue
      scores.set(item.ref, (scores.get(item.ref) ?? 0) + weight / (60 + item.rank))
    }
  }
  const excluded = new Set(input.excludedRefs)
  const firstSeen = new Map(history.map((candidate, index) => [candidate.ref, index]))
  const active = history.filter(candidate => !excluded.has(candidate.ref))
    .sort((left, right) => (scores.get(right.ref) ?? 0) - (scores.get(left.ref) ?? 0)
      || (firstSeen.get(left.ref) ?? 0) - (firstSeen.get(right.ref) ?? 0))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
  return { version: 'candidate-ranking-v1' as const, history, observations, active }
}

function uniqueKnown(refs: readonly TicketCandidateRef[], known: ReadonlySet<TicketCandidateRef>, label: string): TicketCandidateRef[] {
  const result = [...new Set(refs)]
  if (result.some(ref => !known.has(ref))) throw new RetrievalError('CANDIDATE_NOT_FOUND', `${label}越界。`)
  return result
}

function semanticGaps(state: RetrievalState, gaps: readonly RetrievalGap[]): RetrievalGap[] {
  const known = new Set<string>([
    ...state.candidates.map(candidate => candidate.ref),
    ...state.promotedEvidence.map(evidence => evidence.evidenceId),
  ])
  return gaps.filter(gap => gap.kind !== 'coverage').map(gap => {
    if (gap.evaluator !== 'model') throw new RetrievalError('INVALID_REQUEST', '模型只能提交语义缺口。')
    if (gap.evidenceRefs.some(ref => !known.has(ref))) throw new RetrievalError('INVALID_REQUEST', '语义缺口越界。')
    if (gap.description !== undefined && (gap.description.trim().length === 0 || gap.description.length > 500)) {
      throw new RetrievalError('INVALID_REQUEST', '语义缺口描述无效。')
    }
    return { ...gap, evidenceRefs: [...new Set(gap.evidenceRefs)] }
  })
}

function canSearch(state: RetrievalState, limit: number): boolean {
  return state.budget.searchesUsed < state.budget.maxSearches
    && (state.budget.modelStepsUsed ?? state.budget.roundsUsed) < state.budget.maxRounds
    && (state.budget.wallClockElapsedMs ?? state.budget.latencyMs) < state.budget.maxLatencyMs
    && state.progress.noProgressStreak < limit
}

function exhausted(state: RetrievalState): boolean {
  return state.lastPage?.boundary?.resultPagesExhausted
    ?? (state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined)
    ?? false
}

function l3Fields(state: RetrievalState): readonly TicketEvidenceField[] {
  if (state.snapshot?.capabilities.l3DetailsRead !== true) return []
  return state.snapshot.fieldCatalog
    .filter(field => field.accessLevel === 'L3' && field.valueKind === 'raw_json')
    .map(field => field.key)
}

function depthGapCandidates(
  gaps: readonly RetrievalGap[],
  candidateRefs: readonly TicketCandidateRef[],
): TicketCandidateRef[] {
  const requested = new Set(gaps
    .filter(gap => gap.kind === 'depth' && (gap.status === 'open' || gap.status === 'unknown'))
    .flatMap(gap => gap.evidenceRefs))
  return candidateRefs.filter(ref => requested.has(ref))
}

function requireShape(assessment: RetrievalKnowledgeAssessment, evaluator: 'model' | 'system', nextAction: RetrievalKnowledgeAssessment['nextAction']): void {
  if (assessment.evaluator !== evaluator || assessment.nextAction !== nextAction) {
    throw new RetrievalError('INVALID_REQUEST', '知识评估 shape 无效。')
  }
}

function plan(state: RetrievalState, assessment: RetrievalKnowledgeAssessment, noProgressLimit: number): Partial<RetrievalState> {
  const known = new Set(state.candidates.map(candidate => candidate.ref))
  const selected = uniqueKnown(assessment.selectedCandidateRefs, known, 'selectedCandidateRefs')
  const newlyExcluded = uniqueKnown(assessment.excludedCandidateRefs, known, 'excludedCandidateRefs')
  if (selected.some(ref => newlyExcluded.includes(ref))) throw new RetrievalError('INVALID_REQUEST', '候选选择冲突。')
  const excludedCandidateRefs = [...new Set([...state.excludedCandidateRefs, ...newlyExcluded])]
  const excluded = new Set(excludedCandidateRefs)
  const candidates = state.candidates.filter(candidate => !excluded.has(candidate.ref))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
  if (selected.some(ref => !candidates.some(candidate => candidate.ref === ref))) throw new RetrievalError('INVALID_REQUEST', '选择包含已排除候选。')
  const modelGaps = semanticGaps(state, assessment.gaps)
  const gaps = [...state.gaps.filter(gap => gap.evaluator === 'system'), ...modelGaps]
  const openGap = gaps.some(gap => gap.kind !== 'coverage' && gap.kind !== 'boundary'
    && (gap.status === 'open' || gap.status === 'unknown'))
  const candidateRefs = candidates.map(candidate => candidate.ref)
  const actions: RetrievalAllowedAction[] = [action('read_state')]
  let termination: RetrievalState['termination'] = 'active'

  switch (assessment.decision) {
    case 'present_current_top_k': {
      requireShape(assessment, 'model', 'present_current_top_k')
      if (state.task.completenessRequirement !== 'top_k' || candidates.length === 0 || state.lastPage?.nextCursor === undefined) {
        throw new RetrievalError('INVALID_TRANSITION', '不能展示当前 Top-K。')
      }
      const searchOpen = canSearch(state, noProgressLimit)
      actions.unshift(
        action('assess', candidateRefs),
        ...(searchOpen ? [action('search_next'), action('repair_search')] : []),
        ...(candidates.length >= 2 ? [action('request_clarification', candidateRefs)] : []),
      )
      break
    }
    case 'accept_current_top_k': {
      requireShape(assessment, 'model', 'accept_current_top_k')
      if (state.task.completenessRequirement !== 'top_k' || selected.length === 0 || openGap) throw new RetrievalError('INVALID_TRANSITION', '不能接受当前 Top-K。')
      if (state.task.countPolicy === 'explicit' && selected.length !== state.task.requestedCount && !exhausted(state)) {
        throw new RetrievalError('INVALID_TRANSITION', '显式数量未满足。')
      }
      actions.unshift(action('freeze', selected))
      break
    }
    case 'return_partial':
      requireShape(assessment, 'system', 'finish_partial')
      if (selected.length === 0) throw new RetrievalError('INVALID_TRANSITION', '部分结果不能为空。')
      actions.unshift(action('freeze', selected))
      break
    case 'no_result':
      requireShape(assessment, 'system', 'finish_no_result')
      if (selected.length > 0 || candidates.length > 0 || !exhausted(state)) throw new RetrievalError('INVALID_TRANSITION', '不能确认无结果。')
      actions.unshift(action('freeze'))
      break
    case 'needs_clarification':
      requireShape(assessment, 'model', 'clarify')
      if (candidates.length < 2 || !gaps.some(gap => ['ambiguity', 'boundary', 'constraint'].includes(gap.kind)
        && (gap.status === 'open' || gap.status === 'unknown'))) throw new RetrievalError('INVALID_TRANSITION', '不能澄清。')
      actions.unshift(action('request_clarification', candidateRefs))
      termination = 'needs_clarification'
      break
    case 'continue': {
      requireShape(assessment, 'model', assessment.nextAction)
      const searchOpen = canSearch(state, noProgressLimit)
      actions.unshift(action('assess', candidateRefs))
      if (assessment.nextAction === 'continue_ranking') {
        if (!searchOpen || state.lastPage?.nextCursor === undefined) throw new RetrievalError('INVALID_TRANSITION', '排名不可继续。')
        actions.unshift(action('search_next'))
      } else if (assessment.nextAction === 'keyword_search' || assessment.nextAction === 'vector_search') {
        if (!searchOpen) throw new RetrievalError('INVALID_TRANSITION', '检索预算耗尽。')
        actions.unshift(action('repair_search'))
      } else if (assessment.nextAction === 'read_l3_details') {
        const depthRefs = depthGapCandidates(modelGaps, candidateRefs)
        if (depthRefs.length === 0 || l3Fields(state).length === 0) {
          throw new RetrievalError('INVALID_TRANSITION', '读取 L3 必须由引用当前候选的未解决 depth gap 触发。')
        }
        actions.unshift(action('read_l3_details', depthRefs, l3Fields(state)))
      } else if (assessment.nextAction === 'clarify') {
        if (candidates.length < 2) throw new RetrievalError('INVALID_TRANSITION', '候选不足。')
        actions.unshift(action('request_clarification', candidateRefs))
      } else throw new RetrievalError('INVALID_REQUEST', '后续动作无效。')
      break
    }
  }
  return {
    phase: 'assessed', candidates, excludedCandidateRefs, selectedCandidateRefs: selected,
    lastAssessment: { ...assessment, selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded, gaps: modelGaps },
    gaps, allowedActions: actions, termination,
    progress: { ...state.progress, newCandidateRefs: [], newEvidenceIds: [] },
  }
}

export function testRetrievalPolicy(): RetrievalPolicyGateway {
  return {
    updateCandidateRanking: input => Promise.resolve(updateRanking(input)),
    planKnowledgeAssessment: (state, assessment, config) => Promise.resolve(plan(state, assessment, config.noProgressLimit)),
  }
}
