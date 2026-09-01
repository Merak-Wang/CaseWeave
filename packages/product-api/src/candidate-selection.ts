import {
  RetrievalError,
  type RetrievalState,
  type TicketCandidate,
  type TicketCandidateRef,
} from '@retrieval-agent/contracts'

/**
 * Resolve untrusted browser references against the current visible allowlist.
 * Once a retrieval stops, only the frozen selection remains readable/exportable.
 */
export function hostAuthorizedCandidates(
  state: RetrievalState,
  refs: readonly TicketCandidateRef[],
): TicketCandidate[] {
  const frozenRefs = state.frozenEvidence?.candidates.map(candidate => candidate.ref)
  const allowedRefs = new Set(state.phase === 'stopped' ? frozenRefs ?? [] : state.candidates.map(candidate => candidate.ref))
  const candidates = new Map(
    [...state.candidateHistory, ...state.candidates]
      .filter(candidate => allowedRefs.has(candidate.ref))
      .map(candidate => [candidate.ref, candidate]),
  )
  const unique = [...new Set(refs)]
  if (unique.length === 0 || unique.some(ref => !candidates.has(ref))) {
    throw new RetrievalError('CANDIDATE_NOT_FOUND', '候选引用不属于当前可见工单集合。')
  }
  return unique.map(ref => candidates.get(ref)!)
}
