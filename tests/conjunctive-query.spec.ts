import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { buildFastTicketRequest, SpacyQueryAnalyzer } from '@retrieval-agent/query-understanding'
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

describe('direct-user topic recall and explicit Boolean query path', () => {
  it('keeps tickets from every region when NER identifies a customer location rather than a ticket filter', async () => {
    const provider = new LocalTicketProvider([
      { ...ticket('BEIJING', '用户不在北京时副卡办理失败'), region: '北京' },
      { ...ticket('SHANGHAI', '用户不在北京时副卡办理失败'), region: '上海' },
    ], { now: () => new Date('2026-09-01T01:00:00.000Z'), ranker: testHybridRanker(), defaultMode: 'hybrid' })
    const query = '查找用户不在北京时副卡办理失败的工单'
    const analyzer = new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      const parsed = await fixtureQueryAnalyzer(['副卡']).analyze(input.query)
      const start = input.query.indexOf('北京')
      return Response.json({ ...parsed, requestId: input.requestId, entities: [{ text: '北京', label: 'GPE', start, end: start + 2 }] })
    } })
    const request = await buildFastTicketRequest(query, { analyzer })
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    const page = await provider.search(PRINCIPAL, snapshot.snapshotId, provider.resolve(request), { topK: 20, maxScan: 100, stage: 'initial_hybrid' })
    expect(page.candidates.map(candidate => candidate.displayId).sort()).toEqual(['BEIJING', 'SHANGHAI'])
    expect(request.filters).toEqual([])
    expect(request.queryContract?.constraints).toEqual([])
    expect(request.queryContract?.queryPlan?.hard).toEqual({ kind: 'constant', value: true })
  })

  it.each(['or', 'and'] as const)('uses %s keyword recall alongside vector Top-K from the unmodified original query', async operator => {
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
    const query = operator === 'or' ? '查找副卡和跨域有关工单' : '查找必须同时包含副卡和跨域的工单'
    const request = await buildFastTicketRequest(query, {
      analyzer: fixtureQueryAnalyzer(['副卡', '跨域'], 'and'),
    })
    const spec = provider.resolve(request)
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    const page = await provider.search(PRINCIPAL, snapshot.snapshotId, spec, {
      topK: 20,
      maxScan: 100,
      stage: 'initial_hybrid',
    })

    expect(request.queryContract?.original).toBe(query)
    expect(spec.requiredConcepts?.map(concept => concept.canonical)).toEqual(['副卡', '跨域'])
    expect(request.fastQuery).toMatchObject({
      rewriteApplied: false,
      keyword: { terms: ['副卡', '跨域'], operator },
      vector: { text: query },
    })
    expect(page.candidates.map(candidate => candidate.displayId)).toEqual(expect.arrayContaining([
      'TKT-0027', 'TKT-0005', 'TKT-0007', 'TKT-0031',
    ]))
    expect(page.boundary).toMatchObject({
      authorizedCorpusSize: 4,
      documentsAfterStructuredFilters: 4,
      documentsEligibleForKeywordChannel: operator === 'or' ? 4 : 1,
      rankedHits: 4,
      resultPagesExhausted: true,
      semanticRecallKnown: false,
    })
    expect(page.trace.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'keyword', querySource: 'direct_user_keywords', resultCount: operator === 'or' ? 4 : 1 }),
      expect.objectContaining({ channel: 'vector', querySource: 'direct_user_original', resultCount: 4 }),
    ]))
    expect(page.candidates.find(candidate => candidate.displayId === 'TKT-0031')?.matchSignals?.channels)
      .toContain('keyword')
    expect(page.candidates.find(candidate => candidate.displayId === 'TKT-0007')?.matchSignals?.channels)
      .toContain('vector')
  })
})
