import { describe, expect, it, vi } from 'vitest'
import { SpacyQueryAnalyzer } from '@retrieval-agent/query-understanding'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function analysis(requestId: string, query: string, keyword: string): unknown {
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
})
