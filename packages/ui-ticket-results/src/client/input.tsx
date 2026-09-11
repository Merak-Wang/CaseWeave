import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { RETRIEVAL_INPUT_ACCEPTED_EVENT_TYPE, type RetrievalInputAccepted } from '@retrieval-agent/contracts'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'ticket-input': RetrievalInputAccepted }
}

/** Show the accepted query while fast search runs or when no model step is needed.
 * The native user-message row takes over once DSH admits that exact message ID. */
export const ticketInputDefinition: ConversationNodeDefinition<{ input: RetrievalInputAccepted; admitted: boolean }> = {
  kind: 'ticket-input', target: 'chat',
  match(event) {
    if (event.type === RETRIEVAL_INPUT_ACCEPTED_EVENT_TYPE) {
      const data = event.data as unknown as RetrievalInputAccepted
      return { id: data.messageId, role: 'start' }
    }
    if (event.type === 'user/message') return { id: event.data.id, role: 'update' }
    return null
  },
  start: (_context, match) => ({ input: match.event.data as unknown as RetrievalInputAccepted, admitted: false }),
  update: (context) => ({ ...context.state!, admitted: true }),
  buildViewNode(context) {
    if (!context.start || !context.state || context.state.admitted) return null
    return { key: context.key, kind: 'ticket-input', id: context.id, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location, visibility: 'visible', data: context.state.input }
  },
}

export function AcceptedTicketInput({ node }: PropsRuntime<'conversation.chat.node', 'ticket-input'>) {
  return <div style={{ whiteSpace: 'pre-wrap', padding: '12px 16px', marginLeft: 'auto', maxWidth: '85%',
    borderRadius: 16, background: 'var(--background-secondary, #f3f4f6)', color: 'inherit' }}>{node.data.text}</div>
}
