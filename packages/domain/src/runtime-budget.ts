import type { RetrievalBudgetState } from '@retrieval-agent/contracts'

export interface ModelRequestMeasurement {
  readonly estimatedInputTokens: number
  readonly serializationBytes: number
  readonly wallClockElapsedMs: number
  readonly accepted: boolean
}
export interface ModelResponseMeasurement {
  readonly modelLatencyMs: number
  readonly outputTokens: number
  readonly wallClockElapsedMs: number
}

export function modelRequestBudget(budget: RetrievalBudgetState, input: ModelRequestMeasurement): RetrievalBudgetState {
  const used = budget.modelStepsUsed ?? budget.roundsUsed
  const increment = input.accepted ? 1 : 0
  return {
    ...budget,
    roundsUsed: used + increment,
    modelStepsUsed: used + increment,
    latencyMs: Math.max(budget.latencyMs, input.wallClockElapsedMs),
    wallClockElapsedMs: Math.max(budget.wallClockElapsedMs ?? 0, input.wallClockElapsedMs),
    serializationBytes: (budget.serializationBytes ?? 0) + (input.accepted ? input.serializationBytes : 0),
    totalInputTokens: (budget.totalInputTokens ?? 0) + (input.accepted ? input.estimatedInputTokens : 0),
  }
}

export function modelResponseBudget(budget: RetrievalBudgetState, input: ModelResponseMeasurement): RetrievalBudgetState {
  return {
    ...budget,
    latencyMs: Math.max(budget.latencyMs, input.wallClockElapsedMs),
    wallClockElapsedMs: Math.max(budget.wallClockElapsedMs ?? 0, input.wallClockElapsedMs),
    modelLatencyMs: (budget.modelLatencyMs ?? 0) + input.modelLatencyMs,
    totalOutputTokens: (budget.totalOutputTokens ?? 0) + input.outputTokens,
  }
}

export function toolCallBudget(
  budget: RetrievalBudgetState,
  input: { readonly success: boolean; readonly serializationBytes: number },
): RetrievalBudgetState {
  return {
    ...budget,
    successfulToolCalls: (budget.successfulToolCalls ?? 0) + (input.success ? 1 : 0),
    failedToolCalls: (budget.failedToolCalls ?? 0) + (input.success ? 0 : 1),
    serializationBytes: (budget.serializationBytes ?? 0) + input.serializationBytes,
  }
}
