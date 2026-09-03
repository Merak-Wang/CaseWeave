import { describe, expect, it } from 'vitest'
import { TicketCandidateRef, type RetrievalState } from '@retrieval-agent/contracts'
import { EvidenceContextPolicy } from './context.js'

function stateWithFieldCatalog(): RetrievalState {
  return {
    retrievalId: 'retrieval-filter-capabilities',
    stateId: 'state-filter-capabilities',
    revision: 1,
    phase: 'assessed',
    termination: 'active',
    task: {
      target: 'constrained_list', countPolicy: 'exhaustive',
      answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'exhaustive',
    },
    query: {
      original: '最近两个月华东地区已解决的工单',
      spec: { normalizedQuery: '工单' },
    },
    snapshot: {
      shortId: 'snap-1',
      sourceVersion: 'source-v1',
      authorizationVersion: 'auth-v1',
      fieldCatalog: [
        { key: 'status', label: '状态', valueKind: 'keyword', accessLevel: 'L0', filterOperators: ['eq', 'neq'], sensitivity: 'non_sensitive' },
        { key: 'createdAt', label: '创建时间', valueKind: 'datetime', accessLevel: 'L0', filterOperators: ['gte', 'lte'], sensitivity: 'non_sensitive' },
        { key: 'summary', label: '摘要', valueKind: 'text', accessLevel: 'L2', filterOperators: [], sensitivity: 'source_controlled' },
      ],
    },
    candidates: [],
    candidateHistory: [],
    rankingHistory: [],
    excludedCandidateRefs: [],
    selectedCandidateRefs: [],
    promotedEvidence: [],
    gaps: [],
    allowedActions: [
      { kind: 'repair_search', candidateAllowlist: [], fieldAllowlist: [], maxTokens: 0 },
    ],
    budget: {
      maxRounds: 8, maxSearches: 4, maxPromotions: 3, maxEvidenceTokens: 1_500, maxLatencyMs: 120_000,
      roundsUsed: 1, searchesUsed: 1, promotionsUsed: 0, evidenceTokensUsed: 0, latencyMs: 0,
    },
    progress: {
      newCandidateRefs: [], newEvidenceIds: [], rankOverlap: 1,
      newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0,
    },
  } as unknown as RetrievalState
}

describe('EvidenceContextPolicy', () => {
  it('exposes only currently declared filterable L0 field capabilities to the model', () => {
    const context = new EvidenceContextPolicy({ estimateTokens: () => 1 }).select(stateWithFieldCatalog(), 100)

    expect(context.rendered).toContain('"filterCapabilities"')
    expect(context.rendered).toContain('"field":"status"')
    expect(context.rendered).toContain('"operators":["eq","neq"]')
    expect(context.rendered).toContain('"field":"createdAt"')
    expect(context.rendered).toContain('"operators":["gte","lte"]')
    expect(context.rendered).not.toContain('"field":"summary"')
  })

  it('uses structural candidate bounds without inventing a model-independent token cap', () => {
    const state = stateWithFieldCatalog()
    const candidateRef = TicketCandidateRef('candidate-context-1')
    const withCandidate = {
      ...state,
      candidates: [{
        ref: candidateRef, displayId: 'TKT-1', rank: 1, title: '主卡无法登录', summary: '主卡登录后提示账号状态异常。',
        l0: {}, matchSignals: { channels: ['keyword'], keywordTerms: ['主卡'] },
      }],
      candidateHistory: [{ ref: candidateRef }],
    } as unknown as RetrievalState

    const context = new EvidenceContextPolicy().select(withCandidate)

    expect(context.tokenBudget).toBeUndefined()
    expect(context.includedCandidateRefs).toEqual([candidateRef])
    expect(context.rendered).toContain('TKT-1')
  })

  it('compacts the state header before excluding every candidate under an explicit deployment cap', () => {
    const state = stateWithFieldCatalog()
    const candidateRef = TicketCandidateRef('candidate-context-capped')
    const withCandidate = {
      ...state,
      candidates: [{
        ref: candidateRef, displayId: 'TKT-CAPPED', rank: 1, title: '主卡异常', summary: '主卡无法登录。',
        l0: {}, matchSignals: { channels: ['keyword'], keywordTerms: ['主卡'] },
      }],
      candidateHistory: [{ ref: candidateRef }],
    } as unknown as RetrievalState

    const context = new EvidenceContextPolicy().select(withCandidate, 1_500)

    expect(context.estimatedTokens).toBeLessThanOrEqual(1_500)
    expect(context.includedCandidateRefs).toEqual([candidateRef])
  })
})
