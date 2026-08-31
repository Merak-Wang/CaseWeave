import { describe, expect, it } from 'vitest'
import {
  RetrievalId,
  RetrievalStateId,
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
      maxRounds: 8, maxSearches: 4, maxPromotions: 3, maxEvidenceTokens: 1000, maxLatencyMs: 10000,
      roundsUsed: 1, searchesUsed: 1, promotionsUsed: 0, evidenceTokensUsed: 0, latencyMs: 1,
    },
    progress: { newCandidateRefs: [], rankOverlap: 0, newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0 },
    termination,
    provenance: { rulesVersion: 'test', promptVersion: 'test', contextPolicyVersion: 'test', sourceEventIds: [] },
  }
}

describe('candidate node projection', () => {
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
      eventId: 'event-clarification', retrievalId, sequence: 1, occurredAt: '2026-08-27T00:00:01.000Z',
      type: 'retrieval/state-recorded', data: { state: awaiting },
    })

    expect(projectTicketCandidateNode([event], retrievalId)).toMatchObject({
      status: 'searching',
      message: '您要查认证类还是计费类工单？',
    })
  })
})
