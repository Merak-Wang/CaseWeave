import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { buildFastTicketRequest } from '@retrieval-agent/query-understanding'
import { testHybridRanker } from './support/fake-model-gateway.js'
import { fixtureQueryAnalyzer } from './support/query-analyzer.js'

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
  it('unions exact AND keyword matches with vector Top-K from the unmodified original query', async () => {
    const provider = new LocalTicketProvider([
      ticket('TKT-0027', '副卡新增订单失败'),
      ticket('TKT-0005', '一号多卡业务切换后副卡异常'),
      ticket('TKT-0007', '副卡在省外漫游无法上网'),
      ticket('TKT-0031', '副卡跨域办理失败'),
    ], {
      now: () => new Date('2026-09-01T01:00:00.000Z'),
      ranker: testHybridRanker(),
      defaultMode: 'hybrid',
    })
    const request = await buildFastTicketRequest('查找副卡和跨域有关工单', {
      analyzer: fixtureQueryAnalyzer(['副卡', '跨域'], 'and'),
    })
    const spec = provider.resolve(request)
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    const page = await provider.search(PRINCIPAL, snapshot.snapshotId, spec, {
      topK: 20,
      maxScan: 100,
      stage: 'initial_hybrid',
    })

    expect(request.queryContract?.original).toBe('查找副卡和跨域有关工单')
    expect(spec.requiredConcepts?.map(concept => concept.canonical)).toEqual(['副卡', '跨域'])
    expect(request.fastQuery).toMatchObject({
      rewriteApplied: false,
      keyword: { terms: ['副卡', '跨域'], operator: 'and' },
      vector: { text: '查找副卡和跨域有关工单' },
    })
    expect(page.candidates.map(candidate => candidate.displayId)).toEqual(expect.arrayContaining([
      'TKT-0027', 'TKT-0005', 'TKT-0007', 'TKT-0031',
    ]))
    expect(page.boundary).toMatchObject({
      authorizedCorpusSize: 4,
      documentsAfterStructuredFilters: 4,
      documentsEligibleForKeywordChannel: 1,
      rankedHits: 4,
      resultPagesExhausted: true,
      semanticRecallKnown: false,
    })
    expect(page.trace.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'keyword', querySource: 'direct_user_keywords', resultCount: 1 }),
      expect.objectContaining({ channel: 'vector', querySource: 'direct_user_original', resultCount: 4 }),
    ]))
    expect(page.candidates.find(candidate => candidate.displayId === 'TKT-0031')?.matchSignals?.channels)
      .toContain('keyword')
    expect(page.candidates.find(candidate => candidate.displayId === 'TKT-0007')?.matchSignals?.channels)
      .toContain('vector')
  })
})
