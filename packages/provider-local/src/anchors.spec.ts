import {describe,expect,it} from 'vitest'
import type {TrustedPrincipalContext} from '@retrieval-agent/contracts'
import type {RetrievalRanker} from '@retrieval-agent/model-service-client/ranking'
import {LocalTicketProvider} from './provider.js'
import {normalizeFixtureTicket} from './fixture.js'
const user:TrustedPrincipalContext={tenantId:'synthetic',subjectId:'reader',entitlementVersion:'v1',purpose:'ticket_retrieval',attributes:{},issuedAt:'2026-10-08T00:00:00Z'}
const row=normalizeFixtureTicket({ticketId:'s',displayId:'s',title:'alpha',summary:'abstract',tenantId:'synthetic',sourceVersion:'v1',allowedSubjectIds:[],requiredAttributes:{},conversationOrUpdates:[],resolutionSteps:[],errorCodes:[],piiRedactionStatus:'not_applicable'})
describe('real Local feature-anchor consumer',()=>{
 it('binds actual completed scope identity and refuses caller identity before invoking anchor RPC',async()=>{
  let anchorCalls=0
  const ranker:RetrievalRanker={profileVersion:'controlled',documentProjection:'canonical-title-abstract-v1',capabilities:{keyword:true,dense:true,fusion:true,reranker:false},
   async rank(){return {hits:[{documentId:'s',score:1,rank:1,channels:[{channel:'vector',score:1,rank:1}]}],execution:{requestedMode:'dense',executedMode:'dense',strategyVersion:'controlled',channels:[]},scanned:1,keywordEligible:0,rankedHits:1,warnings:[]}},
   async readFeatureBlock(docs){return {embedding_id:'controlled-base',dimensions:2,dense:Buffer.alloc(docs.length*8).toString('base64'),available:Buffer.alloc(docs.length,1).toString('base64')}},
   async queryAnchors(texts){anchorCalls++;expect(texts).toEqual(['positive','negative']);return {embedding_id:'controlled-base',dimensions:2,vectors:[[1,0],[0,1]],profileIdentity:{model:'synthetic',normalization:'l2',projectionVersion:'canonical-title-abstract-v1'}}}
  }
  const provider=new LocalTicketProvider([row],{ranker,defaultMode:'dense',documentProjection:'canonical-title-abstract-v1'})
  const snapshot=await provider.openSnapshot(user),spec=provider.resolve({target:'ranked_cases',query:'alpha',mode:'dense'})
  const page=await provider.search(user,snapshot.snapshotId,spec,{topK:10,maxScan:10,stage:'repair_search'})
  const recallScope=page.recallScope!
  const block=await provider.featureBlock(user,{snapshotId:snapshot.snapshotId,recallScope,ids:[],limit:1})
  const request={snapshotId:snapshot.snapshotId,recallScope,featureId:'caller-fake',texts:['positive','negative']}
  await expect(provider.featureAnchors(user,request)).rejects.toMatchObject({code:'INVALID_REQUEST'})
  expect(anchorCalls).toBe(0)
  const actual=await provider.featureAnchors(user,{...request,featureId:block.feature_id})
  expect(actual.embedding_id).toBe(block.feature_id);expect(actual.feature_id).toBe(block.feature_id)
  expect(actual.vectors).toEqual([[1,0],[0,1]])
  await expect(provider.featureAnchors({...user,tenantId:'different'},{...request,featureId:block.feature_id})).rejects.toMatchObject({code:'UNAUTHORIZED'})
  expect(anchorCalls).toBe(1)
 })
})
