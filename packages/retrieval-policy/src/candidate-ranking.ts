import type {
  RetrievalRankingObservation,
  TicketCandidate,
  TicketCandidateRef,
  TicketSearchStage,
} from '@retrieval-agent/contracts'

export interface CandidateRankingUpdate {
  readonly history: readonly TicketCandidate[]
  readonly observations: readonly RetrievalRankingObservation[]
  readonly active: readonly TicketCandidate[]
}
function uniqueCandidateHistory(
  previous: readonly TicketCandidate[],
  page: readonly TicketCandidate[],
): TicketCandidate[] {
  const seen = new Set<string>()
  const history: TicketCandidate[] = []
  for (const candidate of [...previous, ...page]) {
    if (seen.has(candidate.ref)) continue
    seen.add(candidate.ref)
    history.push(candidate)
  }
  return history
}

function observationWeight(stage: TicketSearchStage): number {
  // A deliberate query repair may correct a weak first pass, while continued
  // pages preserve their provider-issued global rank.
  return stage === 'repair_search' ? 1.25 : 1
}

function sameObservation(
  left: RetrievalRankingObservation,
  right: RetrievalRankingObservation,
): boolean {
  return left.queryFingerprint === right.queryFingerprint
    && left.stage === right.stage
    && left.ranking.length === right.ranking.length
    && left.ranking.every((item, index) => item.ref === right.ranking[index]?.ref && item.rank === right.ranking[index]?.rank)
}

/**
 * Keep acquisition history immutable while deriving a revisable active rank
 * with rank-based fusion across otherwise incomparable search channels.
 */
export function updateCandidateRanking(input: {
  readonly previousHistory: readonly TicketCandidate[]
  readonly previousObservations: readonly RetrievalRankingObservation[]
  readonly page: readonly TicketCandidate[]
  readonly searchEventId: string
  readonly stage: TicketSearchStage
  readonly queryFingerprint: string
  readonly excludedRefs: readonly TicketCandidateRef[]
}): CandidateRankingUpdate {
  const history = uniqueCandidateHistory(input.previousHistory, input.page)
  const nextObservation: RetrievalRankingObservation = {
    searchEventId: input.searchEventId,
    stage: input.stage,
    queryFingerprint: input.queryFingerprint,
    ranking: input.page.map(candidate => ({ ref: candidate.ref, rank: candidate.rank })),
  }
  const observations = input.previousObservations.some(item => sameObservation(item, nextObservation))
    ? [...input.previousObservations]
    : [...input.previousObservations, nextObservation]
  const scores = new Map<TicketCandidateRef, number>()
  for (const observation of observations) {
    const weight = observationWeight(observation.stage)
    for (const item of observation.ranking) {
      if (!history.some(candidate => candidate.ref === item.ref)) continue
      scores.set(item.ref, (scores.get(item.ref) ?? 0) + weight / (60 + item.rank))
    }
  }
  const excluded = new Set(input.excludedRefs)
  const firstSeen = new Map(history.map((candidate, index) => [candidate.ref, index]))
  const active = history
    .filter(candidate => !excluded.has(candidate.ref))
    .sort((left, right) => (scores.get(right.ref) ?? 0) - (scores.get(left.ref) ?? 0)
      || (firstSeen.get(left.ref) ?? 0) - (firstSeen.get(right.ref) ?? 0))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
  return { history, observations, active }
}
