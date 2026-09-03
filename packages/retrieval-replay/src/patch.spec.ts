import { describe, expect, it } from 'vitest'
import {
  RetrievalId,
  RetrievalStateId,
  TicketCandidateRef,
  makeRetrievalEvent,
  type RetrievalState,
  type TicketCandidate,
} from '@retrieval-agent/contracts'
import { applyRetrievalStatePatch, createRetrievalStatePatch } from './patch.js'
import { foldRetrievalEvents } from './replay.js'

const retrievalId = RetrievalId('retrieval-linear-session')

function candidate(index: number): TicketCandidate {
  return {
    ref: TicketCandidateRef(`candidate-${index}`),
    displayId: `TKT-${String(index).padStart(5, '0')}`,
    sourceVersion: 'source-v1',
    snapshotId: 'snapshot-linear',
    contentHash: `hash-${index}`,
    evidenceLevel: 'L2',
    rank: index,
    title: `工单 ${index}`,
    summary: `工单 ${index} 摘要`,
    l0: {},
    matchFragments: [],
  } as unknown as TicketCandidate
}

function state(revision: number, candidates: readonly TicketCandidate[], previous?: RetrievalState): RetrievalState {
  const stateId = RetrievalStateId(`state-${revision}`)
  const refs = candidates.map(item => item.ref)
  return {
    retrievalId,
    stateId,
    ...(previous === undefined ? {} : { previousStateId: previous.stateId }),
    revision,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: new Date(Date.parse('2026-09-02T00:00:00.000Z') + revision * 1_000).toISOString(),
    phase: 'assessed',
    task: { target: 'cohort_collection', countPolicy: 'exhaustive', answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'exhaustive' },
    principalBindingHash: 'principal-binding',
    query: {
      original: '主卡工单',
      spec: {
        target: 'cohort_collection', originalQuery: '主卡工单', normalizedQuery: '主卡工单', countPolicy: 'exhaustive',
        mode: 'hybrid', filters: [], ambiguities: [], excludedTerms: [], semanticHints: [], compilerVersion: 'test',
      },
      confirmedConstraints: [], unresolvedConstraints: [],
    },
    candidates: [...candidates],
    candidateHistory: [...candidates],
    rankingHistory: revision === 0 ? [] : [{
      searchEventId: `search-${revision}`, stage: revision === 1 ? 'initial_hybrid' : 'next_page',
      queryFingerprint: 'query-1', ranking: candidates.slice(-20).map(item => ({ ref: item.ref, rank: item.rank })),
    }],
    excludedCandidateRefs: [], selectedCandidateRefs: [], promotedEvidence: [], gaps: [],
    allowedActions: [{ kind: 'assess', candidateAllowlist: refs, fieldAllowlist: [], maxTokens: 0 }],
    budget: {
      maxRounds: 8, maxSearches: 2_500, maxPromotions: 3, maxEvidenceTokens: 1_500, maxLatencyMs: 120_000,
      roundsUsed: 0, searchesUsed: revision, promotionsUsed: 0, evidenceTokensUsed: 0, latencyMs: revision,
    },
    progress: { newCandidateRefs: refs.slice(-20), rankOverlap: 1, newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0 },
    termination: 'active',
    provenance: { rulesVersion: 'test', promptVersion: 'test', contextPolicyVersion: 'test', sourceEventIds: [`search-${revision}`] },
  }
}

describe('incremental retrieval state replay', () => {
  it('round-trips state patches and keeps serialized paging writes linear', () => {
    let current = state(0, [])
    let patchBytes = 0
    let cumulativeSnapshotBytes = Buffer.byteLength(JSON.stringify(current), 'utf8')
    const events: ReturnType<typeof makeRetrievalEvent>[] = [makeRetrievalEvent({
      eventId: 'state-0', retrievalId, sequence: 0, occurredAt: current.updatedAt,
      type: 'retrieval/state-recorded', data: { state: current },
    })]

    for (let revision = 1; revision <= 100; revision += 1) {
      const nextCandidates = Array.from({ length: revision * 20 }, (_, index) => candidate(index + 1))
      const next = state(revision, nextCandidates, current)
      const patch = createRetrievalStatePatch(current, next)
      patchBytes += Buffer.byteLength(JSON.stringify(patch), 'utf8')
      cumulativeSnapshotBytes += Buffer.byteLength(JSON.stringify(next), 'utf8')
      expect(applyRetrievalStatePatch(current, patch)).toEqual(next)
      events.push(makeRetrievalEvent({
        eventId: `state-${revision}`, retrievalId, sequence: revision, occurredAt: next.updatedAt,
        type: 'retrieval/state-patched', data: { patch },
      }))
      current = next
    }

    expect(foldRetrievalEvents(events, retrievalId)).toEqual(current)
    expect(patchBytes).toBeLessThan(cumulativeSnapshotBytes / 10)
    expect(patchBytes).toBeLessThan(4_000_000)
  })

  it('rejects a patch whose declared base is not the replayed state', () => {
    const first = state(0, [])
    const next = state(1, Array.from({ length: 20 }, (_, index) => candidate(index + 1)), first)
    const patch = { ...createRetrievalStatePatch(first, next), fromRevision: 9 }
    expect(() => applyRetrievalStatePatch(first, patch)).toThrow(/revision/u)
  })
})
