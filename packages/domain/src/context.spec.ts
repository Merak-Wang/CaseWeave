import { describe, expect, it } from 'vitest'
import { TicketCandidateRef, TicketEvidenceId, type RetrievalState } from '@retrieval-agent/contracts'
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
      maxSearches: 4,
      modelStepsUsed: 1, searchesUsed: 1, wallClockElapsedMs: 0,
    },
    progress: {
      newCandidateRefs: [], newEvidenceIds: [], rankOverlap: 1,
      newDecisiveEvidence: false, resolvedGaps: [], noProgressStreak: 0,
    },
  } as unknown as RetrievalState
}

describe('EvidenceContextPolicy', () => {
  it('keeps a short source dialogue and its late correction together when the token budget fits', () => {
    const base = stateWithFieldCatalog()
    const ref = TicketCandidateRef('dialogue-ticket')
    const candidate = { ref, title: '关系解除受阻', summary: '初始诉求可能混淆', l0: {} }
    const evidence = Array.from({ length: 26 }, (_, part) => ({ evidenceId: TicketEvidenceId(`dialogue-${part}`),
      candidateRef: ref, field: 'source.raw_dialogue', part, start: 0, end: 20, fieldLength: 20,
      text: part === 24 ? '后续纠正：关系已经解除，现在只查后续账单。' : `第${part}轮：业务办理背景。`,
      trust: 'untrusted_ticket_evidence', truncated: false }))
    const state = { ...base, candidates: [candidate], candidateHistory: [candidate], promotedEvidence: evidence } as unknown as RetrievalState
    const policy = new EvidenceContextPolicy()
    const ample = policy.select(state, 10000)
    expect(ample.includedEvidenceIds).toEqual(evidence.map(e => e.evidenceId))
    expect(ample.rendered).toContain('后续纠正：关系已经解除')
    expect(ample.estimatedTokens).toBeLessThanOrEqual(10000)
    const bounded = policy.select(state, 2500)
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(2500)
    expect(bounded.includedEvidenceIds.length).toBeLessThan(evidence.length)
    const offset = policy.nextEvidenceWindowOffset({ ...state, modelVisibleEvidenceIds: bounded.includedEvidenceIds })
    const tail = policy.select({ ...state, evidenceWindowOffset: offset }, 10000)
    expect(tail.includedEvidenceIds).toContain(evidence[24]!.evidenceId)
    expect(tail.rendered).toContain('"alias":"e25"')
  })
  it('keeps superseded expert findings out of the current model window after a supplement', () => {
    const base = stateWithFieldCatalog()
    const state = { ...base, inputGeneration: 2, expertTasks: [{ id: 'old-expert', inputGeneration: 1,
      status: 'superseded', finding: { id: 'obsolete-finding', judgments: [] } }] } as unknown as RetrievalState
    const selection = new EvidenceContextPolicy().select(state)
    expect(selection.rendered).toContain('"archivedTaskCount":1')
    expect(selection.rendered).not.toContain('obsolete-finding')
    expect(selection.rendered).not.toContain('old-expert')
  })
  it('never removes user requirements, feedback or a pending question to fit a tiny context', () => {
    const base = stateWithFieldCatalog()
    const state = { ...base, userFeedback: [{ text: '排除仅欠费停机，必须有处理记录', receivedAt: '2026-09-07' }] }
    expect(() => new EvidenceContextPolicy().select(state, 25)).toThrow(/容量|要求|context/i)
  })
  it('advertises every required expert review even when older findings are outside the display window', () => {
    const base = stateWithFieldCatalog()
    const state = { ...base, inputGeneration: 2, expertTasks: Array.from({ length: 8 }, (_, i) => ({
      id: `expert-${i}`, inputGeneration: 2, status: i === 0 ? 'failed' : 'completed', candidateRefs: [], knowledgeRefs: [],
      finding: { id: `finding-${i}`, judgments: [], counterEvidenceRefs: [],
        gaps: i === 1 ? [{ kind: 'depth', status: 'open', evidenceRefs: [], description: '仍需主 Agent 查证' }] : [], nextAction: '主 Agent 核对' },
    })) } as unknown as RetrievalState
    const rendered = new EvidenceContextPolicy().select(state).rendered
    expect(rendered).toContain('"requiredExpertReviews":["expert-0","expert-1"]')
    expect(rendered).not.toContain('finding-0')
  })

  it('keeps a thousand historical judgments outside the working prompt and exposes history lookup', () => {
    const base = stateWithFieldCatalog()
    const state = { ...base, judgments: Array.from({ length: 1200 }, (_, i) => ({
      candidateRef: TicketCandidateRef(`old-${i}`), verdict: 'exclude' as const,
      evidenceRefs: [`evidence-${i}`], reason: `历史反例 ${i}：未发生业务变更。`,
    })) }
    const context = new EvidenceContextPolicy().select(state, 4000)
    expect(context.rendered).toContain('1200')
    expect(context.rendered).toContain('history')
    expect(context.rendered).not.toContain('历史反例 500')
    expect(context.estimatedTokens).toBeLessThanOrEqual(4000)
  })
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

  it('delivers newly inspected tail evidence with stable aliases after earlier evidence filled the window', () => {
    const state = stateWithFieldCatalog()
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      ref: TicketCandidateRef(`candidate-${index + 1}`), displayId: `TKT-${index + 1}`, rank: index + 1,
      title: `工单 ${index + 1}`, summary: '摘要尚不足以确认处理过程。', l0: {},
      matchSignals: { channels: ['keyword'], keywordTerms: ['处理'] },
    }))
    const promotedEvidence = Array.from({ length: 16 }, (_, index) => ({
      evidenceId: TicketEvidenceId(`evidence-${index + 1}`), candidateRef: candidates[Math.floor(index / 2)]!.ref,
      field: 'answer', text: `工单处理正文 ${index + 1}`, trust: 'untrusted', truncated: false,
    }))
    const latest = promotedEvidence.slice(12).map(evidence => evidence.evidenceId)
    const inspectedState = { ...state, candidates, candidateHistory: candidates, promotedEvidence,
      modelVisibleEvidenceIds: promotedEvidence.slice(0, 12).map(evidence => evidence.evidenceId),
      progress: { ...state.progress, newEvidenceIds: latest },
    } as unknown as RetrievalState

    const context = new EvidenceContextPolicy().select(inspectedState)

    expect(context.includedEvidenceIds.slice(0, 4)).toEqual(latest)
    for (const index of [13, 14, 15, 16]) {
      expect(context.rendered).toContain(`"alias":"e${index}"`)
      expect(context.rendered).toContain(`工单处理正文 ${index}`)
    }
    expect(context.includedEvidenceIds).toHaveLength(12)
    expect(context.excluded.filter(item => item.reason === 'not_selected')).toHaveLength(4)
    expect(context.rendered).toContain('"availableSegments":16')
    expect(context.rendered).toContain('"nextWindowAction":"inspect next_window"')
    const afterVisibilityWrite = { ...inspectedState, modelVisibleEvidenceIds: [
      ...inspectedState.modelVisibleEvidenceIds!, ...context.includedEvidenceIds,
    ] }
    expect(new EvidenceContextPolicy().select(afterVisibilityWrite).includedEvidenceIds).toEqual(context.includedEvidenceIds)
  })

  it('offers a further evidence window when one read returns more segments than the context can show', () => {
    const state = stateWithFieldCatalog()
    const ref = TicketCandidateRef('candidate-long-read')
    const candidate = { ref, displayId: 'TKT-LONG', rank: 1, title: '多阶段处理', summary: '需要核实全部处理记录。',
      l0: {}, matchSignals: { channels: ['keyword'], keywordTerms: [] } }
    const promotedEvidence = Array.from({ length: 16 }, (_, index) => ({
      evidenceId: TicketEvidenceId(`long-read-${index + 1}`), candidateRef: ref,
      field: 'answer', text: `处理阶段 ${index + 1}`, trust: 'untrusted', truncated: false,
    }))
    const policy = new EvidenceContextPolicy()
    const readState = { ...state, candidates: [candidate], candidateHistory: [candidate], promotedEvidence,
      progress: { ...state.progress, newEvidenceIds: promotedEvidence.map(item => item.evidenceId) },
    } as unknown as RetrievalState
    const first = policy.select(readState)
    const delivered = { ...readState, modelVisibleEvidenceIds: first.includedEvidenceIds }
    expect(policy.select(delivered).includedEvidenceIds).toEqual(first.includedEvidenceIds)

    const offset = policy.nextEvidenceWindowOffset(delivered)
    expect(offset).toBe(12)
    const next = policy.select({ ...delivered, evidenceWindowOffset: offset })
    expect(next.includedEvidenceIds).toEqual(promotedEvidence.slice(12).map(item => item.evidenceId))
    expect(next.rendered).toContain('"alias":"e16"')
  })
})
