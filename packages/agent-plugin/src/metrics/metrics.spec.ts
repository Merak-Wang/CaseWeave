import { Context } from '@deepseek-ai/cordis'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { installSessionMetrics } from './session.js'
import { ModelCallMetrics } from './model-call.js'

describe('operator calls using official DSH projections', () => {
  it('keeps parallel calls independent and folds cache, output and decode time with official units', async () => {
    const ctx = new Context()
    vi.useFakeTimers(); vi.setSystemTime(1000)
    try {
      await ctx.plugin(SessionProjection); await ctx.plugin(TokenMeter); await installSessionMetrics(ctx)
      const a = new ModelCallMetrics(ctx, { provider: 'fixture', model: 'test', sessionId: SessionId('a'), messages: [] }, 32000)
      const b = new ModelCallMetrics(ctx, { provider: 'fixture', model: 'test', sessionId: SessionId('b'), messages: [] }, 32000)
      vi.setSystemTime(1100)
      a.push({ type: 'text-delta', index: 0, text: '有来源的结果' })
      vi.setSystemTime(1300)
      b.push({ type: 'text-delta', index: 0, text: '另一批结果' })
      a.push({ type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 40 } })
      b.push({ type: 'usage', usage: { inputTokens: 30, outputTokens: 7 } })
      vi.setSystemTime(2100)
      expect(a.finish(true)).toMatchObject({ tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 40 },
        sessionStats: { steps: 1, ttftMs: 100, ttftSteps: 1, decodeMs: 1000, decodeTokens: 40 } })
      // 失败仍计供应商消耗和结束步骤，不伪造一个成功响应的解码速度。
      expect(b.finish(false)).toMatchObject({ tokenUsage: { uncachedInputTokens: 30, outputTokens: 7 },
        sessionStats: { steps: 1, decodeMs: 0, decodeTokens: 0 } })
    } finally { vi.useRealTimers(); await ctx.fiber.dispose() }
  })
})
