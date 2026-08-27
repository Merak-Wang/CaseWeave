import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RetrievalDomainEvent, RetrievalId } from '@retrieval-agent/contracts'
import { projectTicketCandidateNode } from '../projection.js'

interface CandidateConversationState {
  readonly retrievalId: RetrievalId
  readonly events: readonly RetrievalDomainEvent[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'ticket-candidates': ReturnType<typeof projectTicketCandidateNode>
  }
}

function domainEvent(event: { readonly type: string; readonly data: unknown }): RetrievalDomainEvent | undefined {
  if (!event.type.startsWith('retrieval/') || event.data === null || typeof event.data !== 'object') return undefined
  const candidate = (event.data as { readonly event?: unknown }).event
  if (candidate === null || typeof candidate !== 'object') return undefined
  return candidate as RetrievalDomainEvent
}

/** Fold every required retrieval event family into one durable candidate node. */
export const ticketCandidateDefinition: ConversationNodeDefinition<CandidateConversationState> = {
  kind: 'ticket-candidates',
  target: 'chat',
  match: (event) => {
    const retrievalEvent = domainEvent(event)
    if (retrievalEvent === undefined) return null
    return {
      id: retrievalEvent.retrievalId,
      role: retrievalEvent.type === 'retrieval/query-contracted' ? 'start' : 'update',
    }
  },
  start: (_context, match) => {
    const event = domainEvent(match.event)
    if (event === undefined || event.type !== 'retrieval/query-contracted') {
      throw new Error('ticket-candidates start requires retrieval/query-contracted')
    }
    return { retrievalId: event.retrievalId, events: [event] }
  },
  update: (context, match) => {
    const event = domainEvent(match.event)
    if (context.state === undefined) throw new Error('ticket-candidates update requires a started state')
    return event === undefined ? context.state : { ...context.state, events: [...context.state.events, event] }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'ticket-candidates',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: projectTicketCandidateNode(context.state.events, context.state.retrievalId),
    }
  },
}
