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
      retrievalProfileVersion: state.snapshot.retrievalProfileVersion,
      retrievalCapabilities: {
        keywordSearch: state.snapshot.capabilities.keywordSearch,
        denseSearch: state.snapshot.capabilities.denseSearch,
        hybridFusion: state.snapshot.capabilities.hybridFusion,
        reranking: state.snapshot.capabilities.reranking,
      },
      fieldCatalog: state.snapshot.fieldCatalog.map(field => ({
        key: field.key,
        label: field.label,
        valueKind: field.valueKind,
        accessLevel: field.accessLevel,
        filterOperators: field.filterOperators,
      })),
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
    candidateKnowledge: {
      historyCount: state.candidateHistory.length,
      activeCount: state.candidates.length,
      excludedCandidateRefs: state.excludedCandidateRefs,
      selectedCandidateRefs: state.selectedCandidateRefs,
      lastAssessment: state.lastAssessment,
    },
    searchPage: state.lastPage === undefined ? undefined : {
      completeness: state.lastPage.completeness,
      scanned: state.lastPage.scanned,
      returned: state.lastPage.returned,
      nextPageAvailable: state.lastPage.nextCursor !== undefined,
      warnings: state.lastPage.warnings,
      trace: {
        stage: state.lastPage.trace.stage,
        requestedMode: state.lastPage.trace.requestedMode,
        executedMode: state.lastPage.trace.executedMode,
        strategyVersion: state.lastPage.trace.strategyVersion,
        channels: state.lastPage.trace.channels.map(channel => ({
          channel: channel.channel,
          implementation: channel.implementation,
          version: channel.version,
          model: channel.model,
          revision: channel.revision,
        })),
        fusion: state.lastPage.trace.fusion,
        reranker: state.lastPage.trace.reranker,
      },
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
