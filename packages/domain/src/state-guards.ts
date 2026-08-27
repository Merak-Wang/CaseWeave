import {
  RetrievalError,
  type RetrievalActionKind,
  type RetrievalAllowedAction,
  type RetrievalState,
  type TicketCandidateRef,
  type TicketEvidenceField,
  type TicketL0,
} from '@retrieval-agent/contracts'

export function allowedAction(
  kind: RetrievalActionKind,
  candidateAllowlist: readonly TicketCandidateRef[] = [],
  fieldAllowlist: readonly TicketEvidenceField[] = [],
  maxTokens = 0,
): RetrievalAllowedAction {
  return { kind, candidateAllowlist, fieldAllowlist, maxTokens }
}

export function requireAction(state: RetrievalState, kind: RetrievalActionKind): RetrievalAllowedAction {
  const allowed = state.allowedActions.find(candidate => candidate.kind === kind)
  if (allowed === undefined) throw new RetrievalError('INVALID_TRANSITION', `当前检索状态不允许动作 ${kind}。`)
  return allowed
}

export function coverageGaps(candidates: readonly TicketCandidateRef[]): RetrievalState['gaps'] {
  return candidates.length === 0
    ? [{ kind: 'coverage', status: 'open', evidenceRefs: [], evaluator: 'system' }]
    : [{ kind: 'coverage', status: 'resolved', evidenceRefs: [...candidates], evaluator: 'system' }]
}

export function candidateRankOverlap(previous: readonly TicketCandidateRef[], next: readonly TicketCandidateRef[]): number {
  if (previous.length === 0 && next.length === 0) return 1
  const previousSet = new Set(previous)
  const overlap = next.filter(ref => previousSet.has(ref)).length
  return overlap / Math.max(previous.length, next.length, 1)
}

export function validateCandidateRefs(state: RetrievalState, refs: readonly TicketCandidateRef[]): TicketCandidateRef[] {
  const known = new Set(state.candidates.map(candidate => candidate.ref))
  const unique = [...new Set(refs)]
  if (unique.some(ref => !known.has(ref))) throw new RetrievalError('CANDIDATE_NOT_FOUND', '候选引用不属于当前检索快照。')
  return unique
}

export function candidateFacetValues(state: RetrievalState, facet: keyof TicketL0, refs: readonly TicketCandidateRef[]): Set<string> {
  const values = new Set<string>()
  for (const candidate of state.candidates) {
    if (!refs.includes(candidate.ref)) continue
    const value = candidate.l0[facet]
    if (typeof value === 'string' && value.trim().length > 0) values.add(value)
  }
  return values
}
