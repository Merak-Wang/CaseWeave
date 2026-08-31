import { RetrievalError } from '@retrieval-agent/contracts'
import type { RetrievalState, TicketCandidate, TicketResultCollection } from '@retrieval-agent/contracts'

/** Build the sole terminal product value from deterministic controller state. */
export function createTicketResultCollection(state: RetrievalState): TicketResultCollection {
  if (state.phase !== 'stopped' || state.termination === 'active' || state.termination === 'needs_clarification') {
    throw new RetrievalError('INVALID_TRANSITION', '检索尚未结束，不能返回最终工单集合。')
  }
  const selected = state.frozenEvidence?.candidates ?? []
  const byRef = new Map(state.candidates.map(candidate => [candidate.ref, candidate]))
  const tickets: TicketCandidate[] = selected.map(item => {
    const candidate = byRef.get(item.ref)
    if (candidate === undefined) throw new RetrievalError('CANDIDATE_NOT_FOUND', '冻结集合引用的工单不在当前状态中。')
    return candidate
  })
  return {
    type: 'ticket_collection',
    schemaVersion: 1,
    retrievalId: state.retrievalId,
    ...(state.frozenEvidence === undefined ? {} : { packId: state.frozenEvidence.packId }),
    query: state.query.original,
    target: state.task.target,
    ...(state.snapshot === undefined ? {} : { snapshotShortId: state.snapshot.shortId }),
    stoppingReason: state.termination,
    complete: state.frozenEvidence?.complete ?? false,
    tickets,
    evidence: state.promotedEvidence.filter(evidence => tickets.some(ticket => ticket.ref === evidence.candidateRef)),
    remainingGapKinds: state.gaps
      .filter(gap => gap.status === 'open' || gap.status === 'unknown')
      .map(gap => gap.kind),
  }
}
