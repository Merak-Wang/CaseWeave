import { describe, expect, it } from 'vitest'
import {
  RetrievalId,
  RetrievalStateId,
  TicketCandidateRef,
  TicketEvidenceId,
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
      maxSearches: 2_500,
      modelStepsUsed: 0, searchesUsed: revision, wallClockElapsedMs: revision,
    },
    progress: { newCandidateRefs: refs.slice(-20), rankOverlap: 1, newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0 },
    termination: 'active',
    provenance: { rulesVersion: 'test', promptVersion: 'test', contextPolicyVersion: 'test', sourceEventIds: [`search-${revision}`] },
  }
}

describe('incremental retrieval state replay', () => {
  it('migrates a v12 projection by field meaning without inventing structured feedback or field provenance', () => {
    const old = { ...state(0, [candidate(1)]), snapshot: { fieldCatalog: [
      { key: 'summary', valueKind: 'text', accessLevel: 'L2' },
      { key: 'problemDescription', valueKind: 'text', accessLevel: 'L2' },
      { key: 'raw', valueKind: 'raw_json', accessLevel: 'L3' },
    ] }, promotedEvidence: ['summary', 'problemDescription'].map(field => ({
      evidenceId: TicketEvidenceId(field), candidateRef: candidate(1).ref, field, text: '历史原文', evidenceLevel: 'L2',
    })) } as unknown as RetrievalState
    const event = { ...makeRetrievalEvent({ eventId: 'v12', retrievalId, sequence: 0, occurredAt: old.updatedAt,
      type: 'retrieval/state-recorded', data: { state: old } }), schemaVersion: 12 as const }
    const migrated = foldRetrievalEvents([event])!
    expect(migrated).toMatchObject({ projectionVersion: 2, inputGeneration: 0, contextManifests: [], expertTasks: [],
      promotedEvidence: [{ projectionLevel: 'L1', origin: { kind: 'unknown' } }, { projectionLevel: 'L2', origin: { kind: 'unknown' } }],
      candidates: [{ summaryOrigin: { kind: 'unknown' }, titleOrigin: { kind: 'unknown' } }] })
    expect(migrated).not.toHaveProperty('feedback')
    expect(() => foldRetrievalEvents([{ ...event, data: { state: { ...old, promotedEvidence: [{ ...old.promotedEvidence[0]!, field: 'raw' }] } } }])).toThrow(/raw/)
    expect(foldRetrievalEvents([{ ...event, schemaVersion: 13, data: { state: migrated } }])).toEqual(migrated)
  })
  it('round-trips incremental state through multiple pages', () => {
    // The default checks correctness; opt in to the original 100-page scale workload.
    const scale = process.env.RETRIEVAL_AGENT_REPLAY_SCALE === '1'
    let current = state(0, [])
    let patchBytes = 0
    let cumulativeSnapshotBytes = Buffer.byteLength(JSON.stringify(current), 'utf8')
    const events: ReturnType<typeof makeRetrievalEvent>[] = [makeRetrievalEvent({
      eventId: 'state-0', retrievalId, sequence: 0, occurredAt: current.updatedAt,
      type: 'retrieval/state-recorded', data: { state: current },
    })]

    for (let revision = 1; revision <= (scale ? 100 : 4); revision += 1) {
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
    if (scale) {
      expect(patchBytes).toBeLessThan(cumulativeSnapshotBytes / 10)
      expect(patchBytes).toBeLessThan(4_000_000)
    }
  }, process.env.RETRIEVAL_AGENT_REPLAY_SCALE === '1' ? 30_000 : 5_000)

  it('rejects a patch whose declared base is not the replayed state', () => {
    const first = state(0, [])
    const next = state(1, Array.from({ length: 20 }, (_, index) => candidate(index + 1)), first)
    const patch = { ...createRetrievalStatePatch(first, next), fromRevision: 9 }
    expect(() => applyRetrievalStatePatch(first, patch)).toThrow(/revision/u)
  })
  it('migrates field meaning and old counters before a current Session continuation without inheriting access', () => {
    const base = state(0, [candidate(1)])
    const legacy = {
      ...base,
      snapshot: { fieldCatalog: [
        { key: 'summary', accessLevel: 'L2', valueKind: 'text' },
        { key: 'source.raw', accessLevel: 'L3', valueKind: 'raw_json' },
      ] },
      selectedCandidateRefs: [candidate(1).ref],
      promotedEvidence: [{ evidenceId: TicketEvidenceId('old-summary'), candidateRef: candidate(1).ref,
        displayId: 'TKT-00001', sourceVersion: 'source-v1', contentHash: 'hash-1', field: 'summary',
        text: '工单摘要', start: 0, end: 4, estimatedTokens: 4, trust: 'untrusted_ticket_evidence', truncated: false }],
      budget: { maxRounds: 8, maxSearches: 100, maxLatencyMs: 1000, roundsUsed: 2, searchesUsed: 1,
        latencyMs: 13, maxPromotions: 3, maxEvidenceTokens: 1500, promotionsUsed: 1, evidenceTokensUsed: 4 },
    } as unknown as RetrievalState
    const checkpoint = { ...makeRetrievalEvent({ eventId: 'old-state', retrievalId, sequence: 0,
      occurredAt: base.updatedAt, type: 'retrieval/state-recorded', data: { state: legacy } }), schemaVersion: 11 as const }
    const restored = foldRetrievalEvents([checkpoint], retrievalId)!
    expect(restored).toMatchObject({ accessValidation: 'required', selectedCandidateRefs: [],
      candidates: [{ evidenceLevel: 'L1' }], promotedEvidence: [{ field: 'summary', evidenceLevel: 'L1', readers: ['provider'] }],
      budget: { modelStepsUsed: 2, wallClockElapsedMs: 13 } })
    expect(restored.budget).not.toHaveProperty('maxPromotions')
    const resumed: RetrievalState = { ...restored, stateId: RetrievalStateId('resumed'), previousStateId: restored.stateId,
      revision: 1, accessValidation: 'current' }
    const continuation = makeRetrievalEvent({ eventId: 'resumed-state', retrievalId, sequence: 1, occurredAt: resumed.updatedAt,
      type: 'retrieval/state-patched', data: { patch: createRetrievalStatePatch(restored, resumed) } })
    expect(foldRetrievalEvents([checkpoint, continuation], retrievalId)).toEqual(resumed)
    const rawCheckpoint = { ...checkpoint, data: { state: { ...legacy, promotedEvidence: legacy.promotedEvidence.map(item => ({ ...item, field: 'source.raw' })) } } }
    expect(() => foldRetrievalEvents([rawCheckpoint], retrievalId)).toThrow(/无法安全迁移为受控正文/u)
  })

})
