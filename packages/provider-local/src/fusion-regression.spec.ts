import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { normalizeFixtureTicket } from './fixture.js'
import { LocalTicketProvider } from './provider.js'
import type { RankingResult, RetrievalRanker } from '@retrieval-agent/model-service-client/ranking'
const principal: TrustedPrincipalContext = {tenantId:'synthetic', subjectId:'reader', entitlementVersion:'1',purpose:'ticket_retrieval',attributes:{},issuedAt:'2026-10-08T00:00:00Z'}
const records=['a','b','d'].map(id=>normalizeFixtureTicket({ticketId:id,displayId:id,title:id==='d'?'other':'alpha',summary:'abstract',tenantId:'synthetic',sourceVersion:'v1',allowedSubjectIds:[],requiredAttributes:{},conversationOrUpdates:[],resolutionSteps:[],errorCodes:[],piiRedactionStatus:'not_applicable'}))
describe('real Local Provider literal ranking',()=>{
 it('executes BM25 and ranks the entire union on one RRF scale',async()=>{
  const modes:string[]=[]
  const ranker:RetrievalRanker={profileVersion:'synthetic',capabilities:{keyword:true,dense:true,fusion:true,reranker:false},async rank(_docs,q){
   modes.push(q.mode)
   const lexical=[{documentId:'a',rank:1,score:2,channels:[{channel:'keyword' as const,rank:1,score:2}]},{documentId:'b',rank:2,score:2,channels:[{channel:'keyword' as const,rank:2,score:2}]}]
   const dense=[{documentId:'d',rank:1,score:.99,channels:[{channel:'vector' as const,rank:1,score:.99}]},{documentId:'b',rank:2,score:.8,channels:[{channel:'vector' as const,rank:2,score:.8}]},{documentId:'a',rank:3,score:.1,channels:[{channel:'vector' as const,rank:3,score:.1}]}]
   return {hits:q.mode==='dense'?dense:q.mode==='keyword'?lexical:[...lexical,...dense],execution:{requestedMode:q.mode,executedMode:q.mode,strategyVersion:'synthetic',channels:[]},scanned:3,keywordEligible:2,rankedHits:3,warnings:[]} as RankingResult
  }}
  const provider=new LocalTicketProvider(records,{ranker,defaultMode:'hybrid'})
  const snapshot=await provider.openSnapshot(principal)
  const spec={...provider.resolve({target:'ranked_cases',query:'alpha',mode:'hybrid'}),keywordQuery:{terms:['alpha'],operator:'or' as const}}
  const page=await provider.search(principal,snapshot.snapshotId,spec,{topK:10,maxScan:10,stage:'repair_search'})
  expect(modes).toContain('hybrid')
  expect(page.candidates.map(c=>c.displayId)).toEqual(['b','a','d'])
 })
})


describe('existing reranker and fusion configuration stay effective',()=>{
 const run=async(reranking:boolean)=>{
  const ranker:RetrievalRanker={profileVersion:'configured',capabilities:{keyword:true,dense:true,fusion:true,reranker:reranking},
   ...(!reranking?{fusionOptions:{rankConstant:10,keywordWeight:0,vectorWeight:1}}:{}),
   async rank(_docs,q){
    const hits=[{documentId:'a',score:2,rank:1,channels:[{channel:'keyword' as const,rank:1,score:2},{channel:'vector' as const,rank:3,score:.1},...(reranking?[{channel:'reranker' as const,rank:1,score:.9}]:[])]},{documentId:'b',score:2,rank:2,channels:[{channel:'keyword' as const,rank:1,score:2},{channel:'vector' as const,rank:2,score:.8},...(reranking?[{channel:'reranker' as const,rank:2,score:.8}]:[])]},{documentId:'d',score:.99,rank:3,channels:[{channel:'vector' as const,rank:1,score:.99}]}]
    return {hits,execution:{requestedMode:q.mode,executedMode:q.mode,strategyVersion:'configured',channels:[],...(reranking?{reranker:{model:'synthetic',revision:'v1',topN:2,scoreKind:'yes_probability' as const}}:{})},scanned:3,keywordEligible:2,rankedHits:3,warnings:[]}
   }}
  const provider=new LocalTicketProvider(records,{ranker,defaultMode:'hybrid'})
  const snapshot=await provider.openSnapshot(principal)
  const spec={...provider.resolve({target:'ranked_cases',query:'alpha',mode:'hybrid'}),keywordQuery:{terms:['alpha'],operator:'or' as const}}
  return provider.search(principal,snapshot.snapshotId,spec,{topK:10,maxScan:10,stage:'repair_search'})
 }
 it('preserves explicit rank constant and channel weights',async()=>{
  const page=await run(false)
  expect(page.candidates.map(c=>c.displayId)).toEqual(['d','b','a'])
  expect(page.trace.signals[0]?.fusedScore).toBeCloseTo(1/11)
 })
 it('keeps real reranker channel and ordering after completing lexical membership',async()=>{
  const page=await run(true)
  expect(page.candidates.map(c=>c.displayId)).toEqual(['a','b','d'])
  expect(page.trace.signals[0]?.channels.some(c=>c.channel==='reranker')).toBe(true)
 })
})
