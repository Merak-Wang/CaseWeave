import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  RetrievalId,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketSnapshotId,
  type TicketCandidateNode,
} from '@retrieval-agent/contracts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children }: { readonly children?: ReactNode }) => <button>{children}</button>,
  IconChevronDownOutline14: () => null,
  IconChevronUpOutline14: () => null,
}))

import { CandidatePanel, type CandidatePanelProps } from './CandidatePanel.js'

const snapshotId = TicketSnapshotId('snapshot-ui-density')

function data(): TicketCandidateNode {
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    ref: TicketCandidateRef(`candidate-ui-${index + 1}`),
    displayId: `TKT-${index + 1}`,
    sourceVersion: 'source-version-with-a-long-identifier',
    snapshotId,
    contentHash: `hash-${index + 1}`,
    evidenceLevel: 'L1' as const,
    rank: index + 1,
    title: `工单标题 ${index + 1}`,
    summary: `工单标题 ${index + 1}`,
    l0: { status: '已解决', priority: '高', region: '广东', createdAt: '2026-08-20T00:00:00.000Z' },
    matchFragments: [],
  }))
  return {
    retrievalId: RetrievalId('retrieval-ui-density'),
    version: 3,
    querySummary: '副卡',
    queryLogic: {
      operator: 'and',
      requiredConcepts: [
        { surface: '副卡', canonical: '副卡', alternatives: ['副卡'] },
        { surface: '跨域', canonical: '跨域', alternatives: ['跨域', '省外'] },
      ],
    },
    fastQuery: {
      schemaVersion: 1,
      source: 'direct_user',
      rewriteApplied: false,
      keyword: { terms: ['副卡', '跨域'], operator: 'and' },
      vector: { text: '帮我找副卡和跨域有关工单' },
    },
    snapshotShortId: 'snap-1',
    completeness: 'bounded',
    nextPageAvailable: true,
    resultPagesExhausted: false,
    semanticRecallKnown: false,
    status: 'results',
    candidates,
    alreadyReadEvidence: [{
      evidenceId: TicketEvidenceId('evidence-ui-1'),
      candidateRef: candidates[0]!.ref,
      displayId: candidates[0]!.displayId,
      sourceVersion: candidates[0]!.sourceVersion,
      contentHash: candidates[0]!.contentHash,
      field: 'problemDescription',
      text: '已读取的问题描述',
      start: 0,
      end: 9,
      estimatedTokens: 6,
      trust: 'untrusted_ticket_evidence',
      truncated: false,
    }],
    detailFields: [{ key: 'problemDescription', label: '问题描述' }],
    exportEnabled: true,
    result: {
      type: 'ticket_collection',
      schemaVersion: 1,
      retrievalId: RetrievalId('retrieval-ui-density'),
      query: '副卡',
      target: 'ranked_cases',
      stoppingReason: 'top_k_accepted',
      complete: false,
      decisionFinalized: true,
      topKAccepted: true,
      resultPagesExhausted: false,
      semanticRecallKnown: false,
      resultMayBeIncomplete: true,
      nextPageAvailable: true,
      tickets: candidates,
      evidence: [],
      remainingGapKinds: [],
    },
  }
}

describe('CandidatePanel density', () => {
  it('shows the first five rows, a continuation control, and the zero-rewrite AND interpretation', () => {
    const html = renderToStaticMarkup(<CandidatePanel {...({ node: { data: data() }, sessionId: 'session-ui' } as CandidatePanelProps)} />)
    expect(html).toContain('候选工单（集合） · 6 条')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('原始查询')
    expect(html).toContain('关键词同时包含')
    expect(html).toContain('副卡')
    expect(html).toContain('跨域')
    expect(html).toContain('工单编号 TKT-1')
    expect(html).not.toContain('工单编号 TKT-6')
    expect(html).toContain('继续显示 1 条')
    expect(html).toContain('当前 Top-K 已接受；语义召回范围仍未知。')
    expect(html).not.toContain('继续检索下一批')
  })

  it('offers Provider-cursor continuation while the current Top-K is presented but not frozen', () => {
    const current = data()
    const html = renderToStaticMarkup(<CandidatePanel {...({
      node: { data: { ...current, result: undefined } }, sessionId: 'session-ui',
    } as CandidatePanelProps)} />)
    expect(html).toContain('首批候选 · 6 条')
    expect(html).toContain('继续检索下一批')
    expect(html).toContain('当前检索表达式仍有后续候选')
  })
})
