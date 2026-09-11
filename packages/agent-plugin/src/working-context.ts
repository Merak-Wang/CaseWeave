import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RetrievalError } from '@retrieval-agent/contracts'
import { estimateContextTokens } from '@retrieval-agent/domain'
import type { RetrievalAgentService } from './service.js'

/** Replace only the model surface. Original messages, evidence and decisions remain replayable. */
export function compactRetrievalSurface(agent: Agent, options: { freshTurn?: boolean; contextWindow?: number | undefined } = {}): void {
  // DSH V3 owns the head and may append further system prompts in history.
  const surface = [...agent.session.surface.nodes]
  const nodes = surface.filter(seq => agent.session.eventAt(seq)?.type !== 'system/message')
  const window = options.contextWindow ?? agent.session.requestContext()?.contextWindow ?? 32000
  const threshold = Math.floor(window * .65)
  // Measure model messages, not durable envelopes: source.sections repeats content for replay.
  const tokens = options.freshTurn ? 0 : agent.session.deriveMessages().reduce((sum, message) => sum
    + (agent.ctx.get('tokenMeter')?.estimateMessage(message) ?? estimateContextTokens(JSON.stringify(message.content))), 0)
  if (!options.freshTurn) {
    // A small visible window is not a reason to forget recently read sources.
    if (tokens <= threshold) return
  }
  // Preserve recent complete assistant/tool exchanges, including validation errors.
  let keepFrom = nodes.length
  let exchanges = 0
  for (let i = options.freshTurn ? -1 : nodes.length - 1; i >= 0; i--) {
    const event = agent.session.eventAt(nodes[i]!)
    if (event?.type === 'assistant/message') { keepFrom = i; if (++exchanges === 4) break }
  }
  const old = nodes.slice(0, keepFrom)
  if (!old.length || (old.length < 2 && !options.freshTurn)) return
  const note = createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
    sections: [{ name: options.freshTurn ? 'retrieval-agent:history' : 'retrieval-agent:compaction', text: '历史已外置；当前任务要求、覆盖、判断导航和可引用证据以随后最新工作视窗为准。可用 ticket_read 取回旧候选与来源片段。' },
      ...(!options.freshTurn ? [{ name: 'retrieval-agent:compaction-details', text: JSON.stringify({ reason: 'working_set', beforeTokens: tokens, thresholdTokens: threshold, limit: window, at: new Date().toISOString() }) }] : [])] },
    content: [{ type: 'text', text: '历史工具载荷已外置并保留原始日志；当前用户要求与证据见最新工作视窗，旧事实可按稳定引用重读。' }] })
  const selected = new Set(old)
  const groups: typeof old[] = []
  let group: typeof old = []
  for (const seq of surface) {
    if (selected.has(seq)) group.push(seq)
    else if (group.length) { groups.push(group); group = [] }
  }
  if (group.length) groups.push(group)
  for (const range of groups) agent.session.append('user/message', createUserMessage({ source: note.source, content: note.content }), {
    surfaceOp: { op: 'replace', startSeq: range[0]!, endSeq: range.at(-1)! }, sourceEventSeqs: range,
  })
}

export function installWorkingContext(ctx: Context, application: RetrievalAgentService): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || application.coordinator?.isExpert(agent)) return decision
    const initial = application.currentOrUndefined(agent)
    if (!initial || initial.phase === 'stopped' || initial.phase === 'awaiting_clarification') return decision
    try {
      await application.prepareExperts(agent, signal)
      compactRetrievalSurface(agent, { contextWindow: application.modelContextTokenLimit(agent) })
      const selection = await application.projectContext(agent)
      const pending = decision.messages.filter(message => !(message.source.kind === 'plugin' && message.source.plugin === 'retrieval-agent'
        && message.source.form === 'snapshot' && message.source.sections.some(section => section.name === 'retrieval-agent:state')))
      return { kind: 'enter' as const, messages: [...pending, createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
        sections: [{ name: 'retrieval-agent:state', text: selection.rendered }] }, content: [{ type: 'text', text: selection.rendered }] })] }
    } catch (error) {
      if (!(error instanceof RetrievalError) || error.code !== 'CAPACITY_EXCEEDED') throw error
      await application.stopIncomplete(agent, error.publicMessage)
      return { kind: 'enter' as const, messages: [] }
    }
  }, { prepend: true })
}
