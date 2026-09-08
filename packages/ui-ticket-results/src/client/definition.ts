import type {
  ChatConversationViewNode,
  ConversationMatch,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  RETRIEVAL_PRESENTATION_EVENT_TYPE,
  type RetrievalDomainEvent,
  type RetrievalId,
  type RetrievalPresentationAnchor,
  type RetrievalPresentationPhase,
} from '@retrieval-agent/contracts'
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

function presentationAnchor(
  event: { readonly type: string; readonly data: unknown },
): RetrievalPresentationAnchor | undefined {
  if (event.type !== RETRIEVAL_PRESENTATION_EVENT_TYPE
    || event.data === null
    || typeof event.data !== 'object') return undefined
  const candidate = event.data as Partial<RetrievalPresentationAnchor>
  if (typeof candidate.retrievalId !== 'string'
    || (candidate.phase !== 'candidates' && candidate.phase !== 'result')
    || !Number.isSafeInteger(candidate.turn)) return undefined
  return candidate as RetrievalPresentationAnchor
}

function presentationMatch(
  matches: readonly ConversationMatch[],
  phase: RetrievalPresentationPhase,
): ConversationMatch | undefined {
  return matches.findLast(match => {
    const anchor = presentationAnchor(match.event)
    return anchor?.phase === phase
  })
}

/** Fold every required retrieval event family into one durable candidate node. */
export const ticketCandidateDefinition: ConversationNodeDefinition<CandidateConversationState> = {
  kind: 'ticket-candidates',
  target: 'chat',
  match: (event) => {
    const anchor = presentationAnchor(event)
    if (anchor !== undefined) return { id: anchor.retrievalId, role: 'update' }
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
    let data: ReturnType<typeof projectTicketCandidateNode>
    try {
      data = projectTicketCandidateNode(context.state.events, context.state.retrievalId)
    } catch {
      // A corrupted event chain must only hide its own node, never fail the session projection.
      return null
    }
    const phase: RetrievalPresentationPhase = data.result === undefined ? 'candidates' : 'result'
    const anchor = presentationMatch(context.matches, phase)
    // The visible query is persisted before pre-step retrieval starts, but the
    // candidate node publishes nothing until Harness records the post-query
    // candidate boundary; likewise hide terminal data until every parallel tool row has drained.
    if (anchor === undefined) return null
    return {
      key: context.key,
      kind: 'ticket-candidates',
      id: context.id,
      target: 'chat',
      anchorSeq: anchor.event.seq,
      location: anchor.location,
      visibility: 'visible',
      data,
    }
  },
}
