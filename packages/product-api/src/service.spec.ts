import { createHash } from 'node:crypto'
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
import { xlsxRows } from '../../../tests/xlsx-assertions.js'

function withoutReportFormat<T extends { format?: 'summary' }>(report: T): Omit<T, 'format'> {
  const legacy = { ...report }
  delete legacy.format
  return legacy
}

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
  it('keeps every cited source fragment supporting a report example, including later decisive facts', () => {
    const base = retrievalState(), c = base.candidates[0]!
    const evidence = ['原业务状态', '到期时间', '到期后转为新的计费方式'].map((text, i) => ({
      evidenceId: TicketEvidenceId(`report-e${i}`), candidateRef: c.ref, displayId: c.displayId,
      sourceVersion: c.sourceVersion, contentHash: c.contentHash, field: 'problemDescription', text,
      start: i * 30, end: i * 30 + text.length, estimatedTokens: text.length,
      trust: 'untrusted_ticket_evidence' as const, truncated: false,
    }))
    const state = { ...base, promotedEvidence: evidence, modelVisibleEvidenceIds: evidence.map(e => e.evidenceId),
      judgments: [{ candidateRef: c.ref, verdict: 'accept' as const, evidenceRefs: evidence.map(e => e.evidenceId), reason: '三段共同支持状态变化' }] }
    const report = createRetrievalReport(state, [])
    expect(report.citations.map(citation => citation.text)).toEqual(evidence.map(e => e.text))
    expect(report.examples[0]!.citations).toEqual(evidence.map(e => e.evidenceId))
  })

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
    expect(candidateWindow({ ...state, candidates: candidates.slice(0, 1) }, 'history').readableCandidateRefs).toEqual(candidates.slice(0, 30).map(c => c.ref))
    expect(candidateWindow({ ...state, accessValidation: 'required' }, 'history').readableCandidateRefs).toEqual([])
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
    expect(report.format).toBe('summary')
    expect(() => validateReportNarrative({ paragraphs: [{ text: 'bad', citations: ['unconfirmed'] }] }, report)).toThrow('引用')
    expect(validateReportNarrative({ paragraphs: [{ text: '概览支持登录场景。', citations: [CANDIDATE_REF] }] }, report).paragraphs).toHaveLength(1)
    expect(reportMarkdown(report)).toContain('交接报告')
    expect(reportMarkdown(withoutReportFormat(report))).toContain('## 覆盖与停止')
    const learning = { modelId: 'model', featureId: 'feature', hashBasis: 'test',
      quality: { basis: 'selection' as const, precision: .903, recall: .915, precision_target: .9, recall_target: .9 } }
    const selected = reportMarkdown(withoutReportFormat({ ...report, learning }))
    expect(selected).toContain('模型选择集指标：Precision=0.903，Recall=0.915')
    expect(selected).not.toContain('集合下界')
    const sampled = withoutReportFormat({ ...report, learning: { ...learning, quality: { precision_lower: .827, recall_lower: .016,
      precision_target: .9, recall_target: .9 } } })
    expect(reportMarkdown(sampled)).toContain('历史抽验下界')
    const empty = createRetrievalReport({ ...state, selectedCandidateRefs: [], termination: 'partial', stopExplanation: '证据不足，未完成。' }, [])
    expect(empty.confirmedCount).toBe(0); expect(empty.examples).toEqual([]); expect(empty.coverage.stoppingReason).toBe('partial')
  })

  it('renders new reports as a short summary with readable citation mapping', () => {
    const base = retrievalState()
    const state = { ...base, modelVisibleCandidateRefs: [CANDIDATE_REF], judgments: [{ candidateRef: CANDIDATE_REF,
      verdict: 'accept' as const, evidenceRefs: [CANDIDATE_REF], reason: '可见概览支持' }] }
    const report = createRetrievalReport(state, [{ kind: 'query', text: state.query.original }], 'operator')
    const markdown = reportMarkdown(report)
    expect(markdown).toContain('查询：登录问题')
    expect(markdown).toContain('筛选数量：1')
    expect(markdown).toContain('已筛选 1 条工单。')
    expect(markdown).not.toContain('## 引用')
    expect(markdown).not.toContain('=unsafe title')
    expect(markdown).not.toContain('+unsafe summary')
    expect(markdown).not.toContain('覆盖与停止')
    expect(markdown).not.toContain('交付与使用')
    expect(() => validateReportNarrative({ paragraphs: [{ text: '简短总结'.repeat(76), citations: [CANDIDATE_REF] }] }, report)).toThrow('引用')

    const narrative = { ...report, narrative: { status: 'model' as const,
      paragraphs: [{ text: '登录恢复情况已确认。', citations: [CANDIDATE_REF] }] } }
    expect(reportMarkdown(narrative)).toContain('登录恢复情况已确认。 [1](#ref-1)')
    expect(reportMarkdown(narrative)).toContain('[1] INC-1（摘要）')
  })

  it('keeps source-backed example reasons when a legacy format marker is absent', () => {
    const base = retrievalState()
    const state = { ...base, modelVisibleCandidateRefs: [CANDIDATE_REF], judgments: [{ candidateRef: CANDIDATE_REF,
      verdict: 'accept' as const, evidenceRefs: [CANDIDATE_REF], reason: '可见概览支持' }] }
    const report = withoutReportFormat({ ...createRetrievalReport(state, [{ kind: 'query', text: state.query.original }], 'handoff'),
      generatedAt: '2026-01-02T03:04:05.000Z' })
    expect(reportMarkdown(report)).toContain('可见概览支持')
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

describe('XLSX confirmed collection export', () => {
  it('exports exactly the complete confirmed ID set through bounded pages, excluding pending rows', async () => {
    const base = retrievalState()
    const candidates = Array.from({ length: 238 }, (_, index) => ({ ...base.candidates[0]!,
      ref: TicketCandidateRef(`xlsx-${index}`), displayId: '00012345678901234567890' + index,
      title: '=中文😀_x0000_' + index, summary: '摘要\r\n下一行', rank: index + 1 }))
    const state = { ...base, candidates, selectedCandidateRefs: candidates.slice(0, 237).map(c => c.ref) }
    const p = provider()
    p.readDetails.mockImplementation(async (_principal, request) => ({ snapshotId: request.snapshotId,
      details: request.candidateRefs.map((ref: TicketCandidateRef) => {
        const c = candidates.find(candidate => candidate.ref === ref)!
        return { candidateRef: ref, displayId: c.displayId, sourceVersion: c.sourceVersion, title: c.title, summary: c.summary,
          l0: c.l0, fields: {}, unavailableFields: [] }
      }), rejectedCandidateRefs: [], warnings: [] }))
    const audit = new InMemoryExportAuditSink()
    const exported = await new CandidateExportService(p, audit).exportXlsx(PRINCIPAL, state)
    const [headers, ...rows] = xlsxRows(exported.content)
    const idIndex = headers!.indexOf('ticket'), titleIndex = headers!.indexOf('title'), summaryIndex = headers!.indexOf('summary')
    expect(exported.fileName.endsWith('.xlsx')).toBe(true)
    expect(exported.mediaType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(exported.receipt.rowCount).toBe(rows.length)
    expect(rows.map(row => row[idIndex])).toEqual(candidates.slice(0, 237).map(c => c.displayId))
    expect(rows[0]![titleIndex]).toBe(candidates[0]!.title); expect(rows[0]![summaryIndex]).toBe(candidates[0]!.summary)
    expect(p.readDetails.mock.calls.map(call => call[1].candidateRefs.length)).toEqual([100, 100, 37])
    expect(exported.receipt.contentSha256).toBe(createHash('sha256').update(exported.content).digest('hex'))
    expect(audit.records).toHaveLength(1)
  })
  it.each(['csv', 'jsonl', 'xlsx'] as const)('applies exact finite byte boundaries to %s without success receipt on overflow', async format => {
    const config = { now: () => new Date('2026-10-08T00:00:00Z') }
    const chunks: (string | Uint8Array)[] = []
    await new CandidateExportService(provider(), new InMemoryExportAuditSink(), config).stream(PRINCIPAL, retrievalState(),
      { format, template: 'summary' }, async part => { chunks.push(part) })
    const size = chunks.reduce((sum, part) => sum + (typeof part === 'string' ? Buffer.byteLength(part) : part.byteLength), 0)
    await expect(new CandidateExportService(provider(), new InMemoryExportAuditSink(), { ...config, maxBytes: size }).stream(PRINCIPAL, retrievalState(),
      { format, template: 'summary' }, async () => {})).resolves.toMatchObject({ receipt: { rowCount: 1 } })
    const audit = new InMemoryExportAuditSink()
    await expect(new CandidateExportService(provider(), audit, { ...config, maxBytes: size - 1 }).stream(PRINCIPAL, retrievalState(),
      { format, template: 'summary' }, async () => {})).rejects.toMatchObject({ code: 'EXPORT_LIMIT_EXCEEDED' })
    expect(audit.records).toEqual([])
    expect(() => new CandidateExportService(provider(), audit, { maxBytes: Infinity })).toThrow('finite')
  })
  it('fails closed on cancellation, final grant withdrawal and changed result version', async () => {
    const base = retrievalState(), revoked = provider(), changed = provider()
    revoked.status.mockResolvedValueOnce({ providerId: 'provider-v1', ready: true, readOnly: true, snapshotValid: true, warnings: [] })
      .mockResolvedValueOnce({ providerId: 'provider-v1', ready: true, readOnly: true, snapshotValid: false, warnings: [] })
    const audit = new InMemoryExportAuditSink()
    await expect(new CandidateExportService(revoked, audit).exportXlsx(PRINCIPAL, base)).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
    const abort = new AbortController(); abort.abort()
    await expect(new CandidateExportService(provider(), audit).exportXlsx(PRINCIPAL, base, undefined, abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(new CandidateExportService(changed, audit, { assertCurrentResult: async () => {
      if (changed.readDetails.mock.calls.length) throw new Error('result revision changed')
    } }).exportXlsx(PRINCIPAL, base)).rejects.toThrow('result revision changed')
    await expect(new CandidateExportService(provider({ reject: true }), audit).exportXlsx(PRINCIPAL, base)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(new CandidateExportService(provider(), audit).exportXlsx(PRINCIPAL, { ...base, selectedCandidateRefs: [] })).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
    expect(audit.records).toEqual([])
  })
})

describe('XLSX authorized templates and numeric collections', () => {
  it('exports allowed full fields as text and excludes raw payloads', async () => {
    const base = retrievalState(), field = 'body'
    const state: RetrievalState = { ...base, snapshot: { ...base.snapshot!, fieldCatalog: [
      { key: field, label: '正文', valueKind: 'text', accessLevel: 'L3', filterOperators: [], sensitivity: 'source_controlled' },
      { key: 'raw', label: 'raw', valueKind: 'raw_json', accessLevel: 'L3', filterOperators: [], sensitivity: 'source_controlled' }] } }
    const p = provider(), parts: Uint8Array[] = []
    p.readDetails.mockImplementation(async (_principal, request) => ({ snapshotId: request.snapshotId,
      details: [{ candidateRef: CANDIDATE_REF, displayId: 'INC-1', sourceVersion: 'source-v1', title: '=unsafe title', summary: '+unsafe summary',
        l0: {}, fields: { body: ['=原文\n多行,引号"'] }, unavailableFields: [] }], rejectedCandidateRefs: [], warnings: [] }))
    await new CandidateExportService(p, new InMemoryExportAuditSink()).stream(PRINCIPAL, state, { format: 'xlsx', template: 'full' }, async part => { parts.push(part) })
    const [headers, row] = xlsxRows(Buffer.concat(parts))
    expect(p.readDetails.mock.calls[0]![1].fields).toEqual(['body'])
    expect(JSON.parse(row![headers!.indexOf('body_fields')]!)).toEqual({ body: ['=原文\n多行,引号"'] })
    expect(headers).toContain('unavailable_fields')
  })
  it.each(['complete', 'truncated', 'duplicate'] as const)('checks actual full numeric result identity/row count for %s pages', async mode => {
    const base = retrievalState(), c = base.candidates[0]!
    const candidates = [c, { ...c, ref: TicketCandidateRef('numeric-2'), displayId: '00012345678901234567890' }]
    const state: RetrievalState = { ...base, candidates: [], selectedCandidateRefs: [], budget: { ...base.budget,
      operatorUsage: { learning: { input_revision: 0, stop_reason: 'quality_passed', result_set: { model_id: 'numeric-model',
        input_revision: 0, predicate_key: 'p', feature_id: 'f', returned: 2, scope_count: 2,
        quality: { basis: 'selection', precision: 1, recall: 1, precision_target: .9, recall_target: .9 }, metadata: { model: 'dense_lr' } } } } } }
    const p = provider()
    p.resolveFeatureIds = vi.fn(async (_principal: TrustedPrincipalContext, request: { readonly ids: readonly number[] }) => request.ids.map(id => candidates[mode === 'duplicate' ? 0 : id]!))
    p.readDetails.mockImplementation(async (_principal, request) => ({ snapshotId: request.snapshotId,
      details: request.candidateRefs.map((ref: TicketCandidateRef) => {
        const candidate = candidates.find(item => item.ref === ref)!
        return { candidateRef: ref, displayId: candidate.displayId, sourceVersion: candidate.sourceVersion, title: candidate.title, summary: candidate.summary,
          l0: candidate.l0, fields: {}, unavailableFields: [] }
      }), rejectedCandidateRefs: [], warnings: [] }))
    const store = { begin: vi.fn(), write: vi.fn(), count: vi.fn(), page: vi.fn().mockResolvedValueOnce({ ids: [0], scores: [1] })
      .mockResolvedValueOnce({ ids: mode === 'truncated' ? [] : [1], scores: mode === 'truncated' ? [] : [1] }) }
    const audit = new InMemoryExportAuditSink(), service = new CandidateExportService(p, audit, { semanticResults: store, pageSize: 1 })
    if (mode === 'complete') {
      const exported = await service.exportXlsx(PRINCIPAL, state), [headers, ...rows] = xlsxRows(exported.content)
      expect(exported.receipt.rowCount).toBe(2)
      expect(rows.map(row => row[headers!.indexOf('ticket')])).toEqual(candidates.map(candidate => candidate.displayId))
      expect(rows.map(row => row[headers!.indexOf('model_method')])).toEqual(['dense_lr', 'dense_lr'])
      expect(rows.map(row => row[headers!.indexOf('model_score')])).toEqual(['1', '1'])
      expect(rows.map(row => row[headers!.indexOf('quality_evaluation')])).toEqual(['not_human_evaluated', 'not_human_evaluated'])
    } else {
      await expect(service.exportXlsx(PRINCIPAL, state)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
      expect(audit.records).toEqual([])
    }
  })
})
