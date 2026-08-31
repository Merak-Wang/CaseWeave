import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {} from '../../packages/ui-ticket-results/src/client/definition.js'
import { CandidatePanel, type CandidatePanelProps } from '../../packages/ui-ticket-results/src/client/CandidatePanel.js'

const candidates = [
  {
    ref: 'candidate-tkt-0029',
    displayId: 'TKT-0029',
    sourceVersion: 'legacy-smoke-v1:f6950eb58e398ecabf4fecf77d529a674afa6877d0229d943a2887017dce8bc8',
    snapshotId: 'snapshot-browser-fixture',
    contentHash: 'hash-0029',
    evidenceLevel: 'L1',
    rank: 1,
    title: '主副卡解绑后流量仍然共享',
    summary: '用户完成解绑后，套餐共享关系未及时刷新，导致账务与流量显示仍然关联。',
    l0: {
      status: 'resolved', priority: 'high', category: 'account',
      additionalFields: [{ key: 'source.dataset', label: '数据集', value: 'legacy-smoke', sourcePath: 'source_dataset' }],
    },
    matchFragments: [],
  },
  {
    ref: 'candidate-tkt-0005-with-a-deliberately-long-reference',
    displayId: 'TKT-0005',
    sourceVersion: 'legacy-smoke-v1',
    snapshotId: 'snapshot-browser-fixture',
    contentHash: 'hash-0005',
    evidenceLevel: 'L1',
    rank: 2,
    title: '相似套餐关系同步问题',
    summary: '这是用于键盘展开、颜色主题和窄屏换行验证的第二条候选。',
    l0: { status: 'resolved', priority: 'medium' },
    matchFragments: [],
  },
]

const fixtureNode = {
  id: 'browser-fixture-node',
  type: 'ticket-candidates',
  data: {
    retrievalId: 'retrieval-browser-fixture',
    version: 7,
    querySummary: '主副卡解绑后仍共享流量，并验证一个不会撑破窄屏幕的很长查询条件',
    snapshotShortId: 'snap-bf27',
    completeness: 'bounded',
    status: 'results',
    exportEnabled: true,
    candidates,
    alreadyReadEvidence: [
      {
        evidenceId: 'evidence-tkt-0029-answer-0000000000000001',
        candidateRef: 'candidate-tkt-0029',
        displayId: 'TKT-0029',
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
    result: {
      type: 'ticket_collection',
      schemaVersion: 1,
      retrievalId: 'retrieval-browser-fixture',
      packId: 'pack-browser-fixture',
      query: '主副卡解绑后仍共享流量，并验证一个不会撑破窄屏幕的很长查询条件',
      target: 'ranked_cases',
      snapshotShortId: 'snap-bf27',
      stoppingReason: 'sufficient',
      complete: true,
      tickets: candidates,
      evidence: [],
      remainingGapKinds: [],
    },
  },
}
const fixtureProps = { node: fixtureNode } as unknown as CandidatePanelProps

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
