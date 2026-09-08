import { describe, expect, it, vi } from 'vitest'
import {
  RetrievalId,
  RetrievalStateId,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketSnapshotId,
  type RetrievalState,
  type TicketRetrievalProvider,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { CandidateExportService, InMemoryExportAuditSink } from './service.js'
import { CandidateDetailService, InMemoryDetailReadAuditSink } from './detail.js'
import { candidateWindow, windowedNode } from './window.js'
import { projectTicketCandidateState } from './presentation.js'
import { createRetrievalReport, validateReportNarrative, reportMarkdown } from './report.js'
import { candidateEvidence } from './evidence.js'

describe('A4 phase8 judgment citation projection', () => {
  it('exposes only actually cited, model-visible, current-source and allowed-field spans', () => {
    const base = retrievalState(), c = base.candidates[0]!
    const e = { evidenceId: TicketEvidenceId('e1'), candidateRef: c.ref, displayId: c.displayId,
      sourceVersion: c.sourceVersion, contentHash: c.contentHash, field: 'body', text: '原文依据', start: 2, end: 6,
      estimatedTokens: 4, trust: 'untrusted_ticket_evidence' as const, truncated: false,
      principalBindingHash: 'must-not-leak', authorizationVersion: 'private-grant' }
    const state: RetrievalState = { ...base, accessValidation: 'current', modelVisibleEvidenceIds: [e.evidenceId],
      snapshot: { ...base.snapshot!, fieldCatalog: [{ key: 'body', label: '正文', valueKind: 'text', accessLevel: 'L3', filterOperators: [], sensitivity: 'source_controlled' }] },
      judgments: [{ candidateRef: c.ref, verdict: 'accept', reason: '读取原文后确认', evidenceRefs: [e.evidenceId] }], promotedEvidence: [e] }
    expect(candidateEvidence(state, c.ref)).toMatchObject({ citationCount: 1, citations: [{ id: e.evidenceId, field: 'body', text: '原文依据', start: 2, end: 6 }] })
    expect(JSON.stringify(candidateEvidence(state, c.ref))).not.toContain('must-not-leak')
    expect(candidateEvidence({ ...state, modelVisibleEvidenceIds: [] }, c.ref).citations).toEqual([])
    expect(candidateEvidence({ ...state, judgments: [] }, c.ref).citations).toEqual([])
    expect(candidateEvidence({ ...state, promotedEvidence: [{ ...e, sourceVersion: 'old' }] }, c.ref).citations).toEqual([])
    expect(candidateEvidence({ ...state, promotedEvidence: [{ ...e, field: 'raw_json' }] }, c.ref).citations).toEqual([])
    expect(() => candidateEvidence({ ...state, accessValidation: 'required' }, c.ref)).toThrow(/资格/)
    expect(() => candidateEvidence(state, 'unknown')).toThrow(/当前任务/)
  })
})

describe('A14 phase 5 delivery boundaries', () => {
  it('streams complete controlled JSONL fields and refuses undeclared Provider payloads', async () => {
    const base = retrievalState()
    const state = { ...base, snapshot: { ...base.snapshot!, fieldCatalog: [{ key: 'body', label: '正文', valueKind: 'text' as const, accessLevel: 'L3' as const, filterOperators: [], sensitivity: 'source_controlled' as const }, { key: 'raw', label: 'raw', valueKind: 'raw_json' as const, accessLevel: 'L3' as const, filterOperators: [], sensitivity: 'source_controlled' as const }] } }
    const p = provider()
    p.readDetails.mockImplementation(async (_p, request) => ({ snapshotId: SNAPSHOT_ID, rejectedCandidateRefs: [], warnings: [], details: [{
      candidateRef: CANDIDATE_REF, displayId: 'INC-1', sourceVersion: 'source-v1', title: '=unsafe title', summary: '+unsafe summary', l0: {},
      fields: Object.fromEntries(request.fields.map((f: string) => [f, ['=原文\n多行,引号"']])), unavailableFields: [],
    }] }))
    const parts: string[] = []
    const exported = await new CandidateExportService(p, new InMemoryExportAuditSink()).stream(PRINCIPAL, state,
      { format: 'jsonl', template: 'full' }, async part => { parts.push(part) })
    const row = JSON.parse(parts.join(''))
    expect(exported.receipt.rowCount).toBe(1)
    expect(row.fields).toEqual({ body: ['=原文\n多行,引号"'] })
    expect(row.title).toBe('=unsafe title')
    expect(p.readDetails.mock.calls[0]![1].fields).toEqual(['body'])
    p.readDetails.mockImplementationOnce(async () => ({ snapshotId: SNAPSHOT_ID, rejectedCandidateRefs: [], warnings: [], details: [{
      candidateRef: CANDIDATE_REF, displayId: 'INC-1', sourceVersion: 'source-v1', title: '=unsafe title', summary: '+unsafe summary', l0: {}, fields: { raw: ['secret'] }, unavailableFields: [],
    }] }))
    await expect(new CandidateExportService(p, new InMemoryExportAuditSink()).stream(PRINCIPAL, state,
      { format: 'jsonl', template: 'full' }, async () => {})).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  })

  it('bounds the wire window and fences changed conditions without invalidating display-only reads', () => {
    const base = retrievalState()
    const candidates = Array.from({ length: 1234 }, (_, i) => ({ ...base.candidates[0]!, ref: TicketCandidateRef(`c${i}`), displayId: `T-${i}` }))
    const state = { ...base, candidates, candidateHistory: candidates, selectedCandidateRefs: candidates.map(c => c.ref) }
    const first = candidateWindow(state)
    expect(first.items).toHaveLength(30); expect(first.total).toBe(1234)
    expect(candidateWindow({ ...state, revision: 99 }, 'current', first.nextCursor).offset).toBe(30)
    const history = candidateWindow(state, 'history')
    expect(candidateWindow(state, 'history', history.nextCursor).readableCandidateRefs).toEqual(candidates.slice(30, 60).map(c => c.ref))
    expect(candidateWindow({ ...state, candidates: candidates.slice(0, 1) }, 'history').readableCandidateRefs).toEqual(['c0'])
    expect(() => candidateWindow({ ...state, inputGeneration: 2 }, 'current', first.nextCursor)).toThrow('更新')
    const node = windowedNode(state, projectTicketCandidateState(state, state.retrievalId))
    expect(node.collectionWindow?.confirmed).toBe(1234); expect(node.result?.tickets).toHaveLength(30)
    expect(node.selectedCandidateRefs).toHaveLength(30); expect(node.alreadyReadEvidence).toHaveLength(0)
  })

  it('reports only confirmed examples and rejects unknown citations; empty and incomplete reports remain explicit', () => {
    const base = retrievalState()
    const state = { ...base, modelVisibleCandidateRefs: [CANDIDATE_REF], judgments: [{ candidateRef: CANDIDATE_REF, verdict: 'accept' as const, evidenceRefs: [CANDIDATE_REF], reason: '可见概览支持' }] }
    const report = createRetrievalReport(state, [{ kind: 'query', text: state.query.original }], 'handoff')
    expect(report.confirmedCount).toBe(1); expect(report.citations[0]?.id).toBe(CANDIDATE_REF)
    expect(report.coverage.semanticStatus).toBe('satisfied'); expect(report.coverage.complete).toBe(false)
    expect(() => validateReportNarrative({ paragraphs: [{ text: 'bad', citations: ['unconfirmed'] }] }, report)).toThrow('引用')
    expect(validateReportNarrative({ paragraphs: [{ text: '概览支持登录场景。', citations: [CANDIDATE_REF] }] }, report).paragraphs).toHaveLength(1)
    expect(reportMarkdown(report)).toContain('交接报告')
    const empty = createRetrievalReport({ ...state, selectedCandidateRefs: [], termination: 'partial', stopExplanation: '证据不足，未完成。' }, [])
    expect(empty.confirmedCount).toBe(0); expect(empty.examples).toEqual([]); expect(empty.coverage.stoppingReason).toBe('partial')
  })
})

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

describe('CandidateExportService', () => {
  it('refuses unjudged candidates after a bounded stop even when the user has read their details', async () => {
    const current = retrievalState()
    const state: RetrievalState = {
      ...current,
      phase: 'stopped',
      termination: 'budget_exhausted',
      selectedCandidateRefs: [],
      promotedEvidence: [{
        evidenceId: TicketEvidenceId('evidence-user-detail'), candidateRef: CANDIDATE_REF,
        displayId: 'INC-1', sourceVersion: 'source-v1', contentHash: 'hash-v1',
        field: 'problemDescription', text: '用户点开查看的问题描述', start: 0, end: 12,
        estimatedTokens: 8, trust: 'untrusted_ticket_evidence', truncated: false,
        evidenceLevel: 'L2', readers: ['user'],
      }],
    }
    const source = provider()
    const audit = new InMemoryExportAuditSink()
    const service = new CandidateExportService(source, audit)
    await expect(service.exportCsv(PRINCIPAL, state)).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
    await expect(service.exportCsv(PRINCIPAL, state, [CANDIDATE_REF])).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
    expect(source.readDetails).not.toHaveBeenCalled()
    expect(audit.records).toEqual([])
  })

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

  it('downloads thousands of confirmed rows in bounded Provider pages and excludes the pending tail', async () => {
    const current = retrievalState()
    const candidates = Array.from({ length: 1235 }, (_, index) => ({ ...current.candidates[0]!,
      ref: TicketCandidateRef(`candidate-bulk-${index}`), displayId: `INC-${index}`, rank: index + 1,
    }))
    const state = { ...current, candidates, selectedCandidateRefs: candidates.slice(0, 1234).map(candidate => candidate.ref) }
    const source = provider()
    source.readDetails.mockImplementation(async (_principal, request) => ({
      snapshotId: request.snapshotId,
      details: request.candidateRefs.map((ref: TicketCandidateRef) => {
        const candidate = candidates.find(item => item.ref === ref)!
        return { candidateRef: ref, displayId: candidate.displayId, sourceVersion: candidate.sourceVersion,
          title: candidate.title, summary: candidate.summary, l0: candidate.l0, fields: {}, unavailableFields: [] }
      }), rejectedCandidateRefs: [], warnings: [],
    }))
    const result = await new CandidateExportService(source, new InMemoryExportAuditSink()).exportCsv(PRINCIPAL, state)
    expect(result.receipt.rowCount).toBe(1234)
    expect(source.readDetails).toHaveBeenCalledTimes(13)
    expect(source.readDetails.mock.calls.every(call => call[1].candidateRefs.length <= 100)).toBe(true)
    expect(result.content.split('\r\n').filter(Boolean)).toHaveLength(1235)
    expect(result.content).toContain('"INC-1233"')
    expect(result.content).not.toContain('"INC-1234"')
  })

  it.each(['snapshot', 'candidate', 'source', 'title'] as const)('refuses mismatched export %s without issuing a receipt', async mismatch => {
    const source = provider()
    const response = await source.readDetails(PRINCIPAL, { snapshotId: SNAPSHOT_ID, candidateRefs: [CANDIDATE_REF], fields: [], purpose: 'candidate_export' })
    const detail = response.details[0]!
    source.readDetails.mockResolvedValueOnce({ ...response,
      snapshotId: mismatch === 'snapshot' ? TicketSnapshotId('wrong-snapshot') : SNAPSHOT_ID,
      details: [{ ...detail,
        candidateRef: mismatch === 'candidate' ? TicketCandidateRef('wrong-candidate') : CANDIDATE_REF,
        sourceVersion: mismatch === 'source' ? 'changed' : detail.sourceVersion,
        title: mismatch === 'title' ? 'changed content in same version' : detail.title,
      }],
    })
    const audit = new InMemoryExportAuditSink()
    await expect(new CandidateExportService(source, audit).exportCsv(PRINCIPAL, retrievalState()))
      .rejects.toMatchObject({ code: ['snapshot', 'candidate'].includes(mismatch) ? 'PROTOCOL_MISMATCH' : 'SNAPSHOT_INVALID' })
    expect(audit.records).toEqual([])
  })
})

describe('CandidateDetailService', () => {
  it.each(['snapshot', 'candidate', 'raw-field'] as const)('rejects a Provider response outside the authorized %s scope', async mismatch => {
    const current = retrievalState()
    const state: RetrievalState = { ...current, snapshot: { ...current.snapshot!, fieldCatalog: [
      { key: 'resolution', label: '处理结果', accessLevel: 'L2', valueKind: 'text', filterOperators: [], sensitivity: 'source_controlled' },
    ] } }
    const source = provider()
    source.readDetails.mockResolvedValueOnce({
      snapshotId: mismatch === 'snapshot' ? TicketSnapshotId('another-snapshot') : SNAPSHOT_ID,
      details: [{
        candidateRef: mismatch === 'candidate' ? TicketCandidateRef('another-candidate') : CANDIDATE_REF,
        displayId: 'INC-1', sourceVersion: 'source-v1', title: '登录问题', summary: '工单摘要', l0: {},
        fields: mismatch === 'raw-field' ? { 'source.raw': ['不允许的完整原始载荷'] } : { resolution: ['重新同步后恢复'] },
        unavailableFields: [],
      }], rejectedCandidateRefs: [], warnings: [],
    })
    const audit = new InMemoryDetailReadAuditSink()
    await expect(new CandidateDetailService(source, audit).readDetails(PRINCIPAL, state, [CANDIDATE_REF], ['resolution']))
      .rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
    expect(audit.records).toEqual([])
  })
})
