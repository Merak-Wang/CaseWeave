import {
  RetrievalError,
  type RetrievalActionKind,
  type RetrievalAllowedAction,
  type RetrievalBudgetState,
  type RetrievalState,
  type RetrievalTermination,
  type TicketCandidateRef,
  type TicketEvidenceField,
  type TicketL0,
} from '@retrieval-agent/contracts'

export function stopReason(error: unknown): Extract<RetrievalTermination, 'budget_exhausted' | 'permission_blocked' | 'backend_error' | 'snapshot_invalid' | 'cancelled'> | undefined {
  if (!(error instanceof RetrievalError)) return undefined
  if (error.code === 'BUDGET_EXHAUSTED') return 'budget_exhausted'
  if (error.code === 'UNAUTHORIZED') return 'permission_blocked'
  if (error.code === 'SNAPSHOT_INVALID' || error.code === 'SNAPSHOT_NOT_FOUND') return 'snapshot_invalid'
  if (error.code === 'CANCELLED') return 'cancelled'
  if (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'TIMEOUT' || error.code === 'PROTOCOL_MISMATCH') return 'backend_error'
  return undefined
}

export function emptyBudget(config: Pick<RetrievalBudgetState, 'maxRounds' | 'maxSearches' | 'maxPromotions' | 'maxEvidenceTokens' | 'maxLatencyMs'>): RetrievalBudgetState {
  return {
    ...config,
    roundsUsed: 0,
    searchesUsed: 0,
    promotionsUsed: 0,
    evidenceTokensUsed: 0,
    latencyMs: 0,
    modelStepsUsed: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    providerLatencyMs: 0,
    modelLatencyMs: 0,
    wallClockElapsedMs: 0,
    serializationBytes: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  }
}

export function snapshotEvidenceFields(state: RetrievalState): readonly TicketEvidenceField[] {
  return state.snapshot?.fieldCatalog
    .filter(field => field.accessLevel === 'L2')
    .map(field => field.key) ?? []
}

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

export function taskCompletionSatisfied(
  task: RetrievalState['task'],
  candidateCount: number,
  page: RetrievalState['lastPage'],
  assessment?: RetrievalState['lastAssessment'],
): boolean {
  void task
  void candidateCount
  void page
  return assessment?.decision === 'accept_current_top_k' || assessment?.decision === 'no_result'
}

export function coverageGaps(
  candidates: readonly TicketCandidateRef[],
  page: RetrievalState['lastPage'],
): RetrievalState['gaps'] {
  const pagesExhausted = page?.boundary?.resultPagesExhausted
    ?? (page?.completeness === 'exhaustive' && page.nextCursor === undefined)
  const semanticRecallKnown = page?.boundary?.semanticRecallKnown ?? false
  return [
    {
      kind: 'coverage',
      status: semanticRecallKnown ? 'resolved' : 'unknown',
      evidenceRefs: semanticRecallKnown ? [...candidates] : [],
      evaluator: 'system',
      description: semanticRecallKnown
        ? '语义召回边界已有外部可校准证据。'
        : 'semanticRecallKnown=false；当前结果页状态不能证明相关工单已找全。',
    },
    {
      kind: 'boundary',
      status: pagesExhausted ? 'resolved' : 'open',
      evidenceRefs: pagesExhausted ? [...candidates] : [],
      evaluator: 'system',
      description: pagesExhausted ? '当前检索表达式的结果页已到底。' : '当前检索表达式仍有后续结果页。',
    },
  ]
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

function candidateFacetValue(l0: TicketL0, facet: string): string | undefined {
  const declaredAdditionalValue = l0.additionalFields?.find(field => field.key === facet)?.value
  if (declaredAdditionalValue !== undefined) return declaredAdditionalValue

  const builtInValue = Reflect.get(l0, facet) as unknown
  return typeof builtInValue === 'string' ? builtInValue : undefined
}

export function candidateFacetValues(state: RetrievalState, facet: string, refs: readonly TicketCandidateRef[]): Set<string> {
  const values = new Set<string>()
  for (const candidate of state.candidates) {
    if (!refs.includes(candidate.ref)) continue
    const value = candidateFacetValue(candidate.l0, facet)
    if (typeof value === 'string' && value.trim().length > 0) values.add(value)
  }
  return values
}
