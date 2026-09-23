import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sessionMetrics, contextCompressionStats } from '@retrieval-agent/agent-plugin'
import type { RetrievalState, RuntimeMetrics } from '@retrieval-agent/contracts'

function latestMetrics(live: RuntimeMetrics | undefined, saved: RuntimeMetrics | undefined) {
  return (live?.sessionStats?.steps ?? 0) > (saved?.sessionStats?.steps ?? 0) ? live : saved ?? live
}

export function taskRuntimeMetrics(agent: Agent, state: RetrievalState) {
  const liveCompression = contextCompressionStats(agent), savedCompression = state.budget?.context?.compression
  const total = (c: typeof liveCompression) => c.workingSetCount + c.capacityCount + (c.dshCount ?? 0)
  const compression = savedCompression && total(savedCompression) > total(liveCompression) ? savedCompression : liveCompression
  return { main: sessionMetrics(agent.ctx, agent.session), compression,
    experts: Object.fromEntries((state.expertTasks ?? []).map(task => {
      const child = task.childSessionId && agent.ctx.get('agents')!.get(SessionId(task.childSessionId))
      return [task.id, latestMetrics(child ? sessionMetrics(agent.ctx, child.session) : undefined, task.runtimeMetrics)]
    })) }
}
export type TaskRuntimeMetrics = ReturnType<typeof taskRuntimeMetrics>

/** 速度按官方 decodeTokens / decodeMs 汇总；并行调用时间相加，不冒充任务墙钟吞吐。 */
function speed(metrics: readonly (RuntimeMetrics | undefined)[]) {
  let decodeTokens = 0, decodeMs = 0, ttftMs = 0, ttftSteps = 0, steps = 0
  for (const m of metrics) if (m?.sessionStats) {
    const s = m.sessionStats
    decodeTokens += s.decodeTokens; decodeMs += s.decodeMs
    ttftMs += s.ttftMs; ttftSteps += s.ttftSteps; steps += s.steps
  }
  return { tokensPerSecond: decodeMs > 0 ? decodeTokens * 1000 / decodeMs : null,
    firstTokenMs: ttftSteps > 0 ? ttftMs / ttftSteps : null, measuredSteps: steps, timedSteps: ttftSteps }
}

export function projectUsage(state: RetrievalState, runtime?: TaskRuntimeMetrics) {
  const tasks = state.expertTasks ?? [], operatorUsage = state.budget?.operatorUsage
  // MySQL 可以先恢复任务而尚未恢复完整 DSH 日志；空/部分日志不能覆盖累计回执。
  const mainRequests = state.budget?.modelStepsUsed ?? 0
  const mainMetrics = latestMetrics(runtime?.main, state.budget?.runtimeMetrics)
  const main = (mainMetrics?.sessionStats?.steps ?? 0) >= mainRequests ? mainMetrics?.tokenUsage : undefined
  const expert = (id: string) => (runtime?.experts[id] ?? tasks.find(t => t.id === id)?.runtimeMetrics)?.tokenUsage
  const mainOutputTokens = main?.outputTokens ?? state.budget?.totalOutputTokens ?? 0
  const expertOutputTokens = tasks.reduce((sum, task) => sum + (expert(task.id)?.outputTokens ?? task.runtimeMetrics?.tokenUsage?.outputTokens ?? task.outputTokens ?? 0), 0)
  const input = (u: NonNullable<RuntimeMetrics['tokenUsage']>) => u.uncachedInputTokens + u.cacheReadTokens + u.cacheWriteTokens
  const measuredInput = main ? input(main) : state.budget?.totalMeasuredInputTokens ?? ((state.budget?.modelStepsUsed ?? 0) === 0 ? 0 : undefined)
  const expertInput = tasks.reduce((sum, t) => sum + (expert(t.id) ? input(expert(t.id)!) : t.inputTokens ?? 0), 0)
  const expertComplete = !tasks.some(t => (t.modelSteps ?? 0) > 0 && !expert(t.id) && t.inputTokens === undefined)
  // 相同清单的缓存复用不重复计时；保留旧输入代次，因为消耗已经发生。
  const operators = [...new Map((state.contextManifests ?? []).filter(m => m.operator && m.runtimeMetrics)
    .map(m => [m.operator!.pythonManifestId, m.runtimeMetrics])).values()]
  const expertRequests = tasks.reduce((sum, t) => sum + (t.modelSteps ?? 0), 0)
  const operatorRequests = Number(operatorUsage?.llm_adapter_calls ?? 0)
  const operatorReceipts = operators.flatMap(m => m?.tokenUsage ? [m.tokenUsage] : [])
  const completeOperatorReceipts = operatorRequests > 0 && operatorReceipts.length === operatorRequests && operatorUsage?.accounting_complete !== false
  const operatorOutputTokens = completeOperatorReceipts ? operatorReceipts.reduce((sum, u) => sum + u.outputTokens, 0)
    : Number(operatorUsage?.reported_completion_tokens ?? 0)
  const operatorInputTokens = completeOperatorReceipts ? operatorReceipts.reduce((sum, u) => sum + input(u), 0)
    : Number(operatorUsage?.reported_prompt_tokens ?? 0)
  return { outputTokens: mainOutputTokens + expertOutputTokens + operatorOutputTokens, mainOutputTokens, expertOutputTokens, operatorOutputTokens,
    inputTokens: measuredInput !== undefined && expertComplete && operatorUsage?.accounting_complete !== false
      ? measuredInput + expertInput + operatorInputTokens : null,
    mainMeasuredInputTokens: measuredInput ?? null, expertInputTokens: expertInput, operatorUsage,
    mainRequests, expertRequests, operatorRequests, modelRequests: mainRequests + expertRequests + operatorRequests,
    speed: speed([mainMetrics,
      ...tasks.map(t => runtime?.experts[t.id] ?? t.runtimeMetrics), ...operators]),
    mainTokenUsage: main,
    experts: tasks.map(t => ({ id: t.id, title: state.knowledgeCatalog?.domains.find(d => d.id === t.domainId)?.description ?? t.domainId,
      outputTokens: expert(t.id)?.outputTokens ?? t.runtimeMetrics?.tokenUsage?.outputTokens ?? t.outputTokens ?? 0, inputGeneration: t.inputGeneration })) }
}

export function projectContext(state: RetrievalState, runtime?: TaskRuntimeMetrics) {
  const generation = state.inputGeneration ?? 0
  const latest = state.contextManifests?.findLast(m => m.inputGeneration === generation && m.measurement === 'dsh_request' && m.operator)
  const request = (latest?.operator?.metrics?.context ?? state.budget?.operatorUsage?.context) as {
    measuredInputTokens?: number; limit?: number; model?: string; operation?: string
  } | undefined
  const operator = latest ? { estimatedInputTokens: latest.estimatedTokens, measuredInputTokens: request?.measuredInputTokens,
    limit: request?.limit, reservedTokens: 4096, compactionCount: 0, source: 'operator', operation: request?.operation ?? latest.operator!.operation,
    model: request?.model } : undefined
  const active = state.operatorActivity?.inputGeneration === generation && state.operatorActivity.status === 'running'
  const base = active || !state.budget?.context ? operator ?? state.budget?.context : state.budget.context
  const pressure = runtime?.main.contextPressure
  return base ? { ...base, ...(runtime ? { compression: runtime.compression } : {}),
    ...(!('source' in base) && pressure?.projectedTokens !== undefined ? {
      projectedInputTokens: pressure.projectedTokens, measuredInputTokens: pressure.pressureTokens,
      limit: pressure.contextWindow ?? base.limit, breakdown: runtime?.main.contextBreakdown, measurementSource: 'dsh',
    } : {}) } : undefined
}
