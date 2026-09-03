import type {
  ConversationMatch,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  RETRIEVAL_PRESENTATION_EVENT_TYPE,
  RetrievalId,
  RetrievalStateId,
  makeRetrievalEvent,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { describe, expect, it } from 'vitest'
import { ticketCandidateDefinition } from './definition.js'

const retrievalId = RetrievalId('retrieval-anchor-test')
const timestamp = '2026-08-28T00:00:00.000Z'

const contracted = makeRetrievalEvent({
  eventId: 'contracted',
  retrievalId,
  sequence: 0,
  occurredAt: timestamp,
  type: 'retrieval/query-contracted',
  data: {
    contract: {
      target: 'ranked_cases',
      requestedCount: 5,
      countPolicy: 'explicit',
      answerabilityPolicy: 'current_snapshot_evidence_only',
      completenessRequirement: 'top_k',
    },
    queryContract: {
      schemaVersion: 3,
      original: '副卡解绑后仍共享流量',
      normalized: '副卡解绑后仍共享流量',
      task: 'ranked_cases',
      resultPolicy: 'explicit_top_k',
      maxResults: 5,
      domain: 'telecom_ticket',
      language: 'zh',
      entities: [{ type: 'business_object', surface: '副卡', canonical: '副卡' }],
      constraints: [],
      ambiguities: [],
      interpretationBasis: 'deterministic_syntax',
      compilerVersion: 'test',
    },
    spec: {
      target: 'ranked_cases',
      originalQuery: '副卡解绑后仍共享流量',
      normalizedQuery: '副卡解绑后仍共享流量',
      requestedCount: 5,
      countPolicy: 'explicit',
      mode: 'hybrid',
      filters: [],
      ambiguities: [],
      excludedTerms: [],
      semanticHints: [],
      compilerVersion: 'test',
    },
  },
})

const stoppedState: RetrievalState = {
  retrievalId,
  stateId: RetrievalStateId('state-stopped'),
  revision: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  phase: 'stopped',
  task: contracted.data.contract,
  principalBindingHash: 'principal',
  query: {
    original: contracted.data.spec.originalQuery,
    spec: contracted.data.spec,
    confirmedConstraints: [],
    unresolvedConstraints: [],
  },
  candidates: [],
  candidateHistory: [],
  rankingHistory: [],
  excludedCandidateRefs: [],
  selectedCandidateRefs: [],
  lastAssessment: undefined,
  promotedEvidence: [],
  gaps: [],
  allowedActions: [],
  budget: {
    maxRounds: 8,
    maxSearches: 4,
    maxPromotions: 3,
    maxEvidenceTokens: 1500,
    maxLatencyMs: 120000,
    roundsUsed: 1,
    searchesUsed: 1,
    promotionsUsed: 0,
    evidenceTokensUsed: 0,
    latencyMs: 10,
  },
  progress: {
    newCandidateRefs: [],
    rankOverlap: 0,
    newDecisiveEvidence: false,
    resolvedGaps: [],
    noProgressStreak: 0,
  },
  termination: 'no_result',
  provenance: {
    rulesVersion: 'test',
    promptVersion: 'test',
    contextPolicyVersion: 'test',
    sourceEventIds: [],
  },
}

const stopped = makeRetrievalEvent({
  eventId: 'state-recorded',
  retrievalId,
  sequence: 1,
  occurredAt: timestamp,
  type: 'retrieval/state-recorded',
  data: { state: stoppedState },
})

function match(seq: number, event: typeof contracted | typeof stopped, role: 'start' | 'update'): ConversationMatch {
  return {
    event: { seq, time: 0, type: event.type, data: { event } } as ConversationMatch['event'],
    view: undefined,
    role,
    location: { kind: 'session' },
  }
}

function anchorMatch(seq: number, phase: 'candidates' | 'result'): ConversationMatch {
  return {
    event: {
      seq,
      time: 0,
      type: RETRIEVAL_PRESENTATION_EVENT_TYPE,
      data: { retrievalId, phase, turn: 1, ...(phase === 'candidates' ? { step: 1 } : {}) },
    } as ConversationMatch['event'],
    view: undefined,
    role: 'update',
    location: { kind: 'session' },
  }
}

describe('ticket candidate conversation placement', () => {
  it('publishes candidates after the query and the terminal collection after every tool row', () => {
    const start = match(6, contracted, 'start')
    const terminal = match(42, stopped, 'update')
    const candidatesAnchor = anchorMatch(15, 'candidates')
    const resultAnchor = anchorMatch(60, 'result')
    const initialState = ticketCandidateDefinition.start(
      {} as Parameters<typeof ticketCandidateDefinition.start>[0],
      start,
      { previous: () => undefined },
    )
    const initialNode = ticketCandidateDefinition.buildViewNode?.({
      key: 'ticket-candidates:retrieval-anchor-test',
      kind: 'ticket-candidates',
      id: retrievalId,
      matches: [start],
      start,
      state: initialState,
      current: new Map(),
    })
    expect(initialNode).toBeNull()

    const candidateState = ticketCandidateDefinition.update({
      key: 'ticket-candidates:retrieval-anchor-test',
      kind: 'ticket-candidates',
      id: retrievalId,
      matches: [start],
      start,
      state: initialState,
      current: new Map(),
    }, candidatesAnchor)
    const candidateNode = ticketCandidateDefinition.buildViewNode?.({
      key: 'ticket-candidates:retrieval-anchor-test',
      kind: 'ticket-candidates',
      id: retrievalId,
      matches: [start, candidatesAnchor],
      start,
      state: candidateState,
      current: new Map(),
    })
    expect(candidateNode).toMatchObject({
      anchorSeq: 15,
      data: { querySummary: '副卡解绑后仍共享流量' },
    })

    const state = ticketCandidateDefinition.update({
      key: 'ticket-candidates:retrieval-anchor-test',
      kind: 'ticket-candidates',
      id: retrievalId,
      matches: [start, candidatesAnchor],
      start,
      state: candidateState,
      current: new Map(),
    }, terminal)
    const hiddenTerminalNode = ticketCandidateDefinition.buildViewNode?.({
      key: 'ticket-candidates:retrieval-anchor-test',
      kind: 'ticket-candidates',
      id: retrievalId,
      matches: [start, candidatesAnchor, terminal],
      start,
      state,
      current: new Map(),
    })
    expect(hiddenTerminalNode).toBeNull()

    const anchoredState = ticketCandidateDefinition.update({
      key: 'ticket-candidates:retrieval-anchor-test',
      kind: 'ticket-candidates',
      id: retrievalId,
      matches: [start, candidatesAnchor, terminal],
      start,
      state,
      current: new Map(),
    }, resultAnchor)
    const node = ticketCandidateDefinition.buildViewNode?.({
      key: 'ticket-candidates:retrieval-anchor-test',
      kind: 'ticket-candidates',
      id: retrievalId,
      matches: [start, candidatesAnchor, terminal, resultAnchor],
      start,
      state: anchoredState,
      current: new Map(),
    })

    expect(node).toMatchObject({
      anchorSeq: 60,
      location: { kind: 'session' },
      data: { result: { type: 'ticket_collection', stoppingReason: 'no_result' } },
    })
  })
})
