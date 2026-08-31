import { describe, expect, it } from 'vitest'
import {
  TicketCandidateRef,
  TicketSnapshotId,
  type TicketCandidate,
} from '@retrieval-agent/contracts'
import { updateCandidateRanking } from './candidate-ranking.js'

const SNAPSHOT = TicketSnapshotId('snapshot-ranking')
const A = TicketCandidateRef('candidate-a')
const B = TicketCandidateRef('candidate-b')
const C = TicketCandidateRef('candidate-c')

function candidate(ref: typeof A, rank: number): TicketCandidate {
  return {
    ref,
    displayId: ref,
    sourceVersion: 'source-v1',
    snapshotId: SNAPSHOT,
    contentHash: `hash-${ref}`,
    evidenceLevel: 'L1',
    rank,
    title: ref,
    summary: ref,
    l0: {},
    matchFragments: [],
  }
}

describe('candidate ranking', () => {
  it('separates immutable acquisition history from a ranking revised by later search evidence', () => {
    const first = updateCandidateRanking({
      previousHistory: [], previousObservations: [],
      page: [candidate(A, 1), candidate(B, 2)],
      searchEventId: 'search-initial', stage: 'initial_hybrid', queryFingerprint: 'query-initial',
      excludedRefs: [],
    })
    const repaired = updateCandidateRanking({
      previousHistory: first.history, previousObservations: first.observations,
      page: [candidate(C, 1), candidate(B, 2)],
      searchEventId: 'search-repair', stage: 'repair_search', queryFingerprint: 'query-repair',
      excludedRefs: [],
    })

    expect(repaired.history.map(item => item.ref)).toEqual([A, B, C])
    expect(repaired.active.map(item => item.ref)).toEqual([B, C, A])
    expect(repaired.active.map(item => item.rank)).toEqual([1, 2, 3])
  })

  it('keeps an assessed exclusion in history but removes it from the active ranking', () => {
    const result = updateCandidateRanking({
      previousHistory: [candidate(A, 1), candidate(B, 2)],
      previousObservations: [],
      page: [candidate(C, 1), candidate(B, 2)],
      searchEventId: 'search-repair', stage: 'repair_search', queryFingerprint: 'query-repair',
      excludedRefs: [B],
    })

    expect(result.history.map(item => item.ref)).toEqual([A, B, C])
    expect(result.active.map(item => item.ref)).toEqual([C, A])
  })
})
