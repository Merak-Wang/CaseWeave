/** DSH 官方投影的可序列化读数；业务层保存回执，不重复实现 token 或速度算法。 */
export interface RuntimeMetrics {
  tokenUsage?: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  sessionStats?: { turns: number; steps: number; llmMs: number; toolMs: number; ttftMs: number; ttftSteps: number; decodeMs: number; decodeTokens: number }
  contextPressure?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }
  contextBreakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number }
}
