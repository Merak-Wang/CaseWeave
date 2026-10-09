import type { Agent } from '@deepseek-ai/dsh-agent'
import { RetrievalError, type RetrievalDecision, type RetrievalState } from '@retrieval-agent/contracts'
import { confirmedCount, learnedResult } from '@retrieval-agent/domain/result'
import type { RetrievalAgentService } from './service.js'

/** Fixed custom retrieval, with the same source/authorization/finish admission as tools. */
export async function runFixedRetrieval(application: RetrievalAgentService, agent: Agent, signal?: AbortSignal): Promise<RetrievalState> {
  if (!application.operators) throw new RetrievalError('PROVIDER_UNAVAILABLE', '固定检索需要已装配的语义算子。')
  const expected = application.current(agent)
  const isCurrent = (state: RetrievalState) => state.retrievalId === expected.retrievalId && (state.inputGeneration ?? 0) === (expected.inputGeneration ?? 0)
  signal?.throwIfAborted()
  let state = application.current(agent)
  if (!isCurrent(state) || state.phase === 'stopped' || state.phase === 'awaiting_clarification') return state
  state = await application.operators.searchAndFilter(agent, signal)
  signal?.throwIfAborted()
  if (!isCurrent(state) || state.phase === 'stopped' || state.phase === 'awaiting_clarification') return state
  const learning = state.budget.operatorUsage?.learning as Record<string, unknown> | undefined
  const current = learning?.input_revision === (state.inputGeneration ?? 0) ? learning : undefined
  const plan = state.query.contract?.semanticPlan
  const ready = Boolean(learnedResult(state))
    || plan?.goal.mode === 'examples' && confirmedCount(state) >= (plan.goal.count ?? Infinity)
  if (ready) {
    const action: Extract<RetrievalDecision['action'], { kind: 'finish' }> = {
      kind: 'finish', reason: confirmedCount(state) ? 'satisfied' : 'no_result',
      explanation: '已按原业务判据处理本次关键词与向量召回并集；集合仍受来源、权限和质量准入约束，未证明全局语义查全。',
      coverage: { checked: ['原始业务判据及显式条件', '本次关键词 OR 与向量召回并集',
        '当前代次的模型选择与结果集合准入'],
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
  return application.stopIncomplete(agent,
    `固定检索未完成：${String(current?.stop_reason ?? 'result_unavailable')}；没有可交付的当前结果集合。`, expected)
}
