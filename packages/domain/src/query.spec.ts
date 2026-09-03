import { describe, expect, it } from 'vitest'
import type { TicketRetrievalSpec } from '@retrieval-agent/contracts'
import { applyQueryDelta } from './query.js'

function baseSpec(): TicketRetrievalSpec {
  return {
    target: 'constrained_list',
    originalQuery: '最近两个月华东地区已解决的副卡工单',
    normalizedQuery: '副卡',
    countPolicy: 'exhaustive',
    mode: 'hybrid',
    filters: [],
    keywordQuery: { terms: ['副卡'], operator: 'and' },
    ambiguities: [],
    excludedTerms: [],
    semanticHints: [],
    compilerVersion: 'test-v1',
  }
}

describe('applyQueryDelta', () => {
  it('applies several structured conditions atomically and preserves both time bounds', () => {
    const result = applyQueryDelta(baseSpec(), {
      kind: 'batch',
      changes: [
        { kind: 'add_filter', filter: { field: 'createdAt', op: 'gte', value: '2026-07-01T00:00:00.000Z' } },
        { kind: 'add_filter', filter: { field: 'createdAt', op: 'lte', value: '2026-09-01T00:00:00.000Z' } },
        { kind: 'add_filter', filter: { field: 'status', op: 'eq', value: 'resolved' } },
        { kind: 'add_filter', filter: { field: 'region', op: 'eq', value: '华东' } },
      ],
    })

    expect(result.filters).toEqual([
      { field: 'createdAt', op: 'gte', value: '2026-07-01T00:00:00.000Z' },
      { field: 'createdAt', op: 'lte', value: '2026-09-01T00:00:00.000Z' },
      { field: 'status', op: 'eq', value: 'resolved' },
      { field: 'region', op: 'eq', value: '华东' },
    ])
  })

  it('replaces one range endpoint without discarding the other endpoint', () => {
    const withRange = applyQueryDelta(baseSpec(), {
      kind: 'batch',
      changes: [
        { kind: 'add_filter', filter: { field: 'createdAt', op: 'gte', value: '2026-07-01T00:00:00.000Z' } },
        { kind: 'add_filter', filter: { field: 'createdAt', op: 'lte', value: '2026-09-01T00:00:00.000Z' } },
      ],
    })
    const result = applyQueryDelta(withRange, {
      kind: 'add_filter',
      filter: { field: 'createdAt', op: 'gte', value: '2026-08-01T00:00:00.000Z' },
    })

    expect(result.filters).toEqual([
      { field: 'createdAt', op: 'lte', value: '2026-09-01T00:00:00.000Z' },
      { field: 'createdAt', op: 'gte', value: '2026-08-01T00:00:00.000Z' },
    ])
  })

  it('rejects an empty batch and an inverted date range without mutating the source spec', () => {
    const source = baseSpec()

    expect(() => applyQueryDelta(source, { kind: 'batch', changes: [] })).toThrow('1–8')
    expect(() => applyQueryDelta(source, {
      kind: 'batch',
      changes: [
        { kind: 'add_filter', filter: { field: 'createdAt', op: 'gte', value: '2026-09-01T00:00:00.000Z' } },
        { kind: 'add_filter', filter: { field: 'createdAt', op: 'lte', value: '2026-07-01T00:00:00.000Z' } },
      ],
    })).toThrow('起始时间不能晚于结束时间')
    expect(source.filters).toEqual([])
  })
})
