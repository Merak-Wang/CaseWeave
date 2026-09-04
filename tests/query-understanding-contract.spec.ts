import { describe, expect, it, vi } from 'vitest'
import { assertTicketRetrievalRequest } from '@retrieval-agent/contracts'
import { buildFastTicketRequest, SpacyQueryAnalyzer } from '@retrieval-agent/query-understanding'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function analysis(requestId: string, query: string, keyword: string, requestedCount?: number): unknown {
  const start = query.indexOf(keyword)
  return {
    protocolVersion: 'retrieval-agent.models.v1',
    requestId,
    analyzer: {
      engine: 'spacy',
      engineVersion: '3.8.7',
      pipeline: 'zh_core_web_sm-3.8.0',
      pipelineVersion: '3.8.0',
      lexiconVersion: 'telecom-query-phrases-v1',
      loaded: true,
      components: ['tagger', 'parser'],
    },
    language: 'zh',
    keywords: [keyword],
    candidates: [{ text: keyword, start, end: start + keyword.length, source: 'pos', pos: ['NOUN'] }],
    tokens: [{
      text: keyword,
      start,
      end: start + keyword.length,
      lemma: keyword,
      pos: 'NOUN',
      tag: 'NN',
      dep: 'ROOT',
      head: 0,
      isStop: false,
      entityType: '',
    }],
    entities: [],
    triples: [],
    ...(requestedCount === undefined ? {} : { requestedCount }),
    elapsedMs: 1,
  }
}

describe('query-analysis HTTP contract', () => {
  it('accepts an exact surface term returned by the FastAPI protocol', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '网络'))
    })

    const result = await new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch })
      .analyze('查找网络故障工单')

    expect(result.keywords).toEqual(['网络'])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects a keyword that was rewritten outside the direct-user query', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, '宽带故障', '宽带'))
    })

    await expect(new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch })
      .analyze('查找网络故障工单'))
      .rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  })

  it('keeps an omitted quantity adaptive without turning the page size into a result cap', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '主卡'))
    })
    const analyzer = new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch })

    const request = await buildFastTicketRequest('帮我找找主卡有关工单', {
      analyzer,
    })

    expect(request).toMatchObject({
      target: 'ranked_cases',
      countPolicy: 'adaptive',
      queryContract: { task: 'ranked_cases', resultPolicy: 'adaptive_top_k' },
    })
    expect(request.queryContract).not.toHaveProperty('maxResults')
    expect(request.queryContract).not.toHaveProperty('resultLimit')
    expect(request).not.toHaveProperty('requestedCount')
    expect(request.fastQuery?.keyword?.terms).toEqual(['主卡'])
  })

  it('compiles explicit conditions and preserves unsupported boundaries on the first pass', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '副卡'))
    })
    const request = await buildFastTicketRequest('查找最近两个月华东地区已解决的副卡工单', {
      analyzer: new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch }),
      now: new Date('2026-09-03T00:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
    })

    expect(request.filters).toEqual(expect.arrayContaining([
      { field: 'status', op: 'eq', value: '已解决' },
      { field: 'createdAt', op: 'gte', value: '2026-07-02T16:00:00.000Z' },
      { field: 'createdAt', op: 'lte', value: '2026-09-03T00:30:00.000Z' },
    ]))
    expect(request.filters).not.toContainEqual(expect.objectContaining({ field: 'region' }))
    expect(request.ambiguities).toContainEqual(expect.objectContaining({ kind: 'constraint', text: expect.stringContaining('华东地区') }))
    expect(request.queryContract?.constraints).toEqual(request.filters)
    expect(request.queryContract?.ambiguities).toEqual(request.ambiguities)
    expect(request.fastQuery?.keyword?.terms).toEqual(['副卡'])
    expect(() => assertTicketRetrievalRequest(request)).not.toThrow()
  })

  it('keeps explicit date, region, status, and ticket identity as sourced user requirements', async () => {
    const rawQuery = '查找上海 2026-08-01 至 2026-08-31 已解决的工单，工单号 TKT-0029'
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '工单'))
    })
    const request = await buildFastTicketRequest(rawQuery, {
      analyzer: new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch }), timeZone: 'Asia/Shanghai',
    })
    expect(request.filters).toEqual(expect.arrayContaining([
      { field: 'region', op: 'eq', value: '上海' },
      { field: 'status', op: 'eq', value: '已解决' },
      { field: 'displayId', op: 'eq', value: 'TKT-0029' },
      { field: 'createdAt', op: 'gte', value: '2026-07-31T16:00:00.000Z' },
      { field: 'createdAt', op: 'lte', value: '2026-08-31T15:59:59.999Z' },
    ]))
    expect(request.queryContract?.userRequirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '上海', status: 'compiled', filters: [{ field: 'region', op: 'eq', value: '上海' }] }),
      expect.objectContaining({ text: '已解决', status: 'compiled' }),
    ]))
    expect(request.retrievalIntent).toBe('known_item')
    expect(request.fastQuery?.vector.text).toBe(rawQuery)
    expect(() => assertTicketRetrievalRequest(request)).not.toThrow()
  })

  it('accepts a user result target greater than transport page widths', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '主卡', 150))
    })
    const request = await buildFastTicketRequest('查找 150 个主卡工单', {
      analyzer: new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch }),
    })
    expect(request).toMatchObject({ requestedCount: 150, countPolicy: 'explicit', queryContract: { resultLimit: 150 } })
    expect(() => assertTicketRetrievalRequest(request)).not.toThrow()
  })

  it('does not turn a duration classifier or an unsupported time boundary into a result count', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      // An old analyzer used CARDINAL + classifier and reported 两个月 as a result target.
      return response(analysis(request.requestId, request.query, '主卡', 2))
    })
    const analyzer = new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch })
    const duration = await buildFastTicketRequest('最近两个月的主卡工单', { analyzer })
    expect(duration).toMatchObject({ countPolicy: 'adaptive' })
    expect(duration).not.toHaveProperty('requestedCount')
    const vague = await buildFastTicketRequest('近期主卡工单', { analyzer })
    expect(vague.queryContract?.userRequirements).toContainEqual(expect.objectContaining({ text: '近期', status: 'unresolved', filters: [] }))
    expect(vague.filters).toEqual([])
  })

  it('keeps nearby regions and invalid dates unresolved without inverting excluded conditions', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '工单'))
    })
    const analyzer = new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch })
    const uncertain = await buildFastTicketRequest('上海附近 2026-02-30 的工单', { analyzer })
    expect(uncertain.filters).toEqual([])
    expect(uncertain.ambiguities?.map(item => item.text).join(' ')).toMatch(/日历日期/u)
    expect(uncertain.queryContract?.userRequirements).toContainEqual(expect.objectContaining({ text: '上海', status: 'unresolved' }))
    const excluded = await buildFastTicketRequest('不要上海、不要已解决的工单', { analyzer })
    expect(excluded.filters).toEqual(expect.arrayContaining([
      { field: 'region', op: 'neq', value: '上海' }, { field: 'status', op: 'neq', value: '已解决' },
    ]))
    const excludedDates = await buildFastTicketRequest('排除2026-08-01之后的工单', { analyzer })
    expect(excludedDates.filters).toEqual([])
    expect(excludedDates.queryContract?.userRequirements).toContainEqual(expect.objectContaining({
      text: '2026-08-01', status: 'unresolved', filters: [],
    }))
  })

  it('preserves an ambiguous quantity and rejects an unrepresentable exact target', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '工单'))
    })
    const analyzer = new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch })
    const vague = await buildFastTicketRequest('找三五条工单', { analyzer })
    expect(vague).not.toHaveProperty('requestedCount')
    expect(vague.queryContract?.userRequirements).toContainEqual(expect.objectContaining({ text: '三五条', status: 'unresolved' }))
    await expect(buildFastTicketRequest('找 9007199254740992 条工单', { analyzer })).rejects.toThrow(/正安全整数/u)
  })

  it('classifies the task independently from adaptive, explicit, and exhaustive result policies', async () => {
    const requestedCounts = new Map<string, number>([['帮我找 5 个主卡有关工单', 5]])
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '主卡', requestedCounts.get(request.query)))
    })
    const analyzer = new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch })

    const adaptiveCollection = await buildFastTicketRequest('列出主卡有关工单', { analyzer })
    const explicitRanked = await buildFastTicketRequest('帮我找 5 个主卡有关工单', { analyzer })
    const exhaustiveRanked = await buildFastTicketRequest('帮我找所有主卡有关工单', { analyzer })
    const notExhaustive = await buildFastTicketRequest('不要返回全部主卡工单', { analyzer })

    expect(adaptiveCollection).toMatchObject({
      target: 'cohort_collection', countPolicy: 'adaptive',
      queryContract: { task: 'cohort_collection', resultPolicy: 'adaptive_top_k' },
    })
    expect(explicitRanked).toMatchObject({
      target: 'ranked_cases', requestedCount: 5, countPolicy: 'explicit',
      queryContract: { task: 'ranked_cases', resultPolicy: 'explicit_top_k', resultLimit: 5 },
    })
    expect(exhaustiveRanked).toMatchObject({
      target: 'ranked_cases', countPolicy: 'exhaustive',
      queryContract: { task: 'ranked_cases', resultPolicy: 'exhaustive_current_snapshot' },
    })
    expect(exhaustiveRanked).not.toHaveProperty('requestedCount')
    expect(notExhaustive).toMatchObject({ countPolicy: 'adaptive' })
    expect(notExhaustive).not.toHaveProperty('requestedCount')
  })

  it('keeps a language-independent dense fast path when no surface keyword is usable', async () => {
    const rawQuery = 'same semantic issue in another language'
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response({
        protocolVersion: 'retrieval-agent.models.v1',
        requestId: request.requestId,
        analyzer: {
          engine: 'spacy', engineVersion: '3.8.7', pipeline: 'zh_core_web_sm-3.8.0',
          pipelineVersion: '3.8.0', lexiconVersion: 'telecom-query-phrases-v1',
          loaded: true, components: ['tagger', 'parser'],
        },
        language: 'en', keywords: [], candidates: [], tokens: [], entities: [], triples: [], elapsedMs: 1,
      })
    })
    const analyzer = new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch })

    const request = await buildFastTicketRequest(rawQuery, { analyzer })

    expect(() => assertTicketRetrievalRequest(request)).not.toThrow()
    expect(request.queryContract).toMatchObject({
      language: 'en', fastQuery: { schemaVersion: 2, vector: { text: rawQuery } },
    })
    expect(request.fastQuery).not.toHaveProperty('keyword')
    expect(request.queryContract?.nlp?.keywordTerms).toEqual([])
  })
})
