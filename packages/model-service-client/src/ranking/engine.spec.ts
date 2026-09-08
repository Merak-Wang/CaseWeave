import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { HybridRankingEngine } from './engine.js'
import { RAG_SERVICE_PROTOCOL_VERSION } from './protocol.js'
import type { RankingDocument } from './types.js'

const DOCUMENTS: RankingDocument[] = [{
  id: 'allowed', contentHash: 'hash-1', title: '副卡跨域失败', summary: '办理失败', body: '', metadata: '',
}]

describe('HybridRankingEngine FastAPI adapter', () => {
  it('uses the same profile identity as the Python service', () => {
    const engine = new HybridRankingEngine({
      baseUrl: 'http://rag.test',
      embeddingIdentity: { model: 'fake-embedding', revision: 'fake-v1', dimensions: 2 },
      embeddingInstruction: 'retrieve', rerankerInstruction: 'judge', embeddingBatchSize: 16,
      modelDeadlineMs: 5_000, minimumDenseScore: 0.1, denseTopK: 15,
      fusion: { rankConstant: 60, keywordWeight: 0.55, vectorWeight: 0.45 },
      rerankerEnabled: false, rerankTopN: 20, allowKeywordFallback: false,
    })
    expect(engine.profileVersion).toBe('quick-hybrid-v1:67ff143236a8839a')
  })

  it('accepts a versioned admitted ranking response', async () => {
    let engine: HybridRankingEngine
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
        requestId: request.requestId,
        result: {
          hits: [{ documentId: 'allowed', rank: 1, score: 1, channels: [{ channel: 'keyword', rank: 1, score: 1 }] }],
          execution: {
            requestedMode: 'keyword', executedMode: 'keyword', strategyVersion: engine.profileVersion,
            channels: [{ channel: 'keyword', implementation: 'bm25f', version: 'bm25f-v1', resultCount: 1, elapsedMs: 1 }],
          },
          scanned: 1, keywordEligible: 1, rankedHits: 1, warnings: [],
        },
        elapsedMs: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    engine = new HybridRankingEngine({ baseUrl: 'http://rag.test', fetch })
    await expect(engine.rank(DOCUMENTS, {
      text: '副卡', semanticHints: [], excludedTerms: [], mode: 'keyword',
    }, { maxScan: 10 })).resolves.toMatchObject({ hits: [{ documentId: 'allowed' }] })
  })

  it('sends a fixed Dense Top-15 candidate budget to the ranking service', async () => {
    let observedDenseTopK: number | undefined
    let engine: HybridRankingEngine
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      observedDenseTopK = request.profile.denseTopK
      return new Response(JSON.stringify({
        protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
        requestId: request.requestId,
        result: {
          hits: [{ documentId: 'allowed', rank: 1, score: 1, channels: [{ channel: 'vector', rank: 1, score: 1 }] }],
          execution: {
            requestedMode: 'dense', executedMode: 'dense', strategyVersion: engine.profileVersion,
            channels: [{ channel: 'vector', implementation: 'exact_cosine', version: 'v1', resultCount: 1, elapsedMs: 1 }],
          },
          scanned: 1, keywordEligible: 1, rankedHits: 1, warnings: [],
        },
        elapsedMs: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    engine = new HybridRankingEngine({
      baseUrl: 'http://rag.test',
      embeddingIdentity: { model: 'fake-embedding', revision: 'fake-v1', dimensions: 2 },
      fetch,
    })
    await engine.rank(DOCUMENTS, {
      text: '副卡', semanticHints: [], excludedTerms: [], mode: 'dense',
    }, { maxScan: 10 })
    expect(observedDenseTopK).toBe(15)
  })

  it('rejects a service response containing an unadmitted document', async () => {
    let engine: HybridRankingEngine
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        protocolVersion: RAG_SERVICE_PROTOCOL_VERSION, requestId: request.requestId,
        result: {
          hits: [{ documentId: 'forged', rank: 1, score: 1, channels: [{ channel: 'keyword', rank: 1, score: 1 }] }],
          execution: {
            requestedMode: 'keyword', executedMode: 'keyword', strategyVersion: engine.profileVersion,
            channels: [{ channel: 'keyword', implementation: 'bm25f', version: 'v1', resultCount: 1, elapsedMs: 1 }],
          },
          scanned: 1, keywordEligible: 1, rankedHits: 1, warnings: [],
        }, elapsedMs: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    engine = new HybridRankingEngine({ baseUrl: 'http://rag.test', fetch })
    await expect(engine.rank(DOCUMENTS, {
      text: '副卡', semanticHints: [], excludedTerms: [], mode: 'keyword',
    }, { maxScan: 10 })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  })

  it('observes long preparation progress without sending or enforcing a time limit', async () => {
    let revision = 0
    let requestId = ''
    let preparationOptions: Record<string, unknown> | undefined
    const observed: number[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/v1/ranking/prepare/')) {
        revision += 1
        return new Response(JSON.stringify({
          protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
          requestId,
          progress: {
            schemaVersion: 1, phase: 'embedding', revision,
            completedDocuments: Math.min(revision, 1), totalDocuments: 1,
            resumedDocuments: 0, batchSize: 1, cacheHit: false,
            elapsedMs: revision * 10, documentsPerSecond: 1, estimatedRemainingMs: 10,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const request = JSON.parse(String(init?.body))
      requestId = request.requestId
      preparationOptions = request.options
      await new Promise(resolve => setTimeout(resolve, 70))
      return new Response(JSON.stringify({
        protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
        requestId, documentCount: 1,
        model: 'fake-embedding', revision: 'fake-v1', dimensions: 2,
        elapsedMs: 70, profileVersion: engine.profileVersion,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const engine = new HybridRankingEngine({
      baseUrl: 'http://rag.test', fetch,
      embeddingIdentity: { model: 'fake-embedding', revision: 'fake-v1', dimensions: 2 },
      preparePollIntervalMs: 5,
    })

    await expect(engine.prepare(DOCUMENTS, {
      onProgress: progress => { observed.push(progress.revision) },
    })).resolves.toMatchObject({ documentCount: 1 })
    expect(observed.length).toBeGreaterThan(1)
    expect(observed).toEqual([...observed].sort((left, right) => left - right))
    expect(preparationOptions).toEqual({ maxScan: 1 })
  })

  it('does not time out when observable progress temporarily stalls', async () => {
    let requestId = ''
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/v1/ranking/prepare/')) {
        return new Response(JSON.stringify({
          protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
          requestId,
          progress: {
            schemaVersion: 1, phase: 'embedding', revision: 1,
            completedDocuments: 0, totalDocuments: 1,
            resumedDocuments: 0, batchSize: 1, cacheHit: false,
            elapsedMs: 10, documentsPerSecond: 0, estimatedRemainingMs: null,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      requestId = JSON.parse(String(init?.body)).requestId
      await new Promise(resolve => setTimeout(resolve, 70))
      return new Response(JSON.stringify({
        protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
        requestId, documentCount: 1,
        model: 'fake-embedding', revision: 'fake-v1', dimensions: 2,
        elapsedMs: 70, profileVersion: engine.profileVersion,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const engine = new HybridRankingEngine({
      baseUrl: 'http://rag.test', fetch,
      embeddingIdentity: { model: 'fake-embedding', revision: 'fake-v1', dimensions: 2 },
      preparePollIntervalMs: 5,
    })

    await expect(engine.prepare(DOCUMENTS)).resolves.toMatchObject({ documentCount: 1 })
  })

  it('retries one transient connection reset while preparing an idempotent corpus', async () => {
    let attempts = 0
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).includes('/v1/ranking/prepare/')) {
        return new Response('', { status: 404 })
      }
      attempts += 1
      if (attempts === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        })
      }
      const request = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
        requestId: request.requestId, documentCount: 1,
        model: 'fake-embedding', revision: 'fake-v1', dimensions: 2,
        elapsedMs: 1, profileVersion: engine.profileVersion,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const engine = new HybridRankingEngine({
      baseUrl: 'http://rag.test', fetch,
      embeddingIdentity: { model: 'fake-embedding', revision: 'fake-v1', dimensions: 2 },
      preparePollIntervalMs: 5,
    })

    await expect(engine.prepare(DOCUMENTS)).resolves.toMatchObject({ documentCount: 1 })
    expect(attempts).toBe(2)
  })

  it('keeps the socket error code when preparation cannot reconnect', async () => {
    const fetch: typeof globalThis.fetch = async input => {
      if (String(input).includes('/v1/ranking/prepare/')) {
        return new Response('', { status: 404 })
      }
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      })
    }
    const engine = new HybridRankingEngine({
      baseUrl: 'http://rag.test', fetch,
      embeddingIdentity: { model: 'fake-embedding', revision: 'fake-v1', dimensions: 2 },
      preparePollIntervalMs: 5,
    })

    await expect(engine.prepare(DOCUMENTS)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: '无法连接本地 RAG 服务（ECONNRESET: read ECONNRESET）。',
    })
  })

  it('does not use the fetch transport for a long preparation response', async () => {
    let engine: HybridRankingEngine
    const server = createServer((request, response) => {
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        const body = JSON.parse(raw)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          protocolVersion: RAG_SERVICE_PROTOCOL_VERSION,
          requestId: body.requestId, documentCount: 1,
          model: 'fake-embedding', revision: 'fake-v1', dimensions: 2,
          elapsedMs: 1, profileVersion: engine.profileVersion,
        }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const mockedFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch transport unavailable'))
    try {
      engine = new HybridRankingEngine({
        baseUrl: `http://127.0.0.1:${address.port}`,
        embeddingIdentity: { model: 'fake-embedding', revision: 'fake-v1', dimensions: 2 },
        preparePollIntervalMs: 5,
      })
      await expect(engine.prepare(DOCUMENTS)).resolves.toMatchObject({ documentCount: 1 })
    } finally {
      mockedFetch.mockRestore()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
