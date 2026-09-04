import type { RetrievalRankingObservation, TicketCandidate, TicketCandidateRef, TicketSearchStage } from '@retrieval-agent/contracts'

export interface CandidateRankingInputParams {
  readonly previousHistory: readonly TicketCandidate[]
  readonly previousActive: readonly TicketCandidate[]
  readonly previousObservations: readonly RetrievalRankingObservation[]
  readonly page: readonly TicketCandidate[]
  readonly searchEventId: string
  readonly stage: TicketSearchStage
  readonly queryFingerprint: string
  readonly resetEligibility: boolean
  readonly observationStart: number
}

export function updateCandidateRanking(input: CandidateRankingInputParams) {
  const seen = new Set<string>()
  const history: TicketCandidate[] = []
  for (const candidate of [...input.previousHistory, ...input.page]) {
    if (seen.has(candidate.ref)) continue
    seen.add(candidate.ref)
    history.push(candidate)
  }
  const next: RetrievalRankingObservation = {
    searchEventId: input.searchEventId,
    stage: input.stage,
    queryFingerprint: input.queryFingerprint,
    ranking: input.page.map(candidate => ({ ref: candidate.ref, rank: candidate.rank })),
  }
  const observations = [...input.previousObservations, next]
  const scores = new Map<TicketCandidateRef, number>()
  for (const observation of observations.slice(input.observationStart ?? 0)) {
    const weight = observation.stage === 'repair_search' ? 1.25 : 1
    for (const item of observation.ranking) {
      if (!history.some(candidate => candidate.ref === item.ref)) continue
      scores.set(item.ref, (scores.get(item.ref) ?? 0) + weight / (60 + item.rank))
    }
  }
  const firstSeen = new Map(history.map((candidate, index) => [candidate.ref, index]))
  // History is provenance, never evidence of current hard-condition eligibility.
  const eligible = new Map((input.resetEligibility ? [] : input.previousActive ?? input.previousHistory)
    .map(candidate => [candidate.ref, candidate]))
  for (const candidate of input.page) eligible.set(candidate.ref, candidate)
  const active = [...eligible.values()]
    .sort((left, right) => (scores.get(right.ref) ?? 0) - (scores.get(left.ref) ?? 0)
      || (firstSeen.get(left.ref) ?? 0) - (firstSeen.get(right.ref) ?? 0))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
  return { version: 'candidate-ranking-v1' as const, history, observations, active }
}
