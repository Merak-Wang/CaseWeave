import {createHash} from 'node:crypto'
import {describe,expect,it} from 'vitest'
import {HybridRankingEngine} from './engine.js'
const stable=(v:unknown):string=>typeof v==='object'&&v!==null?'{'+Object.entries(v).sort(([a],[b])=>a<b?-1:1).map(([k,x])=>JSON.stringify(k)+':'+stable(x)).join(',')+'}':JSON.stringify(v)
describe('pinned actual anchor RPC adapter',()=>{
 it('transports two independent descriptions and rejects a forged profile identity',async()=>{
  let bad=false,seen:string[]=[]
  const engine=new HybridRankingEngine({documentProjection:'canonical-title-abstract-v1',embeddingIdentity:{model:'synthetic',revision:'v1',dimensions:2},embeddingInstruction:'retrieve',fetch:async(_url,init)=>{
   const body=JSON.parse(String(init?.body)); seen=body.texts
   expect(body.profile.documentProjection).toBe('canonical-title-abstract-v1')
   const profileIdentity={model:'synthetic',revision:'v1',dimensions:2,projectionVersion:bad?'ticket-search-projection-v1':'canonical-title-abstract-v1',normalization:'l2',pooling:'last_token',documentInstruction:null,queryInstruction:'retrieve'}
   return new Response(JSON.stringify({protocolVersion:'retrieval-agent.rag.v1',requestId:body.requestId,embedding_id:createHash('sha256').update(stable(profileIdentity)).digest('hex'),dimensions:2,vectors:[[1,0],[0,1]],profileIdentity}),{status:200})
  }})
  const actual=await engine.queryAnchors(['relevant description','irrelevant description'])
  expect(seen).toEqual(['relevant description','irrelevant description'])
  expect(actual.vectors).toEqual([[1,0],[0,1]])
  expect(engine.profileVersion).not.toBe(new HybridRankingEngine({embeddingIdentity:{model:'synthetic',revision:'v1',dimensions:2},embeddingInstruction:'retrieve'}).profileVersion)
  bad=true
  await expect(engine.queryAnchors(['positive','negative'])).rejects.toMatchObject({code:'PROTOCOL_MISMATCH'})
 })
})
