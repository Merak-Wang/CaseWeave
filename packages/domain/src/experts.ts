import { RetrievalError, type RetrievalState, type ExpertAssignment, type ExpertTask, type ExpertFinding,
  type ExpertConflict, type ContextManifest, type RetrievalKnowledgeCatalog, type TicketSearchPage, type TicketRetrievalSpec,
  type TicketEvidenceResult } from '@retrieval-agent/contracts'
import { validateExclusionChecks } from './exclusion-checks.js'

export type ExpertUpdate =
  | { kind: 'knowledge_invalidated'; references: readonly string[]; catalog: RetrievalKnowledgeCatalog }
  | { kind: 'catalog'; catalog: RetrievalKnowledgeCatalog }
  | { kind: 'task'; taskId: string; patch: Partial<Pick<ExpertTask, 'status' | 'knowledgeRefs' | 'releaseId' | 'childSessionId' | 'failure' | 'actionsUsed' | 'modelSteps' | 'inputTokens' | 'outputTokens' | 'context' | 'activity' | 'repeatedToolFailure'>> }
  | { kind: 'manifest'; manifest: ContextManifest }
  | { kind: 'finding'; finding: ExpertFinding }
  | { kind: 'search'; taskId: string; key: string; spec: TicketRetrievalSpec; page: TicketSearchPage }
  | { kind: 'evidence'; result: TicketEvidenceResult }

export function expertNeedsMainReview(task: ExpertTask): boolean {
  return task.status === 'failed' || (task.status === 'completed'
    && Boolean(task.finding?.question || task.finding?.gaps.some(gap => ['open', 'unknown'].includes(gap.status))))
}

export function planExperts(state: RetrievalState, assignments: readonly ExpertAssignment[], id: () => string): readonly ExpertTask[] {
  if (!state.lastPage || assignments.length < 1 || assignments.length > 3) throw new RetrievalError('INVALID_REQUEST', '快查后每批可分派 1–3 个有明确分工的专家。')
  const active = (state.expertTasks ?? []).filter(t => ['pending', 'running'].includes(t.status) && t.inputGeneration === (state.inputGeneration ?? 0))
  if (active.length + assignments.length > 6) throw new RetrievalError('INVALID_REQUEST', '已有 6 个在途核查范围（最多同时运行 3 个）。先做独立工作或 ticket_wait 等待结果，再增补分工。')
  const signatures = new Set(active.map(t => JSON.stringify([t.domainId, t.goal.trim(), t.scope.trim(), [...t.candidateRefs].sort()])))
  return assignments.map(a => {
    const signature = JSON.stringify([a.domainId, a.goal.trim(), a.scope.trim(), [...a.candidateRefs].sort()])
    if (signatures.has(signature)) throw new RetrievalError('INVALID_REQUEST', '相同范围的专家已在执行。使用其结果或 ticket_wait，不能以重复委派查询进度。')
    signatures.add(signature)
    if (!a.goal.trim() || a.goal.length > 1000 || !a.scope.trim() || a.scope.length > 1000 || a.candidateRefs.length > 20
      || a.candidateRefs.some(ref => !state.candidates.some(c => c.ref === ref))) throw new RetrievalError('INVALID_REQUEST', '专家任务需要目标、范围及当前候选（最多 20 条）。')
    if (a.domainId !== 'general' && !state.knowledgeCatalog?.domains.some(d => d.id === a.domainId)) throw new RetrievalError('INVALID_REQUEST', '未知专家目录；缺库时使用 general 零样本专家。')
    const domain = state.knowledgeCatalog?.domains.find(d => d.id === a.domainId)
    if (a.knowledgeIds && (a.knowledgeIds.length > 3 || a.knowledgeIds.some(id => !domain?.entryIds.includes(id)))) {
      throw new RetrievalError('INVALID_REQUEST', `knowledge_ids 必须属于 ${a.domainId} 且至多 3 条；省略时自动检索该领域知识。允许：${domain?.entryIds.join(', ') ?? '无（general 使用零样本）'}。`)
    }
    const taskId = id()
    return { ...a, id: taskId, branchId: taskId, inputGeneration: state.inputGeneration ?? 0,
      ...(state.knowledgeCatalog?.releaseId ? { releaseId: state.knowledgeCatalog.releaseId } : {}),
      knowledgeRefs: [], status: 'pending', allowedTools: ['ticket_expert'], maxActions: 12, actionsUsed: 0 }
  })
}

export function findingPatch(state: RetrievalState, finding: ExpertFinding): Partial<RetrievalState> {
  const task = state.expertTasks?.find(t => t.id === finding.taskId)
  if (!task || task.inputGeneration !== (state.inputGeneration ?? 0) || task.inputGeneration !== finding.inputGeneration
    || !['running', 'pending'].includes(task.status)) throw new RetrievalError('INVALID_TRANSITION', '专家产物已过期或分支不再运行。')
  const manifests = (state.contextManifests ?? []).filter(m => m.roleId === task.id && m.inputGeneration === task.inputGeneration && m.measurement === 'dsh_request')
  const visible = new Set<string>(manifests.flatMap(m => [...m.candidateRefs, ...m.evidenceIds]))
  const current = new Set<string>([...state.candidates.map(c => c.ref), ...state.promotedEvidence.filter(e => state.candidates.some(c => c.ref === e.candidateRef)).map(e => e.evidenceId)])
  const valid = (refs: readonly string[]): boolean => refs.every(ref => visible.has(ref) && current.has(ref))
  if (!finding.nextAction.trim() || finding.nextAction.length > 1500) throw new RetrievalError('INVALID_REQUEST', 'report.next_action 需要 1–1500 字，说明本范围已完成待主 Agent 综合，或具体还需什么。不需要为此重读已有效证据。')
  if (finding.judgments.length > 20 || new Set(finding.judgments.map(j => j.candidateRef)).size !== finding.judgments.length
    || (finding.question?.length ?? 0) > 1000
    || !valid(finding.counterEvidenceRefs) || finding.gaps.some(g => g.evaluator !== 'model' || !valid(g.evidenceRefs))) {
    throw new RetrievalError('INVALID_REQUEST', '专家产物包含不可见引用、重复判断或无效后续动作。')
  }
  for (const judgment of finding.judgments) {
    validateExclusionChecks(state, judgment)
    if (!['accept', 'exclude', 'undetermined'].includes(judgment.verdict) || !judgment.reason.trim() || judgment.reason.length > 1000
      || !judgment.evidenceRefs.length || !valid([judgment.candidateRef, ...judgment.evidenceRefs])
      || !judgment.evidenceRefs.some(ref => ref === judgment.candidateRef || state.promotedEvidence.some(e => e.evidenceId === ref && e.candidateRef === judgment.candidateRef))) {
      const alias = `c${state.candidateHistory.findIndex(c => c.ref === judgment.candidateRef) + 1}`
      const own = [visible.has(judgment.candidateRef) ? alias : undefined,
        ...state.promotedEvidence.flatMap((e, i) => e.candidateRef === judgment.candidateRef && visible.has(e.evidenceId) ? [`e${i + 1}`] : [])].filter(Boolean)
      throw new RetrievalError('INVALID_REQUEST', `${alias} 判断无效：reason 需为 1–1000 字；evidence_aliases 必须引用该角色实际收到的本工单证据，不能借用其他 cN。已收到的本工单引用：${own.join(', ') || '无；先 inspect 该候选'}。`)
    }
  }
  const tasks = state.expertTasks!.map(t => t.id === task.id ? { ...t, finding, status: 'completed' as const } : t)
  const conflicts = new Map((state.expertConflicts ?? []).map(c => [c.candidateRef, c]))
  for (const j of finding.judgments) {
    const peers = tasks.flatMap(t => t.inputGeneration === task.inputGeneration && t.finding
      ? t.finding.judgments.filter(other => other.candidateRef === j.candidateRef).map(other => ({ finding: t.finding!, judgment: other })) : [])
    const declaredConflict = finding.gaps.some(g => ['conflict', 'version_or_prior'].includes(g.kind)
      && ['open', 'unknown'].includes(g.status) && g.evidenceRefs.some(ref => ref === j.candidateRef
        || state.promotedEvidence.some(e => e.evidenceId === ref && e.candidateRef === j.candidateRef)))
    const main = state.judgments?.find(other => other.candidateRef === j.candidateRef && other.verdict !== 'undetermined')
    if (declaredConflict || new Set(peers.map(p => p.judgment.verdict)).size > 1 || (main && main.verdict !== j.verdict)) {
      conflicts.set(j.candidateRef, { candidateRef: j.candidateRef, findingIds: peers.map(p => p.finding.id),
        kind: finding.disagreementKind ?? 'fact', status: 'open' })
    }
  }
  const open = new Set([...conflicts.values()].filter(c => c.status === 'open').map(c => c.candidateRef))
  return { expertTasks: tasks, expertConflicts: [...conflicts.values()],
    selectedCandidateRefs: state.selectedCandidateRefs.filter(ref => !open.has(ref)),
    excludedCandidateRefs: state.excludedCandidateRefs.filter(ref => !open.has(ref)),
    judgments: state.judgments?.map(j => open.has(j.candidateRef) ? { ...j, verdict: 'undetermined' as const } : j) ?? [] }
}

export function expertConflictResolution(state: RetrievalState, judgments: readonly import('@retrieval-agent/contracts').RetrievalCandidateJudgment[]): readonly ExpertConflict[] {
  const actual = state.contextManifests?.filter(m => m.roleId === 'main' && m.measurement === 'dsh_request') ?? []
  const visible = new Set<string>(actual.length ? actual.filter(m => m.inputGeneration === (state.inputGeneration ?? 0)).flatMap(m => m.evidenceIds) : state.modelVisibleEvidenceIds ?? [])
  const visibleCandidates = new Set<string>(actual.length ? actual.filter(m => m.inputGeneration === (state.inputGeneration ?? 0)).flatMap(m => m.candidateRefs) : state.modelVisibleCandidateRefs ?? [])
  return (state.expertConflicts ?? []).map(conflict => {
    const judgment = judgments.find(j => j.candidateRef === conflict.candidateRef)
    if (conflict.status !== 'open' || !judgment || judgment.verdict === 'undetermined') return conflict
    const resolution = judgment.conflictResolution
    if (!resolution || !resolution.reason.trim() || !resolution.evidenceRefs.length
      || !resolution.evidenceRefs.every(ref => ref === judgment.candidateRef ? visibleCandidates.has(ref) : visible.has(ref)
        && state.promotedEvidence.some(e => e.evidenceId === ref && e.candidateRef === judgment.candidateRef))
      || !resolution.evidenceRefs.some(ref => state.promotedEvidence.some(e => e.evidenceId === ref && e.candidateRef === judgment.candidateRef
        && e.field !== 'summary' && e.projectionLevel !== 'L1' && e.origin?.kind !== 'generated'))) {
      const alias = `c${state.candidateHistory.findIndex(c => c.ref === judgment.candidateRef) + 1}`
      throw new RetrievalError('INVALID_REQUEST', `${alias} 的专家分歧尚未解决。请先单独 ticket_read 读取该工单来源片段，再在该条 judgment.conflict_resolution 中提交 kind、reason、evidence_aliases。引用须属于本工单、已被主 Agent 收到，且至少包含一段非摘要、非生成的原文 eN；可同时引用本工单 cN 概览。仅在 reason 或 semantic_gaps 中写“分歧已解决”不会提交分歧处理。`)
    }
    return { ...conflict, kind: resolution.kind, status: 'resolved', resolution }
  })
}
