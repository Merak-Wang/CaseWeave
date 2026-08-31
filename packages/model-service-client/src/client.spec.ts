import { describe, expect, it } from 'vitest'
import { ModelServiceClient, ModelServiceClientError } from './client.js'
import { MODEL_SERVICE_PROTOCOL_VERSION, type ModelServiceReadyResponse } from './protocol.js'

const READY: ModelServiceReadyResponse = {
  protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
  serviceVersion: 'test-service',
  ready: true,
  device: 'cuda:0',
  models: [
    {
      model: 'embedding', revision: 'embed-v1', kind: 'embedding', loaded: true,
      dtype: 'bfloat16', device: 'cuda:0', maxTokens: 512, dimensions: 2,
      pooling: 'last_token', normalization: 'l2',
    },
    {
      model: 'reranker', revision: 'rerank-v1', kind: 'reranker', loaded: true,
      dtype: 'bfloat16', device: 'cuda:0', maxTokens: 512, scoreKind: 'yes_probability',
    },
  ],
  limits: { maxBatchSize: 16, maxTotalTokens: 8192, maxRerankCandidates: 20 },
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchImplementation: typeof fetch): ModelServiceClient {
  return new ModelServiceClient({
    baseUrl: 'http://127.0.0.1:8012',
    embeddingModel: 'embedding', embeddingRevision: 'embed-v1', embeddingDimensions: 2,
    rerankerModel: 'reranker', rerankerRevision: 'rerank-v1', defaultDeadlineMs: 500,
    fetch: fetchImplementation,
  })
}

describe('ModelServiceClient', () => {
  it('handshakes model identity and preserves query/document roles', async () => {
    const seen: unknown[] = []
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/health/ready')) return response(READY)
      const body = JSON.parse(String(init?.body)) as { requestId: string; inputType: string; input: string[] }
      seen.push(body)
      return response({
        protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
        requestId: body.requestId,
        model: 'embedding', revision: 'embed-v1', dimensions: 2, normalization: 'l2',
        data: body.input.map((_text, index) => ({ index, embedding: index === 0 ? [1, 0] : [0, 1] })),
        elapsedMs: 1,
      })
    }) as typeof fetch

    const vectors = await client(fetchImplementation).embed({ texts: ['query', 'second'], inputType: 'query', instruction: 'retrieve' })

    expect(vectors).toEqual([[1, 0], [0, 1]])
    expect(seen).toMatchObject([{ inputType: 'query', input: ['query', 'second'] }])
  })

  it('rejects reordered embedding rows and model revision drift', async () => {
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/health/ready')) return response(READY)
      const body = JSON.parse(String(init?.body)) as { requestId: string }
      return response({
        protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
        requestId: body.requestId,
        model: 'embedding', revision: 'embed-v2', dimensions: 2, normalization: 'l2',
        data: [{ index: 1, embedding: [1, 0] }], elapsedMs: 1,
      })
    }) as typeof fetch

    await expect(client(fetchImplementation).embed({ texts: ['one'], inputType: 'document' }))
      .rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' } satisfies Partial<ModelServiceClientError>)
  })

  it('rejects finite vectors that violate the advertised L2 normalization', async () => {
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/health/ready')) return response(READY)
      const body = JSON.parse(String(init?.body)) as { requestId: string }
      return response({
        protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
        requestId: body.requestId,
        model: 'embedding', revision: 'embed-v1', dimensions: 2, normalization: 'l2',
        data: [{ index: 0, embedding: [0, 0] }], elapsedMs: 1,
      })
    }) as typeof fetch

    await expect(client(fetchImplementation).embed({ texts: ['one'], inputType: 'document' }))
      .rejects.toMatchObject({ code: 'INVALID_VECTOR' } satisfies Partial<ModelServiceClientError>)
  })

  it('rejects reranker candidates that were not admitted or are incomplete', async () => {
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/health/ready')) return response(READY)
      const body = JSON.parse(String(init?.body)) as { requestId: string }
      return response({
        protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
        requestId: body.requestId,
        model: 'reranker', revision: 'rerank-v1', scoreKind: 'yes_probability',
        results: [{ id: 'unknown', inputIndex: 0, rank: 1, score: 0.9 }], elapsedMs: 1,
      })
    }) as typeof fetch

    await expect(client(fetchImplementation).rerank({
      query: 'q', instruction: 'judge', topK: 2,
      candidates: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
    })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' } satisfies Partial<ModelServiceClientError>)
  })

  it('maps a bounded request abort to a deadline error', async () => {
    const fetchImplementation = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true })
    })) as typeof fetch
    const bounded = new ModelServiceClient({
      baseUrl: 'http://127.0.0.1:8012', embeddingModel: 'embedding', embeddingDimensions: 2,
      defaultDeadlineMs: 100, fetch: fetchImplementation,
    })

    await expect(bounded.ready()).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' } satisfies Partial<ModelServiceClientError>)
  })
})
