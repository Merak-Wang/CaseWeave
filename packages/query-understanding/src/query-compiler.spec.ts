import { describe, expect, it } from 'vitest'
import { compileDirectTicketQuery } from './query-compiler.js'

const NOW = new Date('2026-08-29T00:00:00.000Z')

describe('direct ticket query compiler', () => {
  it('extracts an explicit count and removes interaction wording from retrieval text', () => {
    expect(compileDirectTicketQuery('帮我找三条副卡解绑后流量仍共享的工单', { now: () => NOW })).toMatchObject({
      target: 'ranked_cases',
      query: '帮我找三条副卡解绑后流量仍共享的工单',
      retrievalQuery: '副卡解绑后流量仍共享',
      retrievalIntent: 'analogous_case',
      requestedCount: 3,
      countPolicy: 'explicit',
      filters: [],
      ambiguities: [],
    })
  })

  it('extracts typed filters, a relative date, and uses an adaptive upper bound', () => {
    expect(compileDirectTicketQuery('查找最近一个月广东地区高优先级已解决的5G套餐无法变更工单', {
      adaptiveMaxResults: 12,
      now: () => NOW,
    })).toMatchObject({
      target: 'constrained_list',
      retrievalQuery: '5G套餐无法变更',
      requestedCount: 12,
      countPolicy: 'adaptive',
      filters: [
        { field: 'region', op: 'eq', value: '广东' },
        { field: 'status', op: 'eq', value: '已解决' },
        { field: 'priority', op: 'eq', value: '高' },
        { field: 'createdAt', op: 'gte', value: '2026-07-30' },
      ],
    })
  })

  it('recognizes result-set and resolution goals without inventing a fixed count', () => {
    expect(compileDirectTicketQuery('收集所有副卡共享流量异常工单', { adaptiveMaxResults: 20, now: () => NOW })).toMatchObject({
      target: 'cohort_collection',
      countPolicy: 'adaptive',
    })
    expect(compileDirectTicketQuery('历史上如何解决云盘会员套餐变更后权益丢失', { now: () => NOW })).toMatchObject({
      target: 'resolution_path',
      retrievalQuery: '历史上 云盘会员套餐变更后权益丢失',
    })
  })

  it('surfaces unresolved references instead of silently treating them as standalone facts', () => {
    expect(compileDirectTicketQuery('查找这类问题的工单', { now: () => NOW }).ambiguities).toEqual([
      { kind: 'reference', text: '查询包含依赖会话上下文的指代。' },
    ])
  })
})
