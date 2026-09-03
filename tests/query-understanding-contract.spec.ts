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

  it('keeps detailed business conditions out of the spaCy first-pass contract', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; query: string }
      return response(analysis(request.requestId, request.query, '副卡'))
    })
    const request = await buildFastTicketRequest('查找最近两个月华东地区已解决的副卡工单', {
      analyzer: new SpacyQueryAnalyzer({ baseUrl: 'http://127.0.0.1:8012', fetch }),
    })

    expect(request.queryContract?.constraints).toEqual([])
    expect(request).not.toHaveProperty('filters')
    expect(request.fastQuery?.keyword?.terms).toEqual(['副卡'])
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
