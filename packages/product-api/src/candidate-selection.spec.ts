import { describe, expect, it } from 'vitest'
import {
  RetrievalId,
  TicketCandidateRef,
  TicketSnapshotId,
  type RetrievalState,
  type TicketCandidate,
} from '@retrieval-agent/contracts'
import { hostAuthorizedCandidates } from './candidate-selection.js'

function candidate(ref: string, displayId: string): TicketCandidate {
  return {
    ref: TicketCandidateRef(ref),
    displayId,
    sourceVersion: 'source-v1',
    snapshotId: TicketSnapshotId('snapshot-v1'),
    contentHash: `hash-${ref}`,
    evidenceLevel: 'L2',
    rank: 1,
    title: displayId,
    summary: `${displayId} 摘要`,
    l0: {},
    matchFragments: [],
  }
}

describe('Host candidate allowlist', () => {
  it('rejects a candidate excluded from the frozen terminal collection', () => {
    const selected = candidate('candidate-selected', 'TKT-SELECTED')
    const excluded = candidate('candidate-excluded', 'TKT-EXCLUDED')
    const state = {
      retrievalId: RetrievalId('retrieval-frozen'),
      phase: 'stopped',
      candidates: [selected],
      candidateHistory: [selected, excluded],
      frozenEvidence: { candidates: [{ ref: selected.ref }] },
    } as unknown as RetrievalState

    expect(hostAuthorizedCandidates(state, [selected.ref])).toEqual([selected])
    expect(() => hostAuthorizedCandidates(state, [excluded.ref]))
      .toThrow(/当前可见工单集合/u)
  })
})
