import type { Agent } from '@deepseek-ai/dsh-agent'
import { RetrievalError, type RetrievalDecision, type RetrievalState } from '@retrieval-agent/contracts'
import { confirmedCount, learnedResult } from '@retrieval-agent/domain/result'
import type { RetrievalAgentService } from './service.js'

/** Fixed custom retrieval, with the same source/authorization/finish admission as tools. */
export async function runFixedRetrieval(application: RetrievalAgentService, agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
  if (!application.operators) throw new RetrievalError('PROVIDER_UNAVAILABLE', '固定检索需要已装配的语义算子。')
  const expected = application.current(agent)
  const isCurrent = (state: RetrievalState) => state.retrievalId === expected.retrievalId && (state.inputGeneration ?? 0) === (expected.inputGeneration ?? 0)
  let previous = ''
  for (;;) {
    signal?.throwIfAborted()
    let state = application.current(agent)
    if (!isCurrent(state) || state.phase === 'stopped' || state.phase === 'awaiting_clarification') return state
    state = await application.operators.searchAndFilter(agent, signal)
    signal?.throwIfAborted()
    if (!isCurrent(state) || state.phase === 'stopped' || state.phase === 'awaiting_clarification') return state
    const learning = state.budget.operatorUsage?.learning as Record<string, unknown> | undefined
    const current = learning?.input_revision === (state.inputGeneration ?? 0) ? learning : undefined
    const plan = state.query.contract?.semanticPlan
    const unresolved = Number(current?.unresolved ?? current?.undetermined_records ?? 0)
    const ready = Boolean(learnedResult(state)) || current?.stop_reason === 'frozen_completed' && unresolved === 0
      || plan?.goal.mode === 'examples' && confirmedCount(state) >= (plan.goal.count ?? Infinity)
    if (ready) {
      const action: Extract<RetrievalDecision['action'], { kind: 'finish' }> = {
        kind: 'finish', reason: confirmedCount(state) ? 'satisfied' : 'no_result',
        explanation: '已按原业务判据处理本次关键词与向量召回并集；集合仍受来源、权限和质量准入约束，未证明全局语义查全。',
        coverage: { checked: ['原始业务判据及显式条件', '本次关键词 OR 与向量召回并集',
          current?.regime === 'frozen_teacher' ? '固定逐票判别及全部范围身份校验' : '当前代次的模型选择与结果集合准入'],
          remaining: [], nextAction: '交付当前范围的已确认集合', nextActionValue: 'none' },
      }
      try { return await application.decide(agent, { stateId: state.stateId, judgments: [],
        gaps: state.gaps.filter(g => g.evaluator === 'model'), action }, signal) }
      catch (error) {
        signal?.throwIfAborted()
        if (!(error instanceof RetrievalError) || error.retryable || !['INVALID_REQUEST', 'INVALID_TRANSITION'].includes(error.code)) throw error
        const latest = application.current(agent)
        if (!isCurrent(latest) || latest.phase === 'stopped' || latest.phase === 'awaiting_clarification') return latest
        return application.stopIncomplete(agent, `固定执行完成，但终态准入未通过：${error.publicMessage}`, expected)
      }
    }
    const progress = JSON.stringify([state.inputGeneration, state.snapshot?.snapshotId, state.lastPage?.recallScope,
      current?.stop_reason, current?.teacher_unique_records, current?.selection_records, current?.training_records,
      current?.discovery_remaining_records, current?.selection_remaining_records,
      (state.judgments ?? []).map(j => [j.candidateRef, j.verdict, j.operatorManifestId]).sort()])
    const canContinue = (current?.stop_reason === 'needs_coverage' && Number(current.discovery_remaining_records) > 0)
      || current?.stop_reason === 'needs_selection_coverage' && Number(current.selection_remaining_records) > 0
      || plan?.goal.mode === 'examples' && state.candidates.some(c => !(state.judgments ?? []).some(j => j.candidateRef === c.ref && j.verdict !== 'undetermined'))
    if (!canContinue || progress === previous) return application.stopIncomplete(agent,
      current?.stop_reason === 'frozen_completed' ? `固定逐票判断已遍历召回范围，仍有 ${unresolved} 条不确定工单；仅保留已确认结果。`
        : `固定检索尚未满足准入：${String(current?.stop_reason ?? 'coverage_unresolved')}；${progress === previous ? '续跑未产生进展。' : '当前范围需要新信息或更可靠的模型。'}`, expected)
    previous = progress
  }
}
