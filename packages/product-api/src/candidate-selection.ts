import {
  RetrievalError,
  type RetrievalState,
  type TicketCandidate,
  type TicketCandidateRef,
} from '@retrieval-agent/contracts'

/**
 * Resolve untrusted browser references against the current visible allowlist.
 * Current valid unjudged candidates remain readable after stopping; history and
 * excluded candidates never broaden the visible allowlist.
 */
export function hostAuthorizedCandidates(
  state: RetrievalState,
  refs: readonly TicketCandidateRef[],
): TicketCandidate[] {
  const inaccessible = ['permission_blocked', 'snapshot_invalid'].includes(state.termination)
  const excluded = new Set(state.excludedCandidateRefs)
  const candidates = new Map(
    (inaccessible ? [] : state.candidates)
      .filter(candidate => !excluded.has(candidate.ref))
      .map(candidate => [candidate.ref, candidate]),
  )
  const unique = [...new Set(refs)]
  if (unique.length === 0 || unique.some(ref => !candidates.has(ref))) {
    throw new RetrievalError('CANDIDATE_NOT_FOUND', '候选引用不属于当前可见工单集合。')
  }
  return unique.map(ref => candidates.get(ref)!)
}

/** Reading historical evidence is separate from present result/export eligibility. Provider reauthorizes every read. */
export function hostReadableCandidates(state: RetrievalState, refs: readonly TicketCandidateRef[]): TicketCandidate[] {
  if (state.accessValidation === 'required' || ['permission_blocked', 'snapshot_invalid'].includes(state.termination)) {
    throw new RetrievalError('UNAUTHORIZED', '当前历史证据访问资格失效。')
  }
  const candidates = new Map([...state.candidateHistory, ...state.candidates].map(c => [c.ref, c]))
  const unique = [...new Set(refs)]
  if (!unique.length || unique.some(ref => !candidates.has(ref))) throw new RetrievalError('CANDIDATE_NOT_FOUND', '工单不属于此任务的检索历史。')
  return unique.map(ref => candidates.get(ref)!)
}
