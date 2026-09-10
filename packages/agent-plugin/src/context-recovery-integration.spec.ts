import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { LlmAdapter, LlmError, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { describe, it, expect } from 'vitest'
import { contextCompactions, installContextRecovery } from './context-recovery.js'

describe('context recovery and provider retry ownership', () => {
  it.each([
    ['429', 'Request exceeded token per minute limit'],
    ['rate_limit_exceeded', 'You exceeded the tokens per minute limit for this model'],
    ['insufficient_quota', 'Exceeded token usage limit for this billing period'],
  ])('preserves evidence and delegates token throughput/quota errors: %s', async (code, message) => {
    const ctx = new Context()
    let dispose: (() => Promise<void>) | undefined
    const requests: GenerateOptions[] = []
    let delegatedRetries = 0, projections = 0
    const evidence = '用户要求：解绑受阻；排除已解绑后的合账。决定性原文和反例均已读取。'.repeat(300)
    try {
      await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime); await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
      ctx.on('agent/request-error', async ({ failure }, next) => {
        if (failure.code !== code) return next()
        delegatedRetries++
        return { kind: 'retry' }
      })
      installContextRecovery(ctx, { owns: () => true, limit: () => 32768,
        render: async () => { projections++; return '已压缩的任务导航' } })
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      class Adapter extends LlmAdapter {
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          requests.push(options)
          if (requests.length === 1) throw new LlmError(message, code)
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '保留边界后继续完成。' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['recovery-consumer'], new Adapter())
      const handle = await ctx.agents.create({ sessionId: SessionId(`recovery-consumer-${code}`),
        agentOptions: { provider: 'recovery-consumer', model: 'fixture' } })
      dispose = handle.dispose
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: evidence }] }))
      await handle.agent.whenIdle()
      expect(requests).toHaveLength(2)
      expect(delegatedRetries).toBe(1)
      expect(projections).toBe(0)
      expect(contextCompactions(handle.agent)).toBe(0)
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain(evidence)
    } finally { await dispose?.(); await ctx.fiber.dispose() }
  })
})
