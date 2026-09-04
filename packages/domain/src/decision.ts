import {
  RetrievalError,
  type RetrievalCandidateJudgment,
  type RetrievalDecision,
  type RetrievalGap,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { allowedAction, validateCandidateRefs } from './state-guards.js'

export function validateVisibleEvidence(state: RetrievalState, refs: readonly string[]): void {
  const visible = new Set<string>([...(state.modelVisibleCandidateRefs ?? []), ...(state.modelVisibleEvidenceIds ?? [])])
  const current = new Set<string>([...state.candidates.map(candidate => candidate.ref),
    ...state.promotedEvidence.filter(evidence => state.candidates.some(candidate => candidate.ref === evidence.candidateRef))
      .map(evidence => evidence.evidenceId)])
  if (refs.some(ref => !visible.has(ref) || !current.has(ref))) {
    throw new RetrievalError('INVALID_REQUEST', '判断引用了模型尚未收到或已不属于当前条件的证据。')
  }
}

export function admitDecision(state: RetrievalState, decision: RetrievalDecision): Partial<RetrievalState> {
  if (decision.stateId !== state.stateId && !(state.measurementStateIds ?? []).includes(decision.stateId)) {
    throw new RetrievalError('INVALID_TRANSITION', '状态版本已变化，请基于最新知识状态重新提交。')
  }
  if (state.phase === 'stopped' || state.phase === 'awaiting_clarification') throw new RetrievalError('INVALID_TRANSITION', '当前任务已停止或正在等待用户回复。')
  if (state.accessValidation === 'required') throw new RetrievalError('UNAUTHORIZED', '历史状态必须重新授权后才能判断或呈现。')
  const incoming = new Set<string>()
  const judgments = new Map((state.judgments ?? []).map(judgment => [judgment.candidateRef, judgment]))
  for (const judgment of decision.judgments) {
    validateCandidateRefs(state, [judgment.candidateRef])
    if (incoming.has(judgment.candidateRef)) throw new RetrievalError('INVALID_REQUEST', '同一次判断中候选重复。')
    incoming.add(judgment.candidateRef)
    if (!['accept', 'exclude', 'undetermined'].includes(judgment.verdict)
      || judgment.reason.trim().length === 0 || judgment.reason.length > 1000 || judgment.evidenceRefs.length === 0) {
      throw new RetrievalError('INVALID_REQUEST', '每项候选判断必须有有效结论、可见证据引用和具体理由。')
    }
    validateVisibleEvidence(state, [judgment.candidateRef, ...judgment.evidenceRefs])
    if (!judgment.evidenceRefs.some(ref => ref === judgment.candidateRef
      || state.promotedEvidence.some(evidence => evidence.evidenceId === ref && evidence.candidateRef === judgment.candidateRef))) {
      throw new RetrievalError('INVALID_REQUEST', '候选判断缺少属于该候选的证据。')
    }
    judgments.set(judgment.candidateRef, { ...judgment, evidenceRefs: [...new Set(judgment.evidenceRefs)] })
  }
  const modelGaps: RetrievalGap[] = decision.gaps.map(gap => {
    if (gap.evaluator !== 'model') throw new RetrievalError('INVALID_REQUEST', '模型提交的任务缺口必须标明 evaluator=model。')
    validateVisibleEvidence(state, gap.evidenceRefs)
    return { ...gap, evidenceRefs: [...new Set(gap.evidenceRefs)] }
  })
  const activeJudgments: RetrievalCandidateJudgment[] = [...judgments.values()]
    .filter(judgment => state.candidates.some(candidate => candidate.ref === judgment.candidateRef))
  const candidateRefs = state.candidates.map(candidate => candidate.ref)
  return {
    judgments: activeJudgments,
    selectedCandidateRefs: activeJudgments.filter(judgment => judgment.verdict === 'accept').map(judgment => judgment.candidateRef),
    excludedCandidateRefs: activeJudgments.filter(judgment => judgment.verdict === 'exclude').map(judgment => judgment.candidateRef),
    gaps: [...state.gaps.filter(gap => gap.evaluator === 'system'), ...modelGaps],
    allowedActions: [allowedAction('assess', candidateRefs), allowedAction('repair_search'),
      ...(state.lastPage?.nextCursor === undefined ? [] : [allowedAction('search_next')]),
      allowedAction('request_clarification', candidateRefs), allowedAction('freeze', candidateRefs), allowedAction('read_state')],
    termination: 'active',
  }
}

export function finishReason(state: RetrievalState, action: Extract<RetrievalDecision['action'], { kind: 'finish' }>): 'top_k_accepted' | 'no_result' | 'partial' {
  if (action.explanation.trim().length === 0) throw new RetrievalError('INVALID_REQUEST', '停止必须说明满足依据或未完成的具体原因。')
  const accepted = state.selectedCandidateRefs.length
  const pending = state.candidates.filter(candidate => !state.selectedCandidateRefs.includes(candidate.ref)
    && !state.excludedCandidateRefs.includes(candidate.ref)).length
  const exhausted = state.lastPage?.boundary.resultPagesExhausted ?? false
  const blocked = state.query.unresolvedConstraints.length > 0 || state.gaps.some(gap =>
    !['coverage', 'boundary'].includes(gap.kind) && ['open', 'unknown'].includes(gap.status))
  const countMet = state.task.countPolicy !== 'explicit' || accepted >= (state.task.requestedCount ?? 0)
  const scopeMet = state.task.countPolicy !== 'exhaustive' || (exhausted && pending === 0)
  if (action.reason === 'incomplete') {
    if (!blocked && countMet && scopeMet && pending === 0 && exhausted && accepted > 0) {
      throw new RetrievalError('INVALID_TRANSITION', '当前没有支持未完成结论的缺口或数量、范围限制。')
    }
    return 'partial'
  }
  if (action.reason === 'no_result') {
    if (accepted > 0 || pending > 0 || !exhausted || blocked) throw new RetrievalError('INVALID_TRANSITION', '无结果需要当前查询页已用尽、候选全部判定且没有未解决条件。')
    return 'no_result'
  }
  if (accepted === 0 || blocked || !countMet || !scopeMet) {
    throw new RetrievalError('INVALID_TRANSITION', '当前证据、用户数量或范围要求尚未满足；请继续行动或具体说明未完成原因。')
  }
  return 'top_k_accepted'
}
