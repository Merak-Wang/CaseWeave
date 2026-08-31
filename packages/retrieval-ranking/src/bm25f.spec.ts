import { describe, expect, it } from 'vitest'
import { Bm25fIndex } from './bm25f.js'
import type { RankingDocument } from './types.js'

function document(id: string, title: string, summary = '', body = '', metadata = ''): RankingDocument {
  return { id, contentHash: `hash-${id}`, title, summary, body, metadata }
}

describe('Bm25fIndex', () => {
  it('applies field weights and returns stable ranks', () => {
    const index = new Bm25fIndex([
      document('title-hit', 'alpha'),
      document('body-hit', '', '', 'alpha'),
      document('miss', 'bravo'),
    ])

    const result = index.search('alpha')

    expect(result.hits.map(hit => hit.documentId)).toEqual(['title-hit', 'body-hit'])
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score)
    expect(result.hits.map(hit => hit.rank)).toEqual([1, 2])
  })

  it('tokenizes Chinese bigrams and enforces excluded terms', () => {
    const index = new Bm25fIndex([
      document('allowed', '主副卡解绑后仍共享流量'),
      document('excluded', '主副卡解绑失败', '仅限海外套餐'),
    ])

    expect(index.search('解绑共享').hits.map(hit => hit.documentId)).toContain('allowed')
    expect(index.search('主副卡解绑', ['海外']).hits.map(hit => hit.documentId)).toEqual(['allowed'])
  })

  it('uses document id as the deterministic tie breaker', () => {
    const result = new Bm25fIndex([
      document('b', 'same'),
      document('a', 'same'),
    ]).search('same')

    expect(result.hits.map(hit => hit.documentId)).toEqual(['a', 'b'])
  })
})
