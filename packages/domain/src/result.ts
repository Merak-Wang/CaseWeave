import { RetrievalError } from '@retrieval-agent/contracts'
import type { RetrievalState, TicketCandidate, TicketResultCollection } from '@retrieval-agent/contracts'

/** One confirmation allowlist for reports, downloads and replay. History is never eligible. */
export function confirmedTickets(state: RetrievalState): TicketCandidate[] {
  if (['permission_blocked', 'snapshot_invalid'].includes(state.termination)) return []
  const selected = new Set(state.selectedCandidateRefs)
  const excluded = new Set(state.excludedCandidateRefs)
  const byRef = new Map(state.candidates.map(candidate => [candidate.ref, candidate]))
  const frozen = state.frozenEvidence
  return (frozen?.candidates ?? [...selected].map(ref => ({ ref }))).map(item => {
    const candidate = byRef.get(item.ref)
    if (candidate === undefined || !selected.has(item.ref) || excluded.has(item.ref)) {
      throw new RetrievalError('CANDIDATE_NOT_FOUND', '确认集合包含已不属于当前条件的工单，请重新复核。')
    }
    if (state.judgments !== undefined && !state.judgments.some(judgment => judgment.candidateRef === item.ref && judgment.verdict === 'accept')) {
      throw new RetrievalError('INVALID_TRANSITION', '确认集合缺少对应的 Agent 判断，请重新复核。')
    }
    if ('sourceVersion' in item && (item.sourceVersion !== candidate.sourceVersion
      || item.contentHash !== candidate.contentHash || item.displayId !== candidate.displayId)) {
      throw new RetrievalError('SNAPSHOT_INVALID', '确认工单的来源身份已变化，请重新复核。')
    }
    return 'evidenceLevel' in item ? { ...candidate, evidenceLevel: item.evidenceLevel } : candidate
  })
}

/** Build the sole terminal product value from deterministic controller state. */
export function createTicketResultCollection(state: RetrievalState): TicketResultCollection {
  if (state.phase !== 'stopped' || state.termination === 'active' || state.termination === 'needs_clarification') {
    throw new RetrievalError('INVALID_TRANSITION', '检索尚未结束，不能返回最终工单集合。')
  }
  const tickets = confirmedTickets(state)
  const byRef = new Map(tickets.map(candidate => [candidate.ref, candidate]))
  return {
    type: 'ticket_collection',
    schemaVersion: 2,
    retrievalId: state.retrievalId,
    resultRevision: state.frozenEvidence?.packId ?? state.stateId,
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
    judgments: (state.judgments ?? []).filter(judgment => byRef.has(judgment.candidateRef) && judgment.verdict === 'accept'),
    ...(state.stopExplanation === undefined ? {} : { explanation: state.stopExplanation }),
    evidence: state.promotedEvidence.filter(evidence => {
      const candidate = byRef.get(evidence.candidateRef)
      return candidate !== undefined && evidence.sourceVersion === candidate.sourceVersion
        && evidence.contentHash === candidate.contentHash
        && (state.frozenEvidence === undefined || state.frozenEvidence.candidates
          .some(item => item.ref === candidate.ref && item.evidenceIds.includes(evidence.evidenceId)))
    }),
    remainingGapKinds: state.gaps
      .filter(gap => gap.status === 'open' || gap.status === 'unknown')
      .map(gap => gap.kind),
  }
}
