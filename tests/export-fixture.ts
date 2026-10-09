import { vi } from 'vitest'
import { RetrievalId, RetrievalStateId, TicketCandidateRef, TicketSnapshotId, type RetrievalState, type TicketRetrievalProvider, type TrustedPrincipalContext } from '@retrieval-agent/contracts'

const CANDIDATE_REF = TicketCandidateRef('cand-export-1')
const SNAPSHOT_ID = TicketSnapshotId('snapshot-export-1')
export const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo',
  subjectId: 'support-user',
  entitlementVersion: 'entitlements-v1',
  purpose: 'ticket_retrieval',
  attributes: { group: ['support'] },
  issuedAt: '2026-08-27T00:00:00.000Z',
  expiresAt: '2026-08-28T00:00:00.000Z',
}

export function retrievalState(): RetrievalState {
  const snapshot = {
    snapshotId: SNAPSHOT_ID,
    shortId: 'snap-short',
    providerId: 'provider-v1',
    createdAt: '2026-08-27T00:00:00.000Z',
    expiresAt: '2026-08-28T00:00:00.000Z',
    sourceVersion: 'source-v1',
    indexVersion: 'index-v1',
    retrievalProfileVersion: 'fixture-keyword-v1',
    authorizationVersion: 'entitlements-v1',
    principalBindingHash: 'binding-v1',
    queryPolicyVersion: 'query-v1',
    fieldCatalog: [],
    capabilities: {
      exhaustive: true,
      pagination: true,
      evidencePromotion: true,
      detailRead: true,
      exportRead: true,
      keywordSearch: true,
      denseSearch: false,
      hybridFusion: false,
      reranking: false,
    },
  } as const
  const candidate = {
    ref: CANDIDATE_REF,
    displayId: 'INC-1',
    sourceVersion: 'source-v1',
    snapshotId: SNAPSHOT_ID,
    contentHash: 'hash-v1',
    evidenceLevel: 'L2' as const,
    rank: 1,
    title: '=unsafe title',
    summary: '+unsafe summary',
    l0: { category: '认证', status: '已解决' },
    matchFragments: [],
  }
  return {
    retrievalId: RetrievalId('retrieval-export-1'),
    stateId: RetrievalStateId('state-export-1'),
    revision: 1,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    phase: 'stopped',
    task: { target: 'ranked_cases', requestedCount: 1, countPolicy: 'explicit', answerabilityPolicy: 'current_snapshot_evidence_only', completenessRequirement: 'top_k' },
    principalBindingHash: 'binding-v1',
    snapshot,
    query: {
      original: '登录问题',
      spec: {
        target: 'ranked_cases',
        originalQuery: '登录问题',
        normalizedQuery: '登录问题',
        requestedCount: 1,
        countPolicy: 'explicit',
        mode: 'keyword',
        filters: [],
        ambiguities: [],
        excludedTerms: [],
        semanticHints: [],
        compilerVersion: 'query-v1',
      },
      confirmedConstraints: [],
      unresolvedConstraints: [],
    },
    candidates: [candidate],
    candidateHistory: [candidate],
    rankingHistory: [],
    excludedCandidateRefs: [],
    selectedCandidateRefs: [CANDIDATE_REF],
    lastAssessment: undefined,
    lastPage: {
      snapshotId: SNAPSHOT_ID,
      queryFingerprint: 'fingerprint',
      candidates: [candidate],
      completeness: 'exhaustive',
      scanned: 1,
      returned: 1,
      elapsedMs: 1,
      appliedFilters: [],
      warnings: [],
      trace: {
        stage: 'baseline',
        requestedMode: 'keyword',
        executedMode: 'keyword',
        strategyVersion: 'fixture-keyword-v1',
        channels: [{
          channel: 'keyword', implementation: 'fixture-bm25f', version: 'fixture-bm25f-v1',
          resultCount: 1, elapsedMs: 1,
        }],
        signals: [{
          candidateRef: CANDIDATE_REF,
          finalRank: 1,
          fusedScore: 1,
          channels: [{ channel: 'keyword', rank: 1, score: 1 }],
        }],
      },
      boundary: {
        authorizedCorpusSize: 1,
        documentsAfterStructuredFilters: 1,
        documentsEligibleForKeywordChannel: 1,
        rankedHits: 1,
        resultPagesExhausted: true,
        semanticRecallKnown: false,
      },
    },
    promotedEvidence: [],
    gaps: [],
    allowedActions: [],
    budget: { maxSearches: 1, modelStepsUsed: 1, searchesUsed: 1, wallClockElapsedMs: 1 },
    progress: { newCandidateRefs: [CANDIDATE_REF], rankOverlap: 0, newDecisiveEvidence: false, resolvedGaps: ['coverage'], noProgressStreak: 0 },
    termination: 'top_k_accepted',
    provenance: { rulesVersion: 'rules-v1', promptVersion: 'prompt-v1', contextPolicyVersion: 'context-v1', sourceEventIds: [] },
  }
}

export function provider(options: { readonly reject?: boolean; readonly snapshotValid?: boolean } = {}): TicketRetrievalProvider & { readonly status: ReturnType<typeof vi.fn>; readonly readDetails: ReturnType<typeof vi.fn> } {
  const status = vi.fn(async () => ({
    providerId: 'provider-v1',
    ready: true as const,
    readOnly: true as const,
    snapshotValid: options.snapshotValid ?? true,
    warnings: [],
  }))
  const readDetails = vi.fn(async (_principal: TrustedPrincipalContext, request: { readonly snapshotId: typeof SNAPSHOT_ID; readonly candidateRefs: readonly typeof CANDIDATE_REF[] }) => ({
    snapshotId: request.snapshotId,
    details: options.reject ? [] : [{
      candidateRef: CANDIDATE_REF,
      displayId: 'INC-1',
      sourceVersion: 'source-v1',
      title: '=unsafe title',
      summary: '+unsafe summary',
      l0: { category: '认证', status: '已解决' },
      fields: {},
      unavailableFields: [],
    }],
    rejectedCandidateRefs: options.reject ? [CANDIDATE_REF] : [],
    warnings: [],
  }))
  return {
    providerId: 'provider-v1',
    resolve: vi.fn(),
    openSnapshot: vi.fn(),
    search: vi.fn(),
    readEvidence: vi.fn(),
    status,
    readDetails,
  } as unknown as TicketRetrievalProvider & { readonly status: typeof status; readonly readDetails: typeof readDetails }
}
