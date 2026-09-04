import { describe, expect, it } from 'vitest'
import {
  RetrievalId,
  RetrievalStateId,
  TicketCandidateRef,
  TicketSnapshotId,
  makeRetrievalEvent,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { projectTicketCandidateNode } from './projection.js'

const retrievalId = RetrievalId('retrieval-ui-test')

function state(termination: RetrievalState['termination']): RetrievalState {
  return {
    retrievalId,
    stateId: RetrievalStateId('state-ui-test'),
    revision: 0,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    phase: termination === 'active' ? 'assessed' : 'stopped',
    task: { target: 'ranked_cases', requestedCount: 5, countPolicy: 'explicit', answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'top_k' },
    principalBindingHash: 'principal-hash',
    query: {
      original: '登录失败',
      spec: {
        target: 'ranked_cases', originalQuery: '登录失败', normalizedQuery: '登录失败', requestedCount: 5,
        countPolicy: 'explicit', mode: 'keyword', filters: [], ambiguities: [], excludedTerms: [], semanticHints: [], compilerVersion: 'test',
      },
      confirmedConstraints: [], unresolvedConstraints: [],
    },
    candidates: [], candidateHistory: [], rankingHistory: [], excludedCandidateRefs: [], selectedCandidateRefs: [],
    lastAssessment: undefined, promotedEvidence: [], gaps: [], allowedActions: [],
    budget: {
      maxRounds: 8, maxSearches: 4, maxLatencyMs: 10000,
      modelStepsUsed: 1, searchesUsed: 1, wallClockElapsedMs: 1,
    },
    progress: { newCandidateRefs: [], rankOverlap: 0, newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0 },
    termination,
    provenance: { rulesVersion: 'test', promptVersion: 'test', contextPolicyVersion: 'test', sourceEventIds: [] },
  }
}

describe('candidate node projection', () => {
  it('retains valid unjudged candidates separately after execution stops and never revives history', () => {
    const candidate = (ref: string) => ({
      ref: TicketCandidateRef(ref), displayId: ref, sourceVersion: 'source-v1',
      snapshotId: TicketSnapshotId('snapshot-v1'), contentHash: ref, evidenceLevel: 'L1' as const,
      rank: 1, title: ref, summary: ref, l0: {}, matchFragments: [],
    })
    const accepted = candidate('accepted')
    const waiting = candidate('undetermined')
    const excluded = candidate('excluded')
    const historical = candidate('historical')
    const stopped: RetrievalState = {
      ...state('budget_exhausted'), candidates: [accepted, waiting, excluded],
      candidateHistory: [accepted, waiting, excluded, historical],
      selectedCandidateRefs: [accepted.ref], excludedCandidateRefs: [excluded.ref],
      stopExplanation: '执行时间已到，剩余候选尚未判断。',
    }
    const event = makeRetrievalEvent({
      eventId: 'event-bounded-stop', retrievalId, sequence: 0, occurredAt: stopped.updatedAt,
      type: 'retrieval/state-recorded', data: { state: stopped },
    })
    const projected = projectTicketCandidateNode([event], retrievalId)
    expect(projected.result?.tickets.map(item => item.ref)).toEqual([accepted.ref])
    expect(projected.result?.undeterminedCandidates?.map(item => item.ref)).toEqual([waiting.ref])
    expect(projected.candidates.map(item => item.ref)).toEqual([accepted.ref, waiting.ref])
    expect(projected.message).toBe(stopped.stopExplanation)
  })

  it('projects an explicit empty result instead of fabricating candidates', () => {
    const event = makeRetrievalEvent({
      eventId: 'event-0', retrievalId, sequence: 0, occurredAt: '2026-08-27T00:00:00.000Z',
      type: 'retrieval/state-recorded', data: { state: state('no_result') },
    })
    expect(projectTicketCandidateNode([event], retrievalId)).toMatchObject({
      status: 'empty', querySummary: '登录失败', candidates: [], exportEnabled: false,
    })
  })

  it('renders an accepted structured clarification instead of model prose', () => {
    const awaiting = {
      ...state('needs_clarification'),
      phase: 'awaiting_clarification' as const,
      clarification: {
        facet: 'category',
        question: '您要查认证类还是计费类工单？',
        candidateRefs: [],
      },
    }
    const event = makeRetrievalEvent({
      eventId: 'event-clarification', retrievalId, sequence: 0, occurredAt: '2026-08-27T00:00:01.000Z',
      type: 'retrieval/state-recorded', data: { state: awaiting },
    })

    expect(projectTicketCandidateNode([event], retrievalId)).toMatchObject({
      status: 'searching',
      message: '您要查认证类还是计费类工单？',
    })
  })
})
