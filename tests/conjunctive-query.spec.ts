import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { compileDirectTicketQuery } from '@retrieval-agent/query-understanding'

const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo',
  subjectId: 'support-user',
  entitlementVersion: 'development-v1',
  purpose: 'ticket_retrieval',
  attributes: { role: ['support'] },
  issuedAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-09-02T00:00:00.000Z',
}

function ticket(ticketId: string, title: string) {
  return normalizeFixtureTicket({
    ticketId,
    displayId: ticketId,
    title,
    summary: title,
    tenantId: 'demo',
    allowedSubjectIds: [],
    requiredAttributes: { role: ['support'] },
    sourceVersion: 'conjunction-fixture-v1',
    conversationOrUpdates: [],
    resolutionSteps: [],
    errorCodes: [],
    piiRedactionStatus: 'redacted',
    language: 'zh',
  })
}

describe('direct-user conjunctive query path', () => {
  it('preserves the original query and returns only tickets satisfying both concepts', async () => {
    const provider = new LocalTicketProvider([
      ticket('TKT-0027', '副卡新增订单失败'),
      ticket('TKT-0005', '一号多卡业务切换后副卡异常'),
      ticket('TKT-0007', '副卡在省外漫游无法上网'),
    ], { now: () => new Date('2026-09-01T01:00:00.000Z') })
    const request = compileDirectTicketQuery('查找副卡和跨域有关工单')
    const spec = provider.resolve(request)
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    const page = await provider.search(PRINCIPAL, snapshot.snapshotId, spec, {
      topK: 20,
      maxScan: 100,
      stage: 'initial_hybrid',
    })

    expect(request.queryContract?.original).toBe('查找副卡和跨域有关工单')
    expect(spec.requiredConcepts?.map(concept => concept.canonical)).toEqual(['副卡', '跨域'])
    expect(page.candidates.map(candidate => candidate.displayId)).toEqual(['TKT-0007'])
  })
})
