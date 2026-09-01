import { describe, expect, it } from 'vitest'
import {
  TicketCandidateRef,
  TicketEvidenceId,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { compactRetrievalState } from './compact.js'

describe('compact retrieval projection', () => {
  it('returns newly promoted evidence with stable aliases without leaking opaque refs', () => {
    const candidateRef = TicketCandidateRef('opaque-candidate-1')
    const evidenceId = TicketEvidenceId('opaque-evidence-1')
    const candidate = {
      ref: candidateRef, rank: 1, displayId: 'TKT-1', title: '副卡无法使用', summary: '副卡无法使用',
      sourceVersion: 'source-v1', snapshotId: 'snapshot-1', contentHash: 'hash-1', evidenceLevel: 'L1',
      l0: {}, matchFragments: [],
    }
    const state = {
      retrievalId: 'retrieval-1', stateId: 'state-2', revision: 2, phase: 'assessed', termination: 'active',
      task: { target: 'ranked_cases', completenessRequirement: 'top_k' },
      query: { spec: { normalizedQuery: '副卡' }, contract: { resultPolicy: 'adaptive_top_k' } },
      candidates: [candidate], candidateHistory: [candidate], selectedCandidateRefs: [], excludedCandidateRefs: [],
      promotedEvidence: [{
        evidenceId, candidateRef, displayId: 'TKT-1', sourceVersion: 'source-v1', contentHash: 'hash-1',
        field: 'problemDescription', text: '副卡解绑后仍共享流量。', start: 0, end: 11, estimatedTokens: 11,
        trust: 'untrusted_ticket_evidence', truncated: false,
      }],
      gaps: [], allowedActions: [],
      progress: {
        newCandidateRefs: [], newEvidenceIds: [evidenceId], rankOverlap: 1, newDecisiveEvidence: true,
        resolvedGaps: [], noProgressStreak: 0,
      },
      budget: {
        maxRounds: 8, maxSearches: 4, maxPromotions: 3, maxEvidenceTokens: 1_500, maxLatencyMs: 120_000,
        roundsUsed: 1, searchesUsed: 1, promotionsUsed: 1, evidenceTokensUsed: 11, latencyMs: 10,
      },
    } as unknown as RetrievalState

    const compact = compactRetrievalState(state)
    expect(compact).toMatchObject({
      candidateDelta: [],
      evidenceDelta: [{
        alias: 'e1', candidateAlias: 'c1', field: 'problemDescription',
        text: '副卡解绑后仍共享流量。', trust: 'untrusted_ticket_evidence', truncated: false,
      }],
    })
    expect(JSON.stringify(compact)).not.toContain(String(candidateRef))
    expect(JSON.stringify(compact)).not.toContain(String(evidenceId))
  })
})
