import {
  RetrievalError,
  type RetrievalActionKind,
  type RetrievalAllowedAction,
  type RetrievalGap,
  type RetrievalKnowledgeAssessment,
  type RetrievalState,
  type TicketCandidateRef,
  type TicketEvidenceField,
} from '@retrieval-agent/contracts'

function action(
  kind: RetrievalActionKind,
  candidateAllowlist: readonly TicketCandidateRef[] = [],
  fieldAllowlist: readonly TicketEvidenceField[] = [],
  maxTokens = 0,
): RetrievalAllowedAction {
  return { kind, candidateAllowlist, fieldAllowlist, maxTokens }
}

function snapshotEvidenceFields(state: RetrievalState): readonly TicketEvidenceField[] {
  return state.snapshot?.fieldCatalog
    .filter(field => field.accessLevel === 'L2')
    .map(field => field.key) ?? []
}

export interface KnowledgeAssessmentConfig {
  readonly noProgressLimit: number
  readonly minSufficientCoverage?: number
  readonly minSufficientQuality?: number
}

function score(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RetrievalError('INVALID_REQUEST', `${label} 必须是 0 到 1 的有限数值。`)
  }
}

function uniqueKnownRefs(
  refs: readonly TicketCandidateRef[],
  known: ReadonlySet<TicketCandidateRef>,
  label: string,
): TicketCandidateRef[] {
  const result = [...new Set(refs)]
  if (result.some(ref => !known.has(ref))) {
    throw new RetrievalError('CANDIDATE_NOT_FOUND', `${label}引用了当前 active ranking 之外的候选。`)
  }
  return result
}

function modelGaps(state: RetrievalState, gaps: readonly RetrievalGap[]): RetrievalGap[] {
  const knownEvidence = new Set<string>([
    ...state.candidates.map(candidate => candidate.ref),
    ...state.promotedEvidence.map(evidence => evidence.evidenceId),
  ])
  return gaps
    .filter(gap => gap.kind !== 'coverage')
    .map(gap => {
      if (gap.evaluator !== 'model') throw new RetrievalError('INVALID_REQUEST', '模型只能提交 evaluator=model 的语义缺口。')
      if (gap.evidenceRefs.some(ref => !knownEvidence.has(ref))) {
        throw new RetrievalError('INVALID_REQUEST', '语义缺口引用了当前状态外的证据。')
      }
      if (gap.description !== undefined && (gap.description.trim().length === 0 || gap.description.length > 500)) {
        throw new RetrievalError('INVALID_REQUEST', '语义缺口描述无效。')
      }
      return { ...gap, evidenceRefs: [...new Set(gap.evidenceRefs)] }
    })
}

function canSearch(state: RetrievalState, noProgressLimit: number): boolean {
  return state.budget.searchesUsed < state.budget.maxSearches
    && (state.budget.modelStepsUsed ?? state.budget.roundsUsed) < state.budget.maxRounds
    && (state.budget.wallClockElapsedMs ?? state.budget.latencyMs) < state.budget.maxLatencyMs
    && state.progress.noProgressStreak < noProgressLimit
}

function canPromote(state: RetrievalState): boolean {
  return state.budget.promotionsUsed < state.budget.maxPromotions
    && (state.budget.modelStepsUsed ?? state.budget.roundsUsed) < state.budget.maxRounds
    && (state.budget.wallClockElapsedMs ?? state.budget.latencyMs) < state.budget.maxLatencyMs
    && state.budget.evidenceTokensUsed < state.budget.maxEvidenceTokens
}

function requireControlShape(
  assessment: RetrievalKnowledgeAssessment,
  decision: RetrievalKnowledgeAssessment['decision'],
  nextAction: RetrievalKnowledgeAssessment['nextAction'],
  stop: boolean,
): void {
  if (assessment.decision !== decision || assessment.nextAction !== nextAction || assessment.stop !== stop) {
    throw new RetrievalError('INVALID_REQUEST', `知识评估 ${decision} 必须使用 nextAction=${nextAction}、stop=${String(stop)}。`)
  }
}

/** Validate one semantic judgment and derive the exact next Harness actions. */
export function planKnowledgeAssessment(
  state: RetrievalState,
  assessment: RetrievalKnowledgeAssessment,
  config: KnowledgeAssessmentConfig,
): Partial<RetrievalState> {
  score(assessment.coverage, 'coverage')
  score(assessment.candidateQuality, 'candidateQuality')
  const known = new Set(state.candidates.map(candidate => candidate.ref))
  const selected = uniqueKnownRefs(assessment.selectedCandidateRefs, known, 'selectedCandidateRefs')
  const newlyExcluded = uniqueKnownRefs(assessment.excludedCandidateRefs, known, 'excludedCandidateRefs')
  if (selected.some(ref => newlyExcluded.includes(ref))) {
    throw new RetrievalError('INVALID_REQUEST', '同一候选不能同时被选择和排除。')
  }
  const excludedCandidateRefs = [...new Set([...state.excludedCandidateRefs, ...newlyExcluded])]
  const excluded = new Set(excludedCandidateRefs)
  const candidates = state.candidates
    .filter(candidate => !excluded.has(candidate.ref))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
  if (selected.some(ref => !candidates.some(candidate => candidate.ref === ref))) {
    throw new RetrievalError('INVALID_REQUEST', '最终选择不能包含已排除候选。')
  }
  const semanticGaps = modelGaps(state, assessment.gaps)
  const preservedSystemGaps = state.gaps.filter(gap => gap.kind !== 'coverage' && gap.evaluator === 'system')
  const providerExhausted = state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined
  const explicitQuotaReached = state.task.countPolicy !== 'adaptive'
    && state.candidateHistory.length >= state.task.requestedCount
  const semanticCoverageAccepted = state.task.completenessRequirement === 'top_k' && assessment.stop
    && assessment.coverage >= (config.minSufficientCoverage ?? 0.6)
  const taskSatisfied = providerExhausted || (state.task.completenessRequirement === 'top_k'
    && (explicitQuotaReached || semanticCoverageAccepted))
  const coverageGap: RetrievalGap = {
    kind: 'coverage',
    status: providerExhausted ? 'resolved' : 'open',
    evidenceRefs: providerExhausted ? selected : [],
    evaluator: 'system',
  }
  const gaps = [coverageGap, ...preservedSystemGaps, ...semanticGaps]
  const openNonCoverage = gaps.some(gap => gap.kind !== 'coverage'
    && (gap.status === 'open' || gap.status === 'unknown'))
  const actions: RetrievalAllowedAction[] = [action('read_state')]
  let termination: RetrievalState['termination'] = 'active'

  switch (assessment.decision) {
    case 'sufficient':
      requireControlShape(assessment, 'sufficient', 'finish', true)
      if (selected.length === 0 || assessment.coverage < (config.minSufficientCoverage ?? 0.6)
        || assessment.candidateQuality < (config.minSufficientQuality ?? 0.5) || !taskSatisfied || openNonCoverage) {
        throw new RetrievalError('INVALID_TRANSITION', '充分评估必须选择候选、达到质量阈值且不存在开放语义缺口。')
      }
      if (state.task.countPolicy === 'explicit' && selected.length < state.task.requestedCount && !providerExhausted) {
        throw new RetrievalError('INVALID_TRANSITION', '用户显式数量尚未满足，不能评估为充分。')
      }
      actions.unshift(action('freeze', selected))
      break
    case 'no_result':
      requireControlShape(assessment, 'no_result', 'finish', true)
      if (selected.length > 0 || candidates.length > 0 || !providerExhausted
        || assessment.coverage < (config.minSufficientCoverage ?? 0.6)) {
        throw new RetrievalError('INVALID_TRANSITION', '无结果只能在 Provider 已穷尽且没有 active 候选时成立。')
      }
      actions.unshift(action('freeze'))
      break
    case 'partial':
      requireControlShape(assessment, 'partial', 'finish', true)
      actions.unshift(action('freeze', selected))
      break
    case 'needs_clarification':
      requireControlShape(assessment, 'needs_clarification', 'clarify', false)
      if (candidates.length < 2 || !gaps.some(gap => ['ambiguity', 'boundary', 'constraint'].includes(gap.kind)
        && (gap.status === 'open' || gap.status === 'unknown'))) {
        throw new RetrievalError('INVALID_TRANSITION', '澄清评估需要至少两个候选和一个开放的歧义、边界或约束缺口。')
      }
      actions.unshift(action('request_clarification', candidates.map(candidate => candidate.ref)))
      termination = 'needs_clarification'
      break
    case 'continue': {
      if (assessment.stop) throw new RetrievalError('INVALID_REQUEST', '继续评估不能设置 stop=true。')
      const searchOpen = canSearch(state, config.noProgressLimit)
      if (assessment.nextAction === 'continue_ranking') {
        if (!searchOpen || state.lastPage?.nextCursor === undefined) throw new RetrievalError('INVALID_TRANSITION', '当前 Provider 排名不可继续。')
        actions.unshift(action('search_next'))
      } else if (assessment.nextAction === 'keyword_search' || assessment.nextAction === 'vector_search') {
        if (!searchOpen) throw new RetrievalError('INVALID_TRANSITION', '后续检索预算已耗尽。')
        actions.unshift(action('repair_search'))
      } else if (assessment.nextAction === 'promote') {
        if (!canPromote(state) || candidates.length === 0) throw new RetrievalError('INVALID_TRANSITION', '当前状态不能读取更多证据。')
        actions.unshift(action(
          'promote', candidates.map(candidate => candidate.ref), snapshotEvidenceFields(state),
          state.budget.maxEvidenceTokens - state.budget.evidenceTokensUsed,
        ))
      } else if (assessment.nextAction === 'clarify') {
        if (candidates.length < 2) throw new RetrievalError('INVALID_TRANSITION', '当前候选不足以生成差异澄清。')
        actions.unshift(action('request_clarification', candidates.map(candidate => candidate.ref)))
      } else {
        throw new RetrievalError('INVALID_REQUEST', 'continue 评估必须选择一个可执行的后续动作。')
      }
      break
    }
    default:
      return assessment.decision satisfies never
  }

  return {
    phase: 'assessed',
    candidates,
    excludedCandidateRefs,
    selectedCandidateRefs: selected,
    lastAssessment: { ...assessment, selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded, gaps: semanticGaps },
    gaps,
    allowedActions: actions,
    termination,
    progress: { ...state.progress, newCandidateRefs: [], newEvidenceIds: [] },
  }
}
