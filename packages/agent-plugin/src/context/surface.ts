import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 只整理模型视窗；原日志、业务状态和可重读来源保持可追溯。 */
export function compactRetrievalSurface(agent: Agent, options: { freshTurn?: boolean; contextWindow?: number | undefined } = {}): void {
  const surface = [...agent.session.surface.nodes]
  const nodes = surface.filter(seq => agent.session.eventAt(seq)?.type !== 'system/message')
  const window = options.contextWindow ?? agent.session.requestContext()?.contextWindow ?? 32000
  const threshold = Math.floor(window * .65)
  const measurement = agent.ctx.get('tokenMeter')!.measure(agent.session)
  const tokens = measurement.surfaceTokens
  if (!options.freshTurn && tokens <= threshold) return
  // 截止位置按完整模型/工具交换选择，保留最近四组及其校验错误。
  let keepFrom = nodes.length, exchanges = 0
  for (let i = options.freshTurn ? -1 : nodes.length - 1; i >= 0; i--) {
    if (agent.session.eventAt(nodes[i]!)?.type === 'assistant/message') { keepFrom = i; if (++exchanges === 4) break }
  }
  const old = nodes.slice(0, keepFrom)
  if (!old.length || (old.length < 2 && !options.freshTurn)) return
  const note = createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
    sections: [{ name: options.freshTurn ? 'retrieval-agent:history' : 'retrieval-agent:compaction', text: '历史已外置；当前任务要求、覆盖、判断导航和可引用证据以随后最新工作视窗为准。可用 ticket_read 取回旧候选与来源片段。' },
      ...(!options.freshTurn ? [{ name: 'retrieval-agent:compaction-details', text: JSON.stringify({ reason: 'working_set', beforeTokens: tokens, thresholdTokens: threshold, limit: window, at: new Date().toISOString() }) }] : [])] },
    content: [{ type: 'text', text: '历史工具载荷已外置并保留原始日志；当前用户要求与证据见最新工作视窗，旧事实可按稳定引用重读。' }] })
  const selected = new Set(old), prices = new Map(measurement.nodes.map(n => [n.seq, n.heuristicTokens]))
  const groups: typeof old[] = []
  let group: typeof old = []
  for (const seq of surface) {
    if (selected.has(seq)) group.push(seq)
    else if (group.length) { groups.push(group); group = [] }
  }
  if (group.length) groups.push(group)
  for (const range of groups) {
    // 官方占用投影先扣除被替换内容，再加入新消息；两条事件必须相邻。
    agent.session.append('compaction/prune', { shadowedRange: { start: range[0]!, end: range.at(-1)! },
      shadowedSeqs: range, shadowedTokenCount: range.reduce((sum, seq) => sum + prices.get(seq)!, 0) })
    agent.session.append('user/message', createUserMessage({ source: note.source, content: note.content }), {
      surfaceOp: { op: 'replace', startSeq: range[0]!, endSeq: range.at(-1)! }, sourceEventSeqs: range,
    })
  }
}
