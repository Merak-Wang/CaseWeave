import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { estimateContextTokens } from '@retrieval-agent/domain'
import type { ContextCompressionStats } from '@retrieval-agent/contracts'
import { compactRetrievalSurface } from './working-context.js'

/** Count logged automatic compactions, including those restored from a previous host. */
export function contextCompactions(agent: Agent): number {
  return agent.session.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'plugin'
    && e.data.source.plugin === 'retrieval-agent' && e.data.source.form === 'snapshot'
    && e.data.source.sections.some(s => s.name === 'retrieval-agent:compaction')).length
}

/** Legacy working-set notes can be classified without rewriting saved events. */
export function contextCompressionStats(agent: Agent): ContextCompressionStats {
  let workingSetCount = 0, capacityCount = 0, last: ContextCompressionStats['last']
  for (const e of agent.session.events) {
    if (e.type !== 'user/message' || e.data.source.kind !== 'plugin' || e.data.source.plugin !== 'retrieval-agent' || e.data.source.form !== 'snapshot') continue
    const note = e.data.source.sections.find(s => s.name === 'retrieval-agent:compaction')
    if (!note) continue
    const details = e.data.source.sections.find(s => s.name === 'retrieval-agent:compaction-details')
    let info: ContextCompressionStats['last']
    try { info = details ? JSON.parse(details.text) as ContextCompressionStats['last'] : undefined } catch { /* legacy note */ }
    if (info?.reason === 'working_set' || note.text.startsWith('历史已外置')) workingSetCount++
    else capacityCount++
    if (info) last = info
  }
  return { workingSetCount, capacityCount, ...(last ? { last } : {}) }
}

/** Match explicit context overflow signals, never an arbitrary provider outage. */
export function isContextOverflow(code: string, message: string): boolean {
  const failure = `${code} ${message}`
  // Throughput and billing limits also mention "exceeded ... token ... limit".
  // Compacting cannot repair them and would discard still-useful source reads.
  if (/\b429\b|rate[_ -]?limit|insufficient[_ -]?quota|\bquota\b|billing|tokens?\s*(?:per|\/)\s*(?:second|minute|hour|day)|\b[tr]pm\b/iu.test(failure)) return false
  return /context[_ -]?(length|window|limit|overflow)|prompt[_ -]?too[_ -]?long|max(?:imum)? context|(?:input|prompt).*(?:exceed|too many).*tokens?.*limit/iu.test(failure)
}

export function requestTokens(ctx: Context, options: GenerateOptions): number {
  return options.messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
    + estimateContextTokens(JSON.stringify({ system: options.system, tools: options.tools }))
}

/** DSH usage buckets are disjoint; cached tokens still occupy the input window. */
export function inputContextTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Rebuild the next request through DSH's recovery extension; never cancel an in-flight generation for elapsed time. */
export function installContextRecovery(ctx: Context, owner: {
  owns(agent: Agent): boolean
  limit(agent: Agent): number | undefined
  render(agent: Agent, tokenBudget: number): Promise<string>
}): void {
  const attempts = new WeakMap<Agent, { count: number; budget: number; input: number; limit: number }>()
  const rebuild = async (agent: Agent, reason: 'window_pressure' | 'provider_overflow'): Promise<boolean> => {
    const previous = attempts.get(agent)
    if (!previous || previous.count >= 4) return false
    const budget = Math.floor(Math.min(previous.budget * .55, previous.limit * .45))
    if (budget < 1024) return false
    // Render first: if indispensable requirements do not fit, preserve the original model surface.
    const rendered = await owner.render(agent, budget)
    compactRetrievalSurface(agent, { freshTurn: true })
    const note = `上下文已自动压缩；原始轨迹与证据仍完整保存。根据下列权威任务状态继续完成检索，旧来源可按别名重新读取。\n${rendered}`
    agent.session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
      sections: [{ name: 'retrieval-agent:compaction', text: note }, { name: 'retrieval-agent:compaction-details',
        text: JSON.stringify({ reason, beforeTokens: previous.input, thresholdTokens: Math.floor(previous.limit * .85), limit: previous.limit, at: new Date().toISOString() }) }] }, content: [{ type: 'text', text: note }] }), { surfaceOp: 'append' })
    attempts.set(agent, { ...previous, budget, count: previous.count + 1 })
    return true
  }
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (!owner.owns(agent) || signal.aborted) return next()
    if (failure.code === 'RETRIEVAL_CONTEXT_REBUILT') return { kind: 'retry' }
    if (isContextOverflow(failure.code, failure.message) && await rebuild(agent, 'provider_overflow')) return { kind: 'retry' }
    return next()
  }, { prepend: true, global: true })
  ctx.on('llm/stream', (options, next) => {
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined
    if (!agent || options.purpose !== undefined || !owner.owns(agent)) return next()
    return (async function* () {
      const limit = owner.limit(agent) ?? agent.session.requestContext()?.contextWindow
      const input = requestTokens(ctx, options)
      const reserved = (options.maxTokens ?? 2048) + 512
      const previous = attempts.get(agent)
      const attempt = previous ?? { count: 0, budget: input, input, limit: limit ?? 262144 }
      attempts.set(agent, { ...attempt, input, limit: limit ?? attempt.limit })
      if (limit && input + reserved > limit * (attempt.count ? 1 : .85) && await rebuild(agent, 'window_pressure')) {
        yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'RETRIEVAL_CONTEXT_REBUILT', message: '上下文已自动压缩，继续当前任务。' } } }
        return
      }
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'finish' && !['error', 'aborted'].includes(chunk.reason.kind)) attempts.delete(agent)
          yield chunk
        }
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        if (!isContextOverflow(failure?.code ?? '', failure?.message ?? '')) throw error
        yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: failure.code ?? 'CONTEXT_OVERFLOW', message: failure.message ?? 'Context capacity exceeded' } } }
      }
    })()
  }, { global: true })
}
