import {
  RetrievalError,
  type RetrievalCandidateJudgment,
  type RetrievalDecision,
  type RetrievalGap,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { allowedAction, validateCandidateRefs } from './state-guards.js'
import { confirmedCount, learnedResult } from './result.js'
import { expertConflictResolution, expertNeedsMainReview } from './experts.js'
import { validateExclusionChecks } from './exclusion-checks.js'
import { operatorRequiredFields, requiredEvidenceFields } from './evidence-requirements.js'

export function validateVisibleEvidence(state: RetrievalState, refs: readonly string[], roleId = 'main'): void {
  if (!refs.length) return
  const actual = state.contextManifests?.filter(m => m.roleId === roleId && m.measurement === 'dsh_request') ?? []
  const visible = new Set<string>(actual.length ? actual.filter(m => m.inputGeneration === (state.inputGeneration ?? 0))
    .flatMap(m => [...m.candidateRefs, ...m.evidenceIds]) : roleId === 'main' ? [...(state.modelVisibleCandidateRefs ?? []), ...(state.modelVisibleEvidenceIds ?? [])] : [])
  const candidates = new Set<string>(state.candidates.map(c => c.ref))
  const current = new Set<string>([...candidates,
    ...state.promotedEvidence.filter(evidence => candidates.has(evidence.candidateRef))
      .map(evidence => evidence.evidenceId)])
  const missing = refs.filter(ref => !visible.has(ref) || !current.has(ref))
  if (missing.length) {
    const alias = (ref: string): string => {
      const candidate = state.candidateHistory.findIndex(c => c.ref === ref)
      const evidence = state.promotedEvidence.findIndex(e => e.evidenceId === ref)
      return candidate >= 0 ? `c${candidate + 1}` : evidence >= 0 ? `e${evidence + 1}` : ref
    }
    const candidates = [...new Set(missing.flatMap(ref => {
      const evidence = state.promotedEvidence.find(e => e.evidenceId === ref)
      const candidate = evidence?.candidateRef ?? ref
      return state.candidates.some(c => c.ref === candidate) ? [alias(candidate)] : []
    }))]
    throw new RetrievalError('INVALID_REQUEST', `判断引用了模型尚未收到或已不属于当前条件的证据：${missing.map(alias).join(', ')}。条件补充后旧轮次可追溯，但旧专家 finding 不可直接采纳。先单独调用 ticket_read，candidate_aliases=${JSON.stringify(candidates)}，fields=[] 重新读取概览；需要原文时用 evidenceState.inspectFields。也可使用 ticket_decide，judgments=[]、semantic_gaps=[]、action={kind:"inspect",candidate_aliases:${JSON.stringify(candidates)},fields:[]}。读取成功后再依据实际返回的证据判断，不要重复提交本次无效引用。`)
  }
}

export function admitDecision(state: RetrievalState, decision: RetrievalDecision, roleId = 'main'): Partial<RetrievalState> {
  if (decision.stateId !== state.stateId && !(state.measurementStateIds ?? []).includes(decision.stateId)) {
    throw new RetrievalError('INVALID_TRANSITION', '状态版本已变化，请基于最新知识状态重新提交。')
  }
  if (state.phase === 'stopped' || state.phase === 'awaiting_clarification') throw new RetrievalError('INVALID_TRANSITION', '当前任务已停止或正在等待用户回复。')
  if (state.accessValidation === 'required') throw new RetrievalError('UNAUTHORIZED', '历史状态必须重新授权后才能判断或呈现。')
  // 同一批判断只建立一次索引、核对一次可见集合；业务约束仍逐条判断。
  validateCandidateRefs(state, decision.judgments.map(j => j.candidateRef))
  validateVisibleEvidence(state, decision.judgments.filter(j => !j.adoptedFindingId)
    .flatMap(j => [j.candidateRef, ...j.evidenceRefs]), roleId)
  const candidates = new Map(state.candidates.map(c => [c.ref, c]))
  const evidence = new Map<string, RetrievalState['promotedEvidence'][number]>(state.promotedEvidence.map(e => [e.evidenceId, e]))
  const planFields = operatorRequiredFields(state.query.contract?.semanticPlan, state.snapshot?.fieldCatalog)
  const incoming = new Set<string>()
  for (const judgment of decision.judgments) {
    if (incoming.has(judgment.candidateRef)) throw new RetrievalError('INVALID_REQUEST', '同一次判断中候选重复。')
    incoming.add(judgment.candidateRef)
    if (!['accept', 'exclude', 'undetermined'].includes(judgment.verdict)
      || judgment.reason.trim().length === 0 || judgment.reason.length > 1000 || judgment.evidenceRefs.length === 0) {
      throw new RetrievalError('INVALID_REQUEST', '每项判断（含排除/待定）的 evidence_aliases 必须非空：依据已收到的概览可引用本条 cN，原文引用 eN。没有判断时提交 judgments=[]；理由需为 1–1000 字。')
    }
    if (judgment.adoptedFindingId) {
      const source = state.expertTasks?.find(t => t.inputGeneration === (state.inputGeneration ?? 0) && t.status === 'completed' && t.finding?.id === judgment.adoptedFindingId)?.finding
      const item = source?.judgments.find(j => j.candidateRef === judgment.candidateRef)
      if (!item || item.verdict !== judgment.verdict || judgment.evidenceRefs.some(ref => !item.evidenceRefs.includes(ref))) {
        const alias = `c${state.candidateHistory.findIndex(c => c.ref === judgment.candidateRef) + 1}`
        const refs = item?.evidenceRefs.map(ref => {
          const c = state.candidateHistory.findIndex(c => c.ref === ref)
          return c >= 0 ? `c${c + 1}` : `e${state.promotedEvidence.findIndex(e => e.evidenceId === ref) + 1}`
        })
        throw new RetrievalError('INVALID_REQUEST', `采纳关系必须引用当前专家的同条结论及证据。${alias} 的 ${judgment.adoptedFindingId}：${item
          ? `原 verdict=${item.verdict}，仅可引用 ${refs!.join(', ')}` : '没有当前同条结论'}。若主 Agent 依据自己收到的证据另作判断或增加引用，请省略 adopted_finding_id；仍需满足证据与分歧校验。`)
      }
    }
    if (!judgment.evidenceRefs.some(ref => ref === judgment.candidateRef
      || evidence.get(ref)?.candidateRef === judgment.candidateRef)) {
      throw new RetrievalError('INVALID_REQUEST', '候选判断缺少属于该候选的证据。')
    }
    validateExclusionChecks(state, judgment)
    const candidate = candidates.get(judgment.candidateRef)!
    if (judgment.verdict !== 'undetermined' && requiredEvidenceFields(state, candidate, planFields).some(field => !judgment.evidenceRefs.some(ref => {
      const e = evidence.get(ref)
      return e?.candidateRef === candidate.ref && e.field === field && e.origin?.kind === 'source'
    }))) {
      throw new RetrievalError('INVALID_REQUEST', '此判断需要引用已读取的指定原文；摘要不能替代原文或覆盖已知来源冲突。')
    }
  }
  const modelGaps: RetrievalGap[] = decision.gaps.map(gap => {
    if (gap.evaluator !== 'model') throw new RetrievalError('INVALID_REQUEST', '模型提交的任务缺口必须标明 evaluator=model。')
    validateVisibleEvidence(state, gap.evidenceRefs)
    return { ...gap, evidenceRefs: [...new Set(gap.evidenceRefs)] }
  })
  const candidateRefs = state.candidates.map(candidate => candidate.ref)
  return {
    ...mergeCandidateJudgments(state, decision.judgments),
    gaps: [...state.gaps.filter(gap => gap.evaluator === 'system'), ...modelGaps],
    allowedActions: [allowedAction('assess', candidateRefs), allowedAction('repair_search'),
      ...(state.lastPage?.nextCursor === undefined ? [] : [allowedAction('search_next')]),
      allowedAction('request_clarification', candidateRefs), allowedAction('freeze', candidateRefs), allowedAction('read_state')],
    termination: 'active',
  }
}

/** 主 Agent 和算子共用批量合并，已准入判断只更新一次结果集合。 */
export function mergeCandidateJudgments(state: RetrievalState, incoming: readonly RetrievalCandidateJudgment[]): Partial<RetrievalState> {
  const judgments = new Map((state.judgments ?? []).map(j => [j.candidateRef, j]))
  const corrected = incoming.some(j => j.basis !== 'proxy' && judgments.has(j.candidateRef)
    && judgments.get(j.candidateRef)!.verdict !== j.verdict)
  if (corrected) {
    for (const [ref, j] of judgments) if (j.basis === 'proxy') judgments.delete(ref)
  }
  for (const j of incoming) judgments.set(j.candidateRef, { ...j, evidenceRefs: [...new Set(j.evidenceRefs)] })
  const refs = new Set(state.candidates.map(c => c.ref))
  const active = [...judgments.values()].filter(j => refs.has(j.candidateRef))
  // 强判断推翻旧结论时，旧代理集合和覆盖结论一起失效，下一步重新学习。
  const learning = state.budget.operatorUsage?.learning
  return { judgments: active, expertConflicts: expertConflictResolution(state, incoming),
    ...(corrected && learning ? { budget: { ...state.budget, operatorUsage: { ...state.budget.operatorUsage,
      learning: { ...learning as Record<string, unknown>, stop_reason: 'strong_label_corrected' } } } } : {}),
    selectedCandidateRefs: active.filter(j => j.verdict === 'accept').map(j => j.candidateRef),
    excludedCandidateRefs: active.filter(j => j.verdict === 'exclude').map(j => j.candidateRef) }
}

export function finishReason(state: RetrievalState, action: Extract<RetrievalDecision['action'], { kind: 'finish' }>): 'top_k_accepted' | 'no_result' | 'partial' {
  const selected = new Set(state.selectedCandidateRefs), excluded = new Set(state.excludedCandidateRefs)
  for (const judgment of state.judgments ?? []) if (selected.has(judgment.candidateRef)) validateExclusionChecks(state, judgment)
  if (action.explanation.trim().length === 0) throw new RetrievalError('INVALID_REQUEST', '停止必须说明满足依据或未完成的具体原因。')
  const coverage = action.coverage
  if (state.knowledgeCatalog && !coverage) throw new RetrievalError('INVALID_REQUEST', 'finish.coverage 需要 checked、remaining、nextAction、nextActionValue，分别说明已查范围、影响回答的缺口和下一动作价值。')
  if (coverage && (!coverage.checked.length || [...coverage.checked, ...coverage.remaining].some(s => !s.trim() || s.length > 1000)
    || !coverage.nextAction.trim() || coverage.nextAction.length > 1500 || !['useful', 'low', 'none'].includes(coverage.nextActionValue))) {
    throw new RetrievalError('INVALID_REQUEST', '覆盖评估需要具体已查方向、剩余要求和下一动作价值；计数或页末不能代替语义评估。')
  }
  const reviewed = new Set<string>()
  for (const review of coverage?.expertReviews ?? []) {
    const task = state.expertTasks?.find(t => t.id === review.taskId && t.inputGeneration === (state.inputGeneration ?? 0))
    if (!task || !['failed', 'completed'].includes(task.status) || reviewed.has(task.id)
      || !review.reason.trim() || review.reason.length > 1000 || !review.evidenceRefs.length) throw new RetrievalError('INVALID_REQUEST', '专家范围复核必须对应当前已结束分支，并说明主 Agent 的证据与处理理由。')
    validateVisibleEvidence(state, review.evidenceRefs)
    reviewed.add(task.id)
  }
  const accepted = confirmedCount(state)
  const pending = state.candidates.filter(candidate => !selected.has(candidate.ref) && !excluded.has(candidate.ref)).length
  const learning = state.budget.operatorUsage?.learning as { input_revision?: number; task_semantics?: string; unresolved?: number; complete_feature_coverage?: boolean; complete_scope_coverage?: boolean; stop_reason?: string } | undefined
  const currentLearning = learning?.input_revision === (state.inputGeneration ?? 0) ? learning : undefined
  const learnedScope = Boolean(learnedResult(state)) || (currentLearning?.complete_feature_coverage || currentLearning?.complete_scope_coverage) && currentLearning.unresolved === 0
    && ['checked_predictions', 'all_observed'].includes(currentLearning.stop_reason ?? '')
  const exhausted = learnedScope || (state.lastPage?.boundary.resultPagesExhausted ?? false)
  const blocking = [
    ...((state.task.countPolicy === 'exhaustive' || currentLearning?.task_semantics === 'full_authorized_scope') && currentLearning && !learnedScope ? ['全库学习未通过集合质量验收，不能把搜索页末或样本判断视为全集完成'] : []),
    ...state.query.unresolvedConstraints.map(c => `用户条件待核实：${c}`),
    ...state.gaps.filter(gap => (!['coverage', 'boundary'].includes(gap.kind) || gap.evaluator === 'model') && ['open', 'unknown'].includes(gap.status))
      .map(g => `semantic_gaps 中 ${g.kind}=${g.status}：${(g.description ?? '未说明').slice(0, 150)}`),
    ...(state.expertConflicts?.filter(c => c.status === 'open').map(() => '存在未解决专家分歧，需主 Agent 按来源补证') ?? []),
    ...(state.expertTasks?.filter(t => t.inputGeneration === (state.inputGeneration ?? 0)).flatMap(t => ['pending', 'running'].includes(t.status)
      ? [`专家 ${t.id} 仍在运行`] : !reviewed.has(t.id) && expertNeedsMainReview(t)
        ? [`coverage.expertReviews 缺少分支 ${t.id} 的接手复核`] : []) ?? []),
    ...(coverage && (coverage.remaining.length || coverage.nextActionValue === 'useful') ? ['coverage 仍有 remaining 或有价值的下一动作'] : []),
  ]
  const blocked = blocking.length > 0
  const countMet = state.task.countPolicy !== 'explicit' || accepted >= (state.task.requestedCount ?? 0)
  const scopeMet = state.task.countPolicy !== 'exhaustive' || Boolean(learnedResult(state)) || (exhausted && pending === 0)
  if (action.reason === 'incomplete') {
    if (!blocked && countMet && scopeMet && pending === 0 && exhausted && accepted > 0) {
      throw new RetrievalError('INVALID_TRANSITION', '当前没有支持未完成结论的缺口或数量、范围限制。')
    }
    return 'partial'
  }
  if (action.reason === 'no_result') {
    const semanticScopeReviewed = state.query.contract?.schemaVersion === 10 && state.task.countPolicy !== 'exhaustive'
      && coverage !== undefined && (state.excludedCandidateRefs.length > 0 || state.candidates.length === 0)
    if (accepted > 0 || blocked || (!semanticScopeReviewed && (pending > 0 || !exhausted))) {
      throw new RetrievalError('INVALID_TRANSITION', `无结果需要已核实的任务范围、覆盖依据且没有未解决条件；全集任务还需完整枚举和判定。${blocking.join('；')}`)
    }
    return 'no_result'
  }
  if (accepted === 0 || blocked || !countMet || !scopeMet) {
    if (accepted === 0 && pending === 0 && exhausted && !blocked) throw new RetrievalError('INVALID_TRANSITION', '已核查的范围内没有确认工单，不能使用 satisfied；若依据原条件和可见证据确认全部候选应排除，请将 action.reason 设为 no_result，保留排除判断并重提完整原子调用。不要为了结束而纳入不相关工单，也无需重读仍有效的证据。')
    throw new RetrievalError('INVALID_TRANSITION', `当前证据、用户数量或范围要求尚未满足：${[...blocking,
      ...(!accepted ? ['尚无确认工单'] : []), ...(!countMet ? ['尚未达到用户明确数量'] : []), ...(!scopeMet ? ['用户要求全集，仍有未判候选或未枚举页'] : [])].join('；')}。请依据证据处理缺口或具体说明未完成，不能仅为通过校验改写结论。`)
  }
  return 'top_k_accepted'
}
