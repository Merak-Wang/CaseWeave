import { RetrievalError, type RetrievalState, type TicketCandidate, type TicketEvidenceSegment } from '@retrieval-agent/contracts'

/** Upgrade by field meaning and provenance. Legacy labels never establish full-detail or role visibility. */
export function migrateProjectionState(state: RetrievalState): RetrievalState {
  if (state.projectionVersion === 2) return state
  const candidate = (c: TicketCandidate): TicketCandidate => ({ ...c, projectionVersion: 2,
    summaryOrigin: c.summaryOrigin ?? { kind: 'unknown' }, titleOrigin: c.titleOrigin ?? { kind: 'unknown' } })
  return { ...state, projectionVersion: 2, inputGeneration: state.inputGeneration ?? 0,
    candidates: state.candidates.map(candidate), candidateHistory: state.candidateHistory.map(candidate),
    promotedEvidence: state.promotedEvidence.map(e => {
      const field = state.snapshot?.fieldCatalog.find(f => f.key === e.field)
      if (field?.valueKind === 'raw_json') throw new RetrievalError('PROTOCOL_MISMATCH', '历史 raw 字段不能通过层级重命名进入受控详情。')
      return { ...e, projectionVersion: 2, projectionLevel: ['title', 'summary'].includes(e.field) ? 'L1' : 'L2',
        origin: e.origin ?? { kind: 'unknown' } }
    }), contextManifests: state.contextManifests ?? [], expertTasks: state.expertTasks ?? [], expertConflicts: state.expertConflicts ?? [] }
}

/** The only compatibility boundary for pre-v12 evidence meanings and unused budgets. */
export function migrateLegacyRetrievalState(state: RetrievalState): RetrievalState {
  const legacyBudget = state.budget as unknown as Record<string, unknown>
  const { maxPromotions: _maxPromotions, maxEvidenceTokens: _maxEvidenceTokens,
    promotionsUsed: _promotionsUsed, evidenceTokensUsed: _evidenceTokensUsed,
    roundsUsed: _roundsUsed, latencyMs: _latencyMs,
    maxRounds: _maxRounds, maxLatencyMs: _maxLatencyMs, ...retained } = legacyBudget
  const modelStepsUsed = legacyBudget.modelStepsUsed ?? legacyBudget.roundsUsed
  const wallClockElapsedMs = legacyBudget.wallClockElapsedMs ?? legacyBudget.latencyMs
  if (typeof modelStepsUsed !== 'number' || typeof wallClockElapsedMs !== 'number') {
    throw new RetrievalError('PROTOCOL_MISMATCH', '历史状态缺少可迁移的模型步数或执行时间。')
  }
  const evidence: TicketEvidenceSegment[] = state.promotedEvidence.map(item => {
    const descriptor = state.snapshot?.fieldCatalog.find(field => field.key === item.field)
    if (descriptor?.valueKind === 'raw_json' || descriptor?.accessLevel === 'L3'
      || descriptor?.accessLevel !== 'L2' || typeof item.text !== 'string') {
      throw new RetrievalError('PROTOCOL_MISMATCH', `历史证据字段 ${item.field} 无法安全迁移为受控正文；需要重新授权读取。`)
    }
    return { ...item, evidenceLevel: ['title', 'summary'].includes(item.field) ? 'L1' : 'L2', readers: ['provider'] }
  })
  const candidates: TicketCandidate[] = state.candidates.map(candidate => ({ ...candidate,
    evidenceLevel: evidence.some(item => item.candidateRef === candidate.ref && item.evidenceLevel === 'L2') ? 'L2' : 'L1' }))
  const { lastAssessment: _lastAssessment, ...rest } = state
  return {
    ...rest,
    budget: { ...retained, modelStepsUsed, wallClockElapsedMs } as unknown as RetrievalState['budget'],
    candidates,
    candidateHistory: state.candidateHistory.map(candidate => ({ ...candidate, evidenceLevel: 'L1' })),
    promotedEvidence: evidence,
    // Previous all-selection protocols did not establish per-candidate model visibility.
    judgments: [], selectedCandidateRefs: [], excludedCandidateRefs: [], modelVisibleCandidateRefs: [], modelVisibleEvidenceIds: [],
    accessValidation: 'required', executionClock: { totalWaitingMs: 0 },
    ...(state.phase === 'stopped' && state.frozenEvidence !== undefined ? {
      termination: 'partial' as const,
      stopExplanation: '历史记录的候选判断缺少逐项可见证据，重新授权后作为待判定候选呈现。',
      frozenEvidence: { ...state.frozenEvidence, candidates: [], stoppingReason: 'partial' as const,
        complete: false, topKAccepted: false, resultMayBeIncomplete: true,
        budget: { ...retained, modelStepsUsed, wallClockElapsedMs } as unknown as RetrievalState['budget'] },
    } : {}),
  }
}
