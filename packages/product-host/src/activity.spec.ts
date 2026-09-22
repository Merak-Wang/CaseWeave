import { describe, expect, it } from 'vitest'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { activityItems } from './activity.js'

const state = {} as RetrievalState
const row = (seq: number, extra = {}) => ({ seq, kind: 'retrieval/search-completed', at: '', command: null,
  action: null, channels: null, operations: null, reason: null, ...extra })

describe('committed activity projection', () => {
  it('distinguishes operator judgment commits from actual source reads, including saved history', () => {
    const items = activityItems([
      row(1, { action: { kind: 'inspect', fields: [] }, decisionOrigin: 'semantic_operator', judgmentCount: 8 }),
      row(2, { action: { kind: 'inspect', fields: [] }, operatorManifestId: 'saved-manifest', judgmentCount: 8 }),
      row(3, { action: { kind: 'inspect', fields: ['problemDescription'], candidateRefs: ['c1'] } }),
    ], state)
    expect(items.slice(0, 2).map(i => [i.actor, i.text])).toEqual([
      ['语义筛选', '已写入 8 条样本判断'], ['语义筛选', '已写入 8 条样本判断'],
    ])
    expect(items[2]).toMatchObject({ actor: '主检索 Agent', text: '读取 1 条工单依据' })
  })
  it('does not claim to be draining body pages after set discovery', () => {
    const items = activityItems([row(1, { previewOnly: true, channels: [{ channel: 'keyword', resultCount: 5474 }], loaded: 100, exhausted: false })], state)
    expect(items[0]?.text).toContain('正文按抽样需要读取')
    expect(items[0]?.text).not.toContain('正在读取结果')
  })
  it('updates one search across pages, including separately fetched activity pages', () => {
    const first = row(28, { searchSeq: 28, channels: [{ channel: 'keyword', resultCount: 5782 }], loaded: 100, exhausted: false })
    const last = row(142, { searchSeq: 28, channels: [{ channel: 'keyword', resultCount: 5782 }], loaded: 5782, exhausted: true })
    const items = activityItems([first, last], state)
    expect(items).toHaveLength(1)
    expect(items[0]?.text).toContain('已读取 5782')
    expect(items[0]?.text).toContain('枚举完成')
    expect(activityItems([first], state)[0]?.id).toBe(activityItems([last], state)[0]?.id)
    expect(activityItems([last, row(150, { ...first, seq: 150, searchSeq: 150 })], state)).toHaveLength(2)
  })
  it('shows operator failures and real learning milestones', () => {
    const items = activityItems([
      row(175, { operationName: 'sem_filter', operations: [{ path: '/operatorActivity/status', value: 'running' }] }),
      row(176, { operationName: 'sem_filter', operations: [{ path: '/operatorActivity/status', value: 'failed' }] }),
      row(178, { failure: 'Python 算子未完成：ProtocolError。' }),
      row(180, { operations: [{ path: '/budget/operatorUsage/learning/stop_reason', value: 'training' }] }),
      row(190, { operations: [{ path: '/budget/operatorUsage/learning/selected_model', value: 'dense_lr' }] }),
    ], state)
    expect(items.map(x => x.text).join('\n')).toMatch(/语义筛选.*开始[\s\S]*语义筛选.*未完成[\s\S]*ProtocolError[\s\S]*训练[\s\S]*dense_lr/u)
  })
})
