import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RetrievalError } from '@retrieval-agent/contracts'
import type { RetrievalAgentService } from '../service.js'

import { compactRetrievalSurface } from './surface.js'

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
