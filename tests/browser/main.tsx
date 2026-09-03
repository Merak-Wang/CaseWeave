import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {} from '../../packages/ui-ticket-results/src/client/definition.js'
import { CandidatePanel, type CandidatePanelProps } from '../../packages/ui-ticket-results/src/client/CandidatePanel.js'

const candidates = [
  {
    ref: 'candidate-tkt-0007',
    displayId: 'TKT-0007',
    sourceVersion: 'legacy-smoke-v1:f6950eb58e398ecabf4fecf77d529a674afa6877d0229d943a2887017dce8bc8',
    snapshotId: 'snapshot-browser-fixture',
    contentHash: 'hash-0007',
    evidenceLevel: 'L2',
    rank: 1,
    title: '副卡在省外漫游无法上网',
    summary: '副卡在省外漫游时数据业务鉴权失败。',
    l0: {
      status: 'resolved', priority: 'high', category: 'mobile_data', region: '广东',
      additionalFields: [{ key: 'source.dataset', label: '数据集', value: 'legacy-smoke', sourcePath: 'source_dataset' }],
    },
    matchFragments: [],
  },
  {
    ref: 'candidate-tkt-0042-with-a-deliberately-long-reference',
    displayId: 'TKT-0042',
    sourceVersion: 'legacy-smoke-v1',
    snapshotId: 'snapshot-browser-fixture',
    contentHash: 'hash-0042',
    evidenceLevel: 'L2',
    rank: 2,
    title: '副卡跨省补换后业务未恢复',
    summary: '副卡补换后跨省业务配置没有同步完成。',
    l0: { status: 'resolved', priority: 'medium', region: '浙江' },
    matchFragments: [],
  },
]

const fixtureNode = {
  id: 'browser-fixture-node',
  type: 'ticket-candidates',
  data: {
    retrievalId: 'retrieval-browser-fixture',
    version: 7,
    querySummary: '查找副卡和跨域有关工单',
    fastQuery: {
      schemaVersion: 1,
      source: 'direct_user',
      rewriteApplied: false,
      keyword: { terms: ['副卡', '跨域'], operator: 'and' },
      vector: { text: '查找副卡和跨域有关工单' },
    },
    queryLogic: {
      operator: 'and',
      requiredConcepts: [
        { surface: '副卡', canonical: '副卡', alternatives: ['副卡'] },
        { surface: '跨域', canonical: '跨域', alternatives: ['跨域', '省外'] },
      ],
    },
    snapshotShortId: 'snap-bf27',
    completeness: 'bounded',
    status: 'results',
    exportEnabled: true,
    candidates,
    alreadyReadEvidence: [
      {
        evidenceId: 'evidence-tkt-0029-answer-0000000000000001',
        candidateRef: 'candidate-tkt-0007',
        displayId: 'TKT-0007',
        sourceVersion: 'legacy-smoke-v1',
        contentHash: 'evidence-hash',
        field: 'answer',
        text: '刷新套餐成员关系并重新计算共享流量后恢复正常。',
        start: 0,
        end: 24,
        estimatedTokens: 16,
        trust: 'untrusted_ticket_evidence',
        truncated: false,
      },
    ],
    detailFields: [
      { key: 'problemDescription', label: '问题描述' },
      { key: 'resolutionSteps', label: '处理步骤' },
    ],
    result: {
      type: 'ticket_collection',
      schemaVersion: 1,
      retrievalId: 'retrieval-browser-fixture',
      packId: 'pack-browser-fixture',
      query: '查找副卡和跨域有关工单',
      target: 'ranked_cases',
      snapshotShortId: 'snap-bf27',
      stoppingReason: 'top_k_accepted',
      complete: false,
      decisionFinalized: true,
      topKAccepted: true,
      resultPagesExhausted: true,
      semanticRecallKnown: false,
      resultMayBeIncomplete: true,
      nextPageAvailable: false,
      tickets: candidates,
      evidence: [],
      remainingGapKinds: [],
    },
  },
}

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (new URL(url, window.location.href).pathname !== '/api/retrieval-agent/detail') return await nativeFetch(input, init)
  const params = JSON.parse(String(init?.body)) as { candidateRefs: string[] }
  const candidate = candidates.find(item => item.ref === params.candidateRefs[0])
  if (candidate === undefined) return new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: '候选不可访问。', retryable: false }), { status: 403 })
  return new Response(JSON.stringify({
    details: [{
      candidateRef: candidate.ref,
      displayId: candidate.displayId,
      sourceVersion: candidate.sourceVersion,
      title: candidate.title,
      summary: candidate.ref === 'candidate-tkt-0007'
        ? '副卡离开归属省后无法建立数据连接，本地使用正常，需要核查跨域漫游配置。'
        : '异地补换副卡成功后语音恢复，但数据业务仍未同步，用于验证窄屏信息密度。',
      l0: candidate.l0,
      fields: {
        problemDescription: ['副卡在归属地使用正常，进入省外网络后无法建立数据连接。'],
        resolutionSteps: ['重新同步副卡跨域漫游权限并刷新数据业务配置，复测恢复。'],
      },
      unavailableFields: [],
    }],
    rejectedCandidateRefs: [],
    warnings: [],
    receipt: { readId: 'fixture-read', retrievalId: 'retrieval-browser-fixture' },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const fixtureProps = { node: fixtureNode, sessionId: 'browser-fixture-session' } as unknown as CandidatePanelProps

function BrowserFixture() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', dark)
  }, [dark])
  return (
    <main className="fixture-page">
      <aside className="fixture-notice">
        <span>组件验收夹具</span>
        <span aria-hidden="true">·</span>
        <span>真实产品保留原始 DSH Web 外壳</span>
        <button type="button" aria-pressed={dark} onClick={() => { setDark(value => !value) }}>
          {dark ? '浅色' : '深色'}
        </button>
      </aside>
      <div className="fixture-column"><CandidatePanel {...fixtureProps} /></div>
    </main>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('browser fixture root is missing')
createRoot(root).render(<StrictMode><BrowserFixture /></StrictMode>)
