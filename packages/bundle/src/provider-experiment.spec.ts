import {Context} from '@deepseek-ai/cordis'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe,expect,it,vi} from 'vitest'
import {testHybridRanker} from '../../../tests/support/fake-model-gateway.js'
import type {RankingDocument,RetrievalRanker} from '@retrieval-agent/model-service-client/ranking'
const probes=vi.hoisted(()=>({ranking:undefined as undefined | {documentProjection?:string;lexicalRanker?:RetrievalRanker},migrations:0}))
vi.mock('@retrieval-agent/provider-database',()=>({
 TicketDatabase:class{async migrate(){probes.migrations++}async publication(){return {}}async close(){}},
 MilvusClient:class{},
 DatabaseTicketProvider:class{providerId='synthetic-db';constructor(_db:unknown,_milvus:unknown,_model:unknown,_dataset:unknown,_topK:unknown,ranking:typeof probes.ranking){probes.ranking=ranking}},
}))
import {LocalTicketProviderService} from './provider.js'
import {FixturePrincipalProviderService} from './principal.js'
function capturedRanking():{documentProjection?:string;lexicalRanker?:RetrievalRanker}|undefined{return probes.ranking}
const fixture=resolve(dirname(fileURLToPath(import.meta.url)),'../../../data/tickets/synthetic/legacy-bronze-v1.jsonl')
describe('actual bundle experimental configuration consumers',()=>{
 it('passes canonical title+abstract into the real JSONL preparation consumer',async()=>{
  const base=testHybridRanker();let prepared:readonly RankingDocument[]=[]
  const ranker:RetrievalRanker={profileVersion:base.profileVersion,capabilities:base.capabilities,rank:base.rank.bind(base),async prepare(documents){prepared=documents;return base.prepare!(documents)}}
  const ctx=new Context()
  try{
   await ctx.plugin(FixturePrincipalProviderService,{tenantId:'demo',subjectId:'development-admin',entitlementVersion:'1',groups:['admin'],regions:['cn'],developmentAdmin:true})
   await ctx.plugin(LocalTicketProviderService,{dataPath:fixture,retrievalMode:'hybrid',embeddingRevision:'synthetic-pinned',documentProjection:'canonical-title-abstract-v1',ranker})
   const principal=await ctx.ticketPrincipalProvider.resolve({sessionId:'synthetic',operation:'snapshot_open'})
   await ctx.ticketRetrievalProvider.openSnapshot(principal)
   expect(prepared.length).toBeGreaterThan(0)
   expect(prepared.every(d=>d.title.trim().length>0&&d.summary.trim().length>0&&d.body===''&&d.metadata==='')).toBe(true)
  }finally{await ctx.fiber.dispose()}
 })
 it('injects a real keyword-only BM25 adapter into the DB experiment, while literal baseline stays explicit',async()=>{
  for(const lexicalRanking of ['bm25f','literal_set'] as const){
   probes.ranking=undefined
   const ctx=new Context()
   try{
    await ctx.plugin(LocalTicketProviderService,{storageBackend:'mysql_milvus',dataPath:'unused-synthetic',documentProjection:'canonical-title-abstract-v1',lexicalRanking})
    expect(capturedRanking()?.documentProjection).toBe('canonical-title-abstract-v1')
    if(lexicalRanking==='bm25f'){
     expect(capturedRanking()?.lexicalRanker?.documentProjection).toBe('canonical-title-abstract-v1')
     expect(capturedRanking()?.lexicalRanker?.capabilities).toMatchObject({keyword:true,dense:false})
    }else expect(capturedRanking()?.lexicalRanker).toBeUndefined()
   }finally{await ctx.fiber.dispose()}
  }
 })
})
