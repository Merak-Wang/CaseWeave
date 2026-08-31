import { describe, expect, it } from 'vitest'
import {
  MODEL_SERVICE_PROTOCOL_VERSION,
  type EmbedInput,
  type ModelServiceReadyResponse,
  type RerankInput,
  type RetrievalModelGateway,
} from '@retrieval-agent/model-service-client'
import { HybridRankingEngine, RankingError } from './engine.js'
import type { RankingDocument } from './types.js'

const READY: ModelServiceReadyResponse = {
  protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
  serviceVersion: 'test',
  ready: true,
  device: 'test',
  models: [
    {
      kind: 'embedding', model: 'fake-embedding', revision: 'embed-v1', loaded: true,
      dtype: 'float32', device: 'test', maxTokens: 512, dimensions: 2,
      pooling: 'last_token', normalization: 'l2',
    },
    {
      kind: 'reranker', model: 'fake-reranker', revision: 'rerank-v1', loaded: true,
      dtype: 'float32', device: 'test', maxTokens: 512, scoreKind: 'yes_probability',
    },
  ],
  limits: { maxBatchSize: 16, maxTotalTokens: 8192, maxRerankCandidates: 20 },
}

class FakeGateway implements RetrievalModelGateway {
  readonly calls: EmbedInput[] = []
  invalidRerank = false

  ready(): Promise<ModelServiceReadyResponse> { return Promise.resolve(READY) }

  embed(input: EmbedInput): Promise<readonly (readonly number[])[]> {
    this.calls.push(input)
    return Promise.resolve(input.texts.map(text => {
      if (input.inputType === 'query' || text.includes('semantic-only')) return [1, 0]
      if (text.includes('lexical-only')) return [0, 1]
      return [-1, 0]
    }))
  }

  rerank(input: RerankInput): Promise<readonly { readonly id: string; readonly rank: number; readonly score: number }[]> {
    if (this.invalidRerank) return Promise.resolve([{ id: 'not-admitted', rank: 1, score: 1 }])
    return Promise.resolve([...input.candidates].reverse().map((candidate, index) => ({
      id: candidate.id, rank: index + 1, score: 1 - index / Math.max(1, input.candidates.length),
    })))
  }
}

function document(id: string, title: string, summary: string): RankingDocument {
  return { id, contentHash: `hash-${id}`, title, summary, body: '', metadata: '' }
}

const DOCUMENTS = [
  document('lexical', '主副卡解绑后流量共享', 'lexical-only'),
  document('semantic', '家庭套餐状态异常', 'semantic-only'),
  document('irrelevant', '打印机缺纸', 'other'),
]

describe('HybridRankingEngine', () => {
  it('prepares document vectors before traffic and reuses them for the first query', async () => {
    const gateway = new FakeGateway()
    const engine = new HybridRankingEngine({ gateway, minimumDenseScore: 0.5 })

    await expect(engine.prepare(DOCUMENTS)).resolves.toMatchObject({
      documentCount: DOCUMENTS.length,
      model: 'fake-embedding',
      revision: 'embed-v1',
      dimensions: 2,
    })
    expect(gateway.calls.filter(call => call.inputType === 'document')).toHaveLength(1)

    await engine.rank(DOCUMENTS, {
      text: '主副卡解绑后流量共享', semanticHints: [], excludedTerms: [], mode: 'hybrid',
    }, { maxScan: 100 })

    expect(gateway.calls.filter(call => call.inputType === 'document')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.inputType === 'query')).toHaveLength(1)
  })

  it('selects authorized or filtered rows from the prepared corpus without building subset caches', async () => {
    const gateway = new FakeGateway()
    const engine = new HybridRankingEngine({ gateway, minimumDenseScore: 0.5 })

    await engine.prepare(DOCUMENTS)
    const result = await engine.rank([DOCUMENTS[1]!], {
      text: '语义相关问题', semanticHints: [], excludedTerms: [], mode: 'dense',
    }, { maxScan: 100 })

    expect(result.hits.map(hit => hit.documentId)).toEqual(['semantic'])
    expect(gateway.calls.filter(call => call.inputType === 'document')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.inputType === 'query')).toHaveLength(1)
  })

  it('runs both first-pass channels and preserves lexical-only and semantic-only candidates', async () => {
    const gateway = new FakeGateway()
    const engine = new HybridRankingEngine({ gateway, minimumDenseScore: 0.5 })

    const result = await engine.rank(DOCUMENTS, {
      text: '主副卡解绑后流量共享', semanticHints: [], excludedTerms: [], mode: 'hybrid',
    }, { maxScan: 100 })

    expect(result.execution.executedMode).toBe('hybrid')
    expect(result.execution.channels.map(channel => channel.channel)).toEqual(['keyword', 'vector'])
    expect(result.hits.map(hit => hit.documentId)).toEqual(expect.arrayContaining(['lexical', 'semantic']))
    expect(result.hits.find(hit => hit.documentId === 'lexical')!.channels.map(item => item.channel)).toContain('keyword')
    expect(result.hits.find(hit => hit.documentId === 'semantic')!.channels.map(item => item.channel)).toContain('vector')
    expect(gateway.calls.some(call => call.inputType === 'document')).toBe(true)
    expect(gateway.calls.some(call => call.inputType === 'query')).toBe(true)
  })

  it('fails closed when hybrid is requested without a dense gateway', async () => {
    const engine = new HybridRankingEngine()
    await expect(engine.rank(DOCUMENTS, {
      text: '解绑', semanticHints: [], excludedTerms: [], mode: 'hybrid',
    }, { maxScan: 100 })).rejects.toMatchObject({ code: 'HYBRID_UNAVAILABLE' } satisfies Partial<RankingError>)
  })

  it('supports a vector-only diagnostic mode without executing BM25F or fusion', async () => {
    const gateway = new FakeGateway()
    const engine = new HybridRankingEngine({ gateway, minimumDenseScore: 0.5 })

    const result = await engine.rank(DOCUMENTS, {
      text: '主副卡解绑后流量共享', semanticHints: [], excludedTerms: [], mode: 'dense',
    }, { maxScan: 100 })

    expect(result.execution).toMatchObject({ requestedMode: 'dense', executedMode: 'dense' })
    expect(result.execution.fusion).toBeUndefined()
    expect(result.execution.channels.map(channel => channel.channel)).toEqual(['vector'])
    expect(result.hits.map(hit => hit.documentId)).toEqual(['semantic'])
    expect(result.hits[0]!.channels.map(channel => channel.channel)).toEqual(['vector'])
  })

  it('fails open to fused candidates when a reranker violates the admitted pool', async () => {
    const gateway = new FakeGateway()
    gateway.invalidRerank = true
    const engine = new HybridRankingEngine({ gateway, minimumDenseScore: 0.5, rerankerEnabled: true })

    const result = await engine.rank(DOCUMENTS, {
      text: '主副卡解绑后流量共享', semanticHints: [], excludedTerms: [], mode: 'hybrid',
    }, { maxScan: 100 })

    expect(result.hits.some(hit => hit.documentId === 'not-admitted')).toBe(false)
    expect(result.execution.reranker).toBeUndefined()
    expect(result.warnings).toContain('reranker_failed_open')
  })
})
