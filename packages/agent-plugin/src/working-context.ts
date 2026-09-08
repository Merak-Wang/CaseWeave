import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RetrievalError } from '@retrieval-agent/contracts'
import type { RetrievalAgentService } from './service.js'

/** Replace only the model surface. Original messages, evidence and decisions remain replayable. */
export function compactRetrievalSurface(agent: Agent, options: { freshTurn?: boolean } = {}): void {
  const nodes = [...agent.session.surface.nodes]
  // Retain the last assistant/tool exchange (including validation errors). Older payloads are recoverable by ID.
  let keepFrom = nodes.length
  for (let i = options.freshTurn ? -1 : nodes.length - 1; i >= 0; i--) {
    const event = agent.session.events[nodes[i]!]
    if (event?.type === 'assistant/message') { keepFrom = i; break }
  }
  const old = nodes.slice(0, keepFrom)
  if (old.length < 2) return
  const note = createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
    sections: [{ name: 'retrieval-agent:history', text: '历史已外置；当前任务要求、覆盖、判断导航和可引用证据以随后最新工作视窗为准。可用 inspect history 取回旧候选与来源片段。' }] },
    content: [{ type: 'text', text: '历史工具载荷已外置并保留原始日志；当前用户要求与证据见最新工作视窗，旧事实可按稳定引用重读。' }] })
  agent.session.append('user/message', note, { surfaceOp: { op: 'replace', start: old[0]!, end: old.at(-1)! }, sourceEventSeqs: old })
}

export function installWorkingContext(ctx: Context, application: RetrievalAgentService): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || application.coordinator?.isExpert(agent)) return decision
    const initial = application.currentOrUndefined(agent)
    if (!initial || initial.phase === 'stopped' || initial.phase === 'awaiting_clarification') return decision
    try {
      await application.prepareExperts(agent, signal)
      compactRetrievalSurface(agent)
      const selection = await application.projectContext(agent)
      return { kind: 'enter' as const, messages: [createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
        sections: [{ name: 'retrieval-agent:state', text: selection.rendered }] }, content: [{ type: 'text', text: selection.rendered }] })] }
    } catch (error) {
      if (!(error instanceof RetrievalError) || error.code !== 'CAPACITY_EXCEEDED') throw error
      await application.stopIncomplete(agent, error.publicMessage)
      return { kind: 'enter' as const, messages: [] }
    }
  }, { prepend: true })
}
