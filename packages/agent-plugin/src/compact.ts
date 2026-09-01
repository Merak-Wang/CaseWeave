import type {
  FrozenEvidencePack,
  RetrievalState,
  TicketCandidate,
  TicketCandidateRef,
} from '@retrieval-agent/contracts'

/** Stable short aliases are assigned by first authorized observation, never by mutable rank. */
export function candidateAliases(state: RetrievalState): ReadonlyMap<TicketCandidateRef, string> {
  const aliases = new Map<TicketCandidateRef, string>()
  for (const candidate of [...state.candidateHistory, ...state.candidates]) {
    if (!aliases.has(candidate.ref)) aliases.set(candidate.ref, `c${aliases.size + 1}`)
  }
  return aliases
}

export function candidateRefForAlias(state: RetrievalState, alias: string): TicketCandidateRef | undefined {
  for (const [ref, value] of candidateAliases(state)) if (value === alias) return ref
  return undefined
}

function candidateDelta(candidate: TicketCandidate, alias: string) {
  const summary = candidate.summary.trim() === candidate.title.trim() ? undefined : candidate.summary
  return {
    alias,
    rank: candidate.rank,
    displayId: candidate.displayId,
    title: candidate.title,
    ...(summary === undefined ? {} : { summary }),
    l0: {
      ...(candidate.l0.createdAt === undefined ? {} : { createdAt: candidate.l0.createdAt }),
      ...(candidate.l0.status === undefined ? {} : { status: candidate.l0.status }),
      ...(candidate.l0.priority === undefined ? {} : { priority: candidate.l0.priority }),
      ...(candidate.l0.region === undefined ? {} : { region: candidate.l0.region }),
      ...(candidate.l0.category === undefined ? {} : { category: candidate.l0.category }),
    },
  }
}

function boundary(state: RetrievalState) {
  const sourceExhausted = state.lastPage?.completeness === 'exhaustive'
    && state.lastPage.nextCursor === undefined
  const nextPageAvailable = state.lastPage?.nextCursor !== undefined
  return {
    sourceExhausted,
    nextPageAvailable,
    decisionFinalized: state.phase === 'stopped',
    topKAccepted: state.frozenEvidence?.topKAccepted ?? false,
    resultMayBeIncomplete: !sourceExhausted,
  }
}

function compactBudget(state: RetrievalState) {
  return {
    modelStepsUsed: state.budget.modelStepsUsed ?? state.budget.roundsUsed,
    successfulToolCalls: state.budget.successfulToolCalls ?? 0,
    failedToolCalls: state.budget.failedToolCalls ?? 0,
    providerSearches: state.budget.searchesUsed,
    promotions: state.budget.promotionsUsed,
    wallClockElapsedMs: state.budget.wallClockElapsedMs ?? state.budget.latencyMs,
    modelLatencyMs: state.budget.modelLatencyMs ?? 0,
    providerLatencyMs: state.budget.providerLatencyMs ?? 0,
    totalInputTokens: state.budget.totalInputTokens ?? 0,
    totalOutputTokens: state.budget.totalOutputTokens ?? 0,
    serializationBytes: state.budget.serializationBytes ?? 0,
  }
}

/**
 * Delta-sized model projection. Complete state, long refs, field catalogs, and
 * retrieval traces remain reconstructable in Session events but are not
 * repeated after every tool call.
 */
export function compactRetrievalState(state: RetrievalState, includeCurrentCandidates = false): unknown {
  const aliases = candidateAliases(state)
  const deltaRefs = new Set(includeCurrentCandidates
    ? state.candidates.map(candidate => candidate.ref)
    : state.progress.newCandidateRefs)
  const candidates = state.candidates
    .filter(candidate => deltaRefs.has(candidate.ref))
    .map(candidate => candidateDelta(candidate, aliases.get(candidate.ref)!))
  const evidenceIds = new Set(state.progress.newEvidenceIds
    ?? (state.progress.newDecisiveEvidence ? state.promotedEvidence.map(evidence => evidence.evidenceId) : []))
  const evidenceDelta = state.promotedEvidence
    .map((evidence, index) => ({ evidence, index }))
    .filter(({ evidence }) => evidenceIds.has(evidence.evidenceId))
    .map(({ evidence, index }) => ({
      alias: `e${index + 1}`,
      candidateAlias: aliases.get(evidence.candidateRef)!,
      field: evidence.field,
      text: evidence.text,
      trust: evidence.trust,
      truncated: evidence.truncated,
    }))
  const semanticGaps = state.gaps
    .filter(gap => gap.evaluator === 'model')
    .map(gap => ({ kind: gap.kind, status: gap.status, ...(gap.description === undefined ? {} : { description: gap.description }) }))
  const systemGaps = state.gaps
    .filter(gap => gap.evaluator === 'system')
    .map(gap => ({ kind: gap.kind, status: gap.status }))
  return {
    type: 'retrieval_delta',
    retrievalId: state.retrievalId,
    stateId: state.stateId,
    revision: state.revision,
    phase: state.phase,
    termination: state.termination,
    query: {
      normalized: state.query.spec.normalizedQuery,
      task: state.task.target,
      resultPolicy: state.query.contract?.resultPolicy
        ?? (state.task.completenessRequirement === 'exhaustive' ? 'exhaustive_current_snapshot' : 'adaptive_top_k'),
    },
    candidateDelta: candidates,
    evidenceDelta,
    activeAliases: state.candidates.map(candidate => aliases.get(candidate.ref)!),
    selectedAliases: state.selectedCandidateRefs.map(ref => aliases.get(ref)).filter((alias): alias is string => alias !== undefined),
    excludedAliasCount: state.excludedCandidateRefs.length,
    gaps: { system: systemGaps, semantic: semanticGaps },
    allowedActions: state.allowedActions.map(action => action.kind),
    boundary: boundary(state),
    budget: compactBudget(state),
    ...(state.clarification === undefined ? {} : {
      clarification: { facet: state.clarification.facet, question: state.clarification.question },
    }),
  }
}

/** Compact terminal receipt; full collection is projected from durable state for UI/export. */
export function compactTerminalReceipt(state: RetrievalState): unknown {
  if (state.phase !== 'stopped') return compactRetrievalState(state)
  const aliases = candidateAliases(state)
  return {
    type: 'ticket_collection',
    schemaVersion: 2,
    retrievalId: state.retrievalId,
    packId: state.frozenEvidence?.packId,
    stoppingReason: state.termination,
    decisionFinalized: true,
    complete: state.frozenEvidence?.complete ?? false,
    topKAccepted: state.frozenEvidence?.topKAccepted ?? false,
    sourceExhausted: state.frozenEvidence?.sourceExhausted ?? false,
    resultMayBeIncomplete: state.frozenEvidence?.resultMayBeIncomplete ?? true,
    nextPageAvailable: state.frozenEvidence?.nextPageAvailable ?? false,
    tickets: (state.frozenEvidence?.candidates ?? []).map(candidate => ({
      alias: aliases.get(candidate.ref)!,
      displayId: candidate.displayId,
    })),
    remainingGapKinds: state.gaps
      .filter(gap => gap.status === 'open' || gap.status === 'unknown')
      .map(gap => gap.kind),
    budget: compactBudget(state),
  }
}

export function compactFrozenPack(pack: FrozenEvidencePack): unknown {
  return {
    packId: pack.packId,
    retrievalId: pack.retrievalId,
    stoppingReason: pack.stoppingReason,
    complete: pack.complete,
    decisionFinalized: pack.decisionFinalized,
    topKAccepted: pack.topKAccepted,
    sourceExhausted: pack.sourceExhausted,
    resultMayBeIncomplete: pack.resultMayBeIncomplete,
    nextPageAvailable: pack.nextPageAvailable,
    selectedCount: pack.candidates.length,
    snapshot: pack.snapshot.shortId,
  }
}
