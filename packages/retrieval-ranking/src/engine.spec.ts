import { describe, expect, it } from 'vitest'
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
      modelDeadlineMs: 5_000, minimumDenseScore: 0.1,
      fusion: { rankConstant: 60, keywordWeight: 0.55, vectorWeight: 0.45 },
      rerankerEnabled: false, rerankTopN: 20, allowKeywordFallback: false,
    })
    expect(engine.profileVersion).toBe('quick-hybrid-v1:15528de79176c9a8')
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
})
