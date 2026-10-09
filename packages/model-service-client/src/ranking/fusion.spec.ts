import { describe,expect,it } from 'vitest'
import { fuseRankingHits,rankSourceHits } from './fusion.js'
describe('global RRF loss regressions',()=>{
 it('keeps later higher cosine, is independent of completion order and repeated rewrites',()=>{
  const k=[{documentId:'a',score:2},{documentId:'b',score:2}]
  const d=[{documentId:'a',score:.1},{documentId:'a',score:.9},{documentId:'b',score:.8}]
  const actual=fuseRankingHits(k,d)
  expect(actual).toEqual(fuseRankingHits(k.reverse(),[...d.reverse(),...d]))
  expect(actual[0]?.documentId).toBe('a')
  expect(actual[0]?.dense_raw).toBe(.9)
  expect(actual.map(h=>h.channels[0]?.rank)).toEqual([1,1])
  expect(actual[0]?.channels).toHaveLength(2)
 })
 it('makes one globally ranked source and does not give ties arrival ranks',()=>{
  expect(rankSourceHits([{documentId:'c',score:1},{documentId:'a',score:2},{documentId:'b',score:2},{documentId:'a',score:1}])).toEqual([{documentId:'a',score:2,rank:1},{documentId:'b',score:2,rank:1},{documentId:'c',score:1,rank:3}])
 })
 it('keeps dense only candidates on the same fused scale as overlap',()=>{
  const actual=fuseRankingHits([{documentId:'a',score:2}],[{documentId:'d',score:.99},{documentId:'a',score:.1}])
  expect(actual.map(h=>h.documentId)).toEqual(['a','d'])
  expect(actual[1]?.score).toBeCloseTo(.45/61)
 })
})
