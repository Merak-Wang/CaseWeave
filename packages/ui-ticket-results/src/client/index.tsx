import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CandidatePanel } from './CandidatePanel.js'
import { ticketCandidateDefinition } from './definition.js'
import { ProductHeaderExport } from './HeaderExport.js'

export const inject = ['conversationEvents', 'slots']

/**
 * Retrieval product prose is rendered only from deterministic domain nodes.
 * The complete model stream remains durable and available in the trajectory
 * view, while an assistant text/reasoning row cannot become product output.
 */
function SuppressedRetrievalAssistantNode(): null {
  return null
}

/** Register the durable candidate Definition and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'retrieval-agent-export', order: 100, label: '导出工单',
  }, ProductHeaderExport))
  ctx.conversationEvents.register(ticketCandidateDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    priority: -100,
  }, SuppressedRetrievalAssistantNode))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'ticket-candidates',
  }, CandidatePanel))
}
