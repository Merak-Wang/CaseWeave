import type { RetrievalGapKind, RetrievalState, TicketFilter } from '@retrieval-agent/contracts'

export function openGapKinds(state: RetrievalState): RetrievalGapKind[] {
  return state.gaps.filter(gap => gap.status === 'open' || gap.status === 'unknown').map(gap => gap.kind)
}

export function confirmedFilters(state: RetrievalState): readonly TicketFilter[] {
  return state.query.confirmedConstraints
}
