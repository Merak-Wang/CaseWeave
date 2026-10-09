import { describe,expect,it } from 'vitest'
import {rankRewriteHits} from './recall.js'
import type {MilvusHit} from './milvus.js'
const hit=(ticket_id:string,distance:number,id=ticket_id):MilvusHit=>({ticket_id,distance,id,content_hash:'synthetic',source_version:'v1',field:'summary',part:0,start:0,end:1,text_hash:'synthetic'})
describe('real database rewrite ranking helper',()=>{
 it('updates higher later dense hits and is invariant to duplicate, completion and input ordering',()=>{
  const rows=[{hit:hit('a',.1),source:'original'},{hit:hit('a',.9),source:'rewrite'},{hit:hit('b',.8),source:'original'}]
  const expected=rankRewriteHits(rows)
  expect(expected).toEqual(rankRewriteHits([...rows.reverse(),...rows]))
  expect(expected[0]?.hit.distance).toBe(.9)
  expect(expected[0]?.sources).toEqual(['original','rewrite'])
 })
 it('shares tied source ranks and breaks equally scored chunk identity deterministically',()=>{
  expect(rankRewriteHits([{hit:hit('a',.9,'z'),source:'x'},{hit:hit('a',.9,'a'),source:'x'},{hit:hit('b',.9),source:'x'}]).map(r=>[r.hit.id,r.rank])).toEqual([['a',1],['b',1]])
 })
})
