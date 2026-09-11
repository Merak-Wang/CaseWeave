import SessionProjection from '@deepseek-ai/dsh-session-projection'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { LlmAdapter, LlmError, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { describe, it, expect } from 'vitest'
import { contextCompactions, contextCompressionStats, installContextRecovery, isContextOverflow } from './context-recovery.js'
import { compactRetrievalSurface } from './working-context.js'

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(readonly failFirst: boolean) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.failFirst && this.requests.length === 1) throw new LlmError('maximum context length exceeded', 'context_length_exceeded')
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已根据保留的任务要求继续。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('context recovery through the actual DSH request loop', () => {
  it('keeps earlier read batches available when the context has ample space', async () => {
    const ctx = new Context()
    let dispose: (() => Promise<void>) | undefined
    try {
      await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime); await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
      await ctx.plugin(SessionProjection); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      const handle = await ctx.agents.create({ sessionId: SessionId('context-read-batches') })
      dispose = handle.dispose
      for (let i = 1; i <= 5; i++) handle.agent.session.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: `已读批次${i}：含否定条件的原文`.repeat(100) }] }), { surfaceOp: 'append' })
      const before = [...handle.agent.session.surface.nodes]
      compactRetrievalSurface(handle.agent)
      expect(handle.agent.session.surface.nodes).toEqual(before)
      expect(contextCompactions(handle.agent)).toBe(0)
      const source = '工单来源：副卡在异地办理时需要核对归属。'.repeat(12000)
      handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
        sections: [{ name: 'retrieval-agent:state', text: source }] }, content: [{ type: 'text', text: source }] }), { surfaceOp: 'append' })
      const fullWindow = [...handle.agent.session.surface.nodes]
      compactRetrievalSurface(handle.agent, { contextWindow: 1000000 })
      expect(handle.agent.session.surface.nodes).toEqual(fullWindow)
      // A 1M route must not inherit an unrelated 256K history cutoff.
      handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: '未决来源'.repeat(300000) }] }), { surfaceOp: 'append' })
      const largeWindow = [...handle.agent.session.surface.nodes]
      const used = handle.agent.session.deriveMessages().reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
      expect(used).toBeGreaterThan(262144)
      expect(used).toBeLessThan(650000)
      compactRetrievalSurface(handle.agent, { contextWindow: 1000000 })
      expect(handle.agent.session.surface.nodes).toEqual(largeWindow)
      compactRetrievalSurface(handle.agent, { contextWindow: 400000 })
      expect(contextCompressionStats(handle.agent)).toMatchObject({ workingSetCount: 1, capacityCount: 0,
        last: { reason: 'working_set', beforeTokens: used, thresholdTokens: 260000, limit: 400000 } })
    } finally { await dispose?.(); await ctx.fiber.dispose() }
  })
  it.each([false, true])('compresses and continues without cancelling; provider overflow=%s', async failFirst => {
    const ctx = new Context()
    let dispose: (() => Promise<void>) | undefined
    const original = failFirst ? '只查解绑受阻，排除普通资费问题。'.repeat(1500) : '原始历史'.repeat(30000)
    const summary = '当前要求：解绑受阻；排除普通资费问题。当前候选 c1，待复核 c2，证据 e1 可重读。'
    try {
      await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime); await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
      installContextRecovery(ctx, { owns: () => true, limit: () => 32768, render: async () => summary })
      await ctx.plugin(SessionProjection); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      const adapter = new Adapter(failFirst); ctx.llm.registerAdapter(['context-fixture'], adapter)
      const handle = await ctx.agents.create({ sessionId: SessionId(`context-recovery-${failFirst}`), agentOptions: { provider: 'context-fixture', model: 'fixture' } })
      dispose = handle.dispose
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: original }] }))
      await handle.agent.whenIdle()
      const failures = handle.agent.session.snapshotEvents().filter(e => e.type === 'turn/end')
      expect(adapter.requests, JSON.stringify(failures)).toHaveLength(failFirst ? 2 : 1)
      expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain(summary)
      expect(contextCompactions(handle.agent)).toBe(1)
      expect(contextCompressionStats(handle.agent)).toMatchObject({ workingSetCount: 0, capacityCount: 1,
        last: { reason: failFirst ? 'provider_overflow' : 'window_pressure', limit: 32768 } })
      expect(handle.agent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.content.some(b => b.type === 'text' && b.text === original))).toBe(true)
      expect(handle.agent.status).toBe('idle')
    } finally { await dispose?.(); await ctx.fiber.dispose() }
  })
  it('does not misclassify network, authentication or rate errors as context overflow', () => {
    expect(isContextOverflow('429', 'rate limit exceeded')).toBe(false)
    expect(isContextOverflow('401', 'unauthorized')).toBe(false)
    expect(isContextOverflow('ECONNRESET', 'connection reset')).toBe(false)
  })
})
