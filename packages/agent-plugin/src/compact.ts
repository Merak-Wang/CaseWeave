import type { FrozenEvidencePack, RetrievalState } from '@retrieval-agent/contracts'

/** Bounded model-facing state projection; full state remains durable in Session events. */
export function compactRetrievalState(state: RetrievalState): unknown {
  return {
    retrievalId: state.retrievalId,
    stateId: state.stateId,
    phase: state.phase,
    termination: state.termination,
    query: {
      normalized: state.query.spec.normalizedQuery,
      confirmedConstraints: state.query.confirmedConstraints,
      unresolvedConstraints: state.query.unresolvedConstraints,
    },
    snapshot: state.snapshot === undefined ? undefined : {
      id: state.snapshot.shortId,
      sourceVersion: state.snapshot.sourceVersion,
      indexVersion: state.snapshot.indexVersion,
    },
    candidates: state.candidates.slice(0, state.task.requestedCount).map(candidate => ({
      ref: candidate.ref,
      displayId: candidate.displayId,
      rank: candidate.rank,
      title: candidate.title,
      summary: candidate.summary,
      l0: candidate.l0,
      matchFragments: candidate.matchFragments,
    })),
    searchPage: state.lastPage === undefined ? undefined : {
      completeness: state.lastPage.completeness,
      nextCursor: state.lastPage.nextCursor,
      scanned: state.lastPage.scanned,
      returned: state.lastPage.returned,
      warnings: state.lastPage.warnings,
    },
    promotedEvidence: state.promotedEvidence.map(evidence => ({
      evidenceId: evidence.evidenceId,
      candidateRef: evidence.candidateRef,
      displayId: evidence.displayId,
      field: evidence.field,
      text: evidence.text,
      truncated: evidence.truncated,
    })),
    gaps: state.gaps,
    allowedActions: state.allowedActions.map(action => ({
      kind: action.kind,
      candidateAllowlist: action.candidateAllowlist,
      fieldAllowlist: action.fieldAllowlist,
      maxTokens: action.maxTokens,
    })),
    budget: state.budget,
    clarification: state.clarification,
    frozenEvidence: state.frozenEvidence === undefined ? undefined : compactFrozenPack(state.frozenEvidence),
  }
}

export function compactFrozenPack(pack: FrozenEvidencePack): unknown {
  return {
    packId: pack.packId,
    retrievalId: pack.retrievalId,
    query: pack.query,
    candidates: pack.candidates,
    stoppingReason: pack.stoppingReason,
    remainingGaps: pack.remainingGaps,
    complete: pack.complete,
    snapshot: pack.snapshot.shortId,
  }
}
