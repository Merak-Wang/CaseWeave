import { RetrievalError, isReadableTicketField, type RetrievalState } from '@retrieval-agent/contracts'

/** Reauthorized task projection: judgment citations only, never search-match highlights or private grants. */
export function candidateEvidence(state: RetrievalState, candidateRef: string) {
  if (state.accessValidation !== 'current' || ['snapshot_invalid', 'permission_blocked'].includes(state.termination)) {
    throw new RetrievalError('UNAUTHORIZED', '当前证据访问资格失效，请重新检索。')
  }
  const candidate = state.candidates.find(c => c.ref === candidateRef)
  if (!candidate) throw new RetrievalError('INVALID_REQUEST', '工单不属于当前任务集合。')
  const judgment = state.judgments?.find(j => j.candidateRef === candidateRef)
  const allowed = new Set(state.snapshot?.fieldCatalog.filter(isReadableTicketField).map(f => f.key))
  const citations = state.promotedEvidence.filter(e => e.candidateRef === candidateRef
    && e.sourceVersion === candidate.sourceVersion && e.contentHash === candidate.contentHash
    && allowed.has(e.field) && judgment?.evidenceRefs.includes(e.evidenceId)
    && state.modelVisibleEvidenceIds?.includes(e.evidenceId)).map(e => ({
      id: String(e.evidenceId), candidateRef: String(e.candidateRef), sourceVersion: e.sourceVersion,
      contentHash: e.contentHash, field: e.field, part: e.part ?? 0, start: e.start,
      end: e.start + Math.min(1600, e.text.length), text: e.text.slice(0, 1600), origin: e.origin ?? { kind: 'unknown' },
    }))
  if (allowed.has('summary') && judgment?.evidenceRefs.includes(candidate.ref) && state.modelVisibleCandidateRefs?.includes(candidate.ref)) {
    citations.push({ id: candidate.ref, candidateRef, sourceVersion: candidate.sourceVersion, contentHash: candidate.contentHash,
      field: 'summary', part: 0, start: 0, end: Math.min(1600, candidate.summary.length), text: candidate.summary.slice(0, 1600), origin: candidate.summaryOrigin ?? { kind: 'unknown' } })
  }
  return { candidateRef, displayId: candidate.displayId, sourceVersion: candidate.sourceVersion, contentHash: candidate.contentHash,
    inputGeneration: state.inputGeneration ?? 0, judgment: judgment ? { verdict: judgment.verdict, reason: judgment.reason } : null,
    citationCount: citations.length, citations: citations.slice(0, 30) }
}
