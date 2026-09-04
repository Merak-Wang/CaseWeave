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

function compactBudget(state: RetrievalState) {
  return {
    modelStepsUsed: state.budget.modelStepsUsed,
    successfulToolCalls: state.budget.successfulToolCalls ?? 0,
    failedToolCalls: state.budget.failedToolCalls ?? 0,
    providerSearches: state.budget.searchesUsed,
    wallClockElapsedMs: state.budget.wallClockElapsedMs,
    modelLatencyMs: state.budget.modelLatencyMs ?? 0,
    providerLatencyMs: state.budget.providerLatencyMs ?? 0,
    totalInputTokens: state.budget.totalInputTokens ?? 0,
    totalOutputTokens: state.budget.totalOutputTokens ?? 0,
    serializationBytes: state.budget.serializationBytes ?? 0,
  }
}

/** Compact terminal receipt; full collection is projected from durable state for UI/export. */
export function compactTerminalReceipt(state: RetrievalState): unknown {
  if (state.phase !== 'stopped') throw new Error('Terminal receipt requires a stopped retrieval')
  return {
    type: 'ticket_collection',
    schemaVersion: 4,
    retrievalId: state.retrievalId,
    packId: state.frozenEvidence?.packId,
    stoppingReason: state.termination,
    decisionFinalized: true,
    complete: state.frozenEvidence?.complete ?? false,
    topKAccepted: state.frozenEvidence?.topKAccepted ?? false,
    resultPagesExhausted: state.frozenEvidence?.resultPagesExhausted ?? false,
    semanticRecallKnown: state.frozenEvidence?.semanticRecallKnown ?? false,
    resultMayBeIncomplete: state.frozenEvidence?.resultMayBeIncomplete ?? true,
    nextPageAvailable: state.frozenEvidence?.nextPageAvailable ?? false,
    selectedCount: state.frozenEvidence?.candidates.length ?? 0,
    undeterminedCount: state.candidates.filter(candidate => !state.selectedCandidateRefs.includes(candidate.ref) && !state.excludedCandidateRefs.includes(candidate.ref)).length,
    explanation: state.stopExplanation,
    remainingGapKinds: state.gaps
      .filter(gap => gap.status === 'open' || gap.status === 'unknown')
      .map(gap => gap.kind),
    budget: compactBudget(state),
  }
}
