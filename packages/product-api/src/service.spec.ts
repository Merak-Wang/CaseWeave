import { describe, expect, it, vi } from 'vitest'
import {
  RetrievalId,
  RetrievalStateId,
  TicketCandidateRef,
  TicketSnapshotId,
  type RetrievalState,
  type TicketRetrievalProvider,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { CandidateExportService, InMemoryExportAuditSink } from './service.js'

const CANDIDATE_REF = TicketCandidateRef('cand-export-1')
const SNAPSHOT_ID = TicketSnapshotId('snapshot-export-1')
const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo',
  subjectId: 'support-user',
  entitlementVersion: 'entitlements-v1',
  purpose: 'ticket_retrieval',
  attributes: { group: ['support'] },
  issuedAt: '2026-08-27T00:00:00.000Z',
  expiresAt: '2026-08-28T00:00:00.000Z',
}

function retrievalState(): RetrievalState {
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
    evidenceLevel: 'L1' as const,
    rank: 1,
    title: '=unsafe title',
    summary: '代理后的登录循环',
    l0: { category: '认证', status: '已解决' },
    matchFragments: [],
  }
  return {
    retrievalId: RetrievalId('retrieval-export-1'),
    stateId: RetrievalStateId('state-export-1'),
    revision: 1,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    phase: 'assessed',
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
    selectedCandidateRefs: [],
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
    budget: { maxRounds: 2, maxSearches: 1, maxPromotions: 1, maxEvidenceTokens: 50, maxLatencyMs: 1000, roundsUsed: 1, searchesUsed: 1, promotionsUsed: 0, evidenceTokensUsed: 0, latencyMs: 1 },
    progress: { newCandidateRefs: [CANDIDATE_REF], rankOverlap: 0, newDecisiveEvidence: false, resolvedGaps: ['coverage'], noProgressStreak: 0 },
    termination: 'active',
    provenance: { rulesVersion: 'rules-v1', promptVersion: 'prompt-v1', contextPolicyVersion: 'context-v1', sourceEventIds: [] },
  }
}

function provider(options: { readonly reject?: boolean; readonly snapshotValid?: boolean } = {}): TicketRetrievalProvider & { readonly status: ReturnType<typeof vi.fn>; readonly readDetails: ReturnType<typeof vi.fn> } {
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
      summary: '代理后的登录循环',
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

describe('CandidateExportService', () => {
  it('reauthorizes every candidate, emits a safe CSV, and persists an audit receipt', async () => {
    const source = provider()
    const audit = new InMemoryExportAuditSink()
    const ids = ['export-1', 'audit-1']
    const service = new CandidateExportService(source, audit, {
      now: () => new Date('2026-08-27T03:00:00.000Z'),
      id: () => ids.shift()!,
    })

    const result = await service.exportCsv(PRINCIPAL, retrievalState())

    expect(source.status).toHaveBeenCalledWith(PRINCIPAL, SNAPSHOT_ID)
    expect(source.readDetails).toHaveBeenCalledWith(PRINCIPAL, expect.objectContaining({ purpose: 'candidate_export' }), undefined)
    expect(result.content).toContain("'=unsafe title")
    expect(result.receipt).toMatchObject({ exportId: 'export-1', auditId: 'audit-1', rowCount: 1, snapshotShortId: 'snap-short' })
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0]).toMatchObject({ tenantId: 'demo', subjectId: 'support-user', candidateRefs: [CANDIDATE_REF] })
    expect(audit.records[0]!.contentSha256).toBe(result.receipt.contentSha256)
  })

  it('fails closed for stale authorization, rejected rows, and forged UI references', async () => {
    const state = retrievalState()
    await expect(new CandidateExportService(provider({ snapshotValid: false }), new InMemoryExportAuditSink()).exportCsv(PRINCIPAL, state))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
    await expect(new CandidateExportService(provider({ reject: true }), new InMemoryExportAuditSink()).exportCsv(PRINCIPAL, state))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(new CandidateExportService(provider(), new InMemoryExportAuditSink()).exportCsv(PRINCIPAL, state, [TicketCandidateRef('forged')]))
      .rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
  })
})
