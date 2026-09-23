import type { RetrievalBudgetState, RuntimeMetrics } from '@retrieval-agent/contracts'

/** 合并官方读数的累计桶，不在业务层重新推算 token 或首 token 时间。 */
export function accumulateRuntimeMetrics(previous: RuntimeMetrics | undefined, current: RuntimeMetrics): RuntimeMetrics {
  const sum = <T extends object>(before: T | undefined, next: T): T => Object.fromEntries(Object.entries(next)
    .map(([key, value]) => [key, value + (before?.[key as keyof T] ?? 0)])) as T
  return { ...previous, ...current,
    ...(current.tokenUsage ? { tokenUsage: sum(previous?.tokenUsage, current.tokenUsage) } : {}),
    ...(current.sessionStats ? { sessionStats: sum(previous?.sessionStats, current.sessionStats) } : {}) }
}

export interface ModelRequestMeasurement {
  readonly compression?: import('@retrieval-agent/contracts').ContextCompressionStats
  readonly compactionCount?: number
  readonly outputReservedTokens?: number
  readonly protocolMarginTokens?: number
  readonly estimatedInputTokens: number
  readonly serializationBytes: number
  readonly wallClockElapsedMs: number
  readonly modelContextWindow?: number
  readonly deploymentContextLimit?: number
  readonly effectiveContextLimit?: number
  readonly rejectionReason?: 'model_context' | 'deployment_context'
  readonly accepted: boolean
}
export interface ModelResponseMeasurement {
  readonly runtimeMetrics?: RuntimeMetrics
  readonly inputTokens?: number
  readonly modelLatencyMs: number
  readonly outputTokens: number
  readonly wallClockElapsedMs: number
}

export function modelRequestBudget(budget: RetrievalBudgetState, input: ModelRequestMeasurement): RetrievalBudgetState {
  const used = budget.modelStepsUsed
  const increment = input.accepted ? 1 : 0
  return {
    ...budget,
    modelStepsUsed: used + increment,
    context: { estimatedInputTokens: input.estimatedInputTokens,
      ...((input.effectiveContextLimit ?? input.modelContextWindow) === undefined ? {} : { limit: input.effectiveContextLimit ?? input.modelContextWindow! }),
      reservedTokens: (input.outputReservedTokens ?? 0) + (input.protocolMarginTokens ?? 0),
      compactionCount: input.compactionCount ?? budget.context?.compactionCount ?? 0,
      ...(input.compression ? { compression: input.compression } : {}) },
    wallClockElapsedMs: Math.max(budget.wallClockElapsedMs ?? 0, input.wallClockElapsedMs),
    serializationBytes: (budget.serializationBytes ?? 0) + (input.accepted ? input.serializationBytes : 0),
    totalInputTokens: (budget.totalInputTokens ?? 0) + (input.accepted ? input.estimatedInputTokens : 0),
  }
}

export function modelResponseBudget(budget: RetrievalBudgetState, input: ModelResponseMeasurement): RetrievalBudgetState {
  return {
    ...budget,
    ...(input.runtimeMetrics ? { runtimeMetrics: accumulateRuntimeMetrics(budget.runtimeMetrics, input.runtimeMetrics) } : {}),
    ...(budget.context && input.inputTokens !== undefined ? { context: { ...budget.context, measuredInputTokens: input.inputTokens } } : {}),
    ...(input.inputTokens === undefined ? {} : { totalMeasuredInputTokens: (budget.totalMeasuredInputTokens ?? 0) + input.inputTokens }),
    wallClockElapsedMs: Math.max(budget.wallClockElapsedMs ?? 0, input.wallClockElapsedMs),
    modelLatencyMs: (budget.modelLatencyMs ?? 0) + input.modelLatencyMs,
    totalOutputTokens: (budget.totalOutputTokens ?? 0) + input.outputTokens,
  }
}

export function toolCallBudget(
  budget: RetrievalBudgetState,
  input: { readonly success: boolean; readonly serializationBytes: number; readonly failureSignature?: string },
): RetrievalBudgetState {
  const { repeatedToolFailure, ...previous } = budget
  return {
    ...previous,
    successfulToolCalls: (budget.successfulToolCalls ?? 0) + (input.success ? 1 : 0),
    failedToolCalls: (budget.failedToolCalls ?? 0) + (input.success ? 0 : 1),
    consecutiveToolErrors: input.success ? 0 : (budget.consecutiveToolErrors ?? 0) + 1,
    ...(!input.success && input.failureSignature ? { repeatedToolFailure: { signature: input.failureSignature,
      count: repeatedToolFailure?.signature === input.failureSignature ? repeatedToolFailure.count + 1 : 1 } } : {}),
    serializationBytes: (budget.serializationBytes ?? 0) + input.serializationBytes,
  }
}
