import { describe, expect, it } from 'vitest'
import { normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { ticketChunks } from './projection.js'
const ticket=()=>normalizeFixtureTicket({ticketId:'synthetic',displayId:'synthetic',tenantId:'synthetic',title:'alpha',summary:'abstract',sourceVersion:'v1',allowedSubjectIds:[],requiredAttributes:{},conversationOrUpdates:['legacy evidence'],resolutionSteps:[],errorCodes:[],piiRedactionStatus:'not_applicable'})
describe('canonical published projection',()=>{
 it('uses exactly the canonical two-field view and preserves its full tail',()=>{
  const chunks=ticketChunks({...ticket(),summary:'x'.repeat(1200)},360,'canonical-title-abstract-v1')
  expect(chunks.map(c=>c.text).join('')).toBe('【标题】alpha\n【摘要】'+'x'.repeat(1200))
  expect(chunks.every(c=>c.field==='canonical.title-abstract')).toBe(true)
 })
 it('changes fragment identity on actual content even when the upstream hash is stale',()=>{
  const original=ticket(), changed={...original,summary:'changed!'}
  expect(ticketChunks(original,360,'canonical-title-abstract-v1')[0]?.id).not.toBe(ticketChunks(changed,360,'canonical-title-abstract-v1')[0]?.id)
 })
 it('requires title and abstract, while legacy remains explicitly reachable',()=>{
  expect(()=>ticketChunks({...ticket(),summary:''},360,'canonical-title-abstract-v1')).toThrow()
  expect(ticketChunks(ticket(),360).some(c=>c.text.includes('legacy evidence'))).toBe(true)
 })
})
