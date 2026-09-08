import type { RetrievalDomainEvent, RetrievalId, TicketCandidateNode } from '@retrieval-agent/contracts'
import { foldRetrievalEvents } from '@retrieval-agent/domain/replay'
import { projectTicketCandidateState } from '@retrieval-agent/product-api/presentation'

/** Historical projection is an inspectable fact, never a fresh authorization grant. */
export function projectTicketCandidateNode(
  events: readonly RetrievalDomainEvent[],
  retrievalId: RetrievalId,
): TicketCandidateNode {
  const relevant = events.filter(event => event.retrievalId === retrievalId)
  const contract = relevant.find(event => event.type === 'retrieval/query-contracted')
  return projectTicketCandidateState(foldRetrievalEvents(relevant, retrievalId), retrievalId,
    contract?.type === 'retrieval/query-contracted' ? {
      query: contract.data.spec.originalQuery,
      queryContract: contract.data.queryContract,
    } : {})
}
