import { RetrievalError } from '@retrieval-agent/contracts'
import type { RetrievalState, TicketCandidate, TicketResultCollection } from '@retrieval-agent/contracts'

/** Build the sole terminal product value from deterministic controller state. */
export function createTicketResultCollection(state: RetrievalState): TicketResultCollection {
  if (state.phase !== 'stopped' || state.termination === 'active' || state.termination === 'needs_clarification') {
    throw new RetrievalError('INVALID_TRANSITION', '检索尚未结束，不能返回最终工单集合。')
  }
  const inaccessible = ['permission_blocked', 'snapshot_invalid'].includes(state.termination)
  const selected = inaccessible ? [] : state.frozenEvidence?.candidates
    ?? state.selectedCandidateRefs.map(ref => ({ ref }))
  const byRef = new Map(state.candidates.map(candidate => [candidate.ref, candidate]))
  const tickets: TicketCandidate[] = selected.map(item => {
    const candidate = byRef.get(item.ref)
    if (candidate === undefined) throw new RetrievalError('CANDIDATE_NOT_FOUND', '冻结集合引用的工单不在当前状态中。')
    return candidate
  })
  const excluded = new Set(state.excludedCandidateRefs)
  const confirmed = new Set(tickets.map(candidate => candidate.ref))
  const undeterminedCandidates = inaccessible ? [] : state.candidates
    .filter(candidate => !confirmed.has(candidate.ref) && !excluded.has(candidate.ref))
  const visibleRefs = new Set([...confirmed, ...undeterminedCandidates.map(candidate => candidate.ref)])
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
    decisionFinalized: true,
    topKAccepted: state.frozenEvidence?.topKAccepted ?? false,
    resultPagesExhausted: state.frozenEvidence?.resultPagesExhausted ?? state.lastPage?.boundary?.resultPagesExhausted
      ?? (state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined),
    semanticRecallKnown: state.frozenEvidence?.semanticRecallKnown ?? state.lastPage?.boundary?.semanticRecallKnown ?? false,
    resultMayBeIncomplete: state.frozenEvidence?.resultMayBeIncomplete ?? true,
    nextPageAvailable: state.frozenEvidence?.nextPageAvailable ?? (state.lastPage?.nextCursor !== undefined),
    tickets,
    undeterminedCandidates,
    ...(state.stopExplanation === undefined ? {} : { explanation: state.stopExplanation }),
    evidence: state.promotedEvidence.filter(evidence => visibleRefs.has(evidence.candidateRef)),
    remainingGapKinds: state.gaps
      .filter(gap => gap.status === 'open' || gap.status === 'unknown')
      .map(gap => gap.kind),
  }
}
