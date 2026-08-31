import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TicketCandidateRef,
  TicketSnapshotId,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { StreamClusterTicketProvider } from './client.js'
import { STREAMCLUSTER_PROTOCOL_VERSION } from './protocol.js'

const principal: TrustedPrincipalContext = {
  tenantId: 'demo',
  subjectId: 'development-admin',
  entitlementVersion: 'dev-admin-v1',
  purpose: 'ticket_retrieval',
  attributes: { role: ['administrator'], environment: ['development'] },
  issuedAt: '2026-08-27T00:00:00.000Z',
  expiresAt: '2027-08-28T00:00:00.000Z',
}

function snapshot() {
  return {
    snapshotId: TicketSnapshotId('snapshot-1'),
    shortId: 'snap-1',
    providerId: 'streamcluster-test',
    createdAt: '2026-08-27T00:00:00.000Z',
    sourceVersion: 'source-v1',
    indexVersion: 'index-v1',
    retrievalProfileVersion: 'streamcluster-test-hybrid-v1',
    authorizationVersion: 'dev-admin-v1',
    principalBindingHash: 'binding-1',
    queryPolicyVersion: 'query-v1',
    fieldCatalog: [
      { key: 'source.raw', label: '原始载荷', valueKind: 'raw_json', accessLevel: 'L2', filterOperators: [], sensitivity: 'source_controlled' },
    ],
    capabilities: {
      exhaustive: true,
      pagination: true,
      evidencePromotion: true,
      detailRead: true,
      exportRead: true,
      keywordSearch: true as const,
      denseSearch: true,
      hybridFusion: true,
      reranking: false,
    },
  }
}

function searchTrace() {
  return {
    stage: 'baseline' as const,
    requestedMode: 'hybrid' as const,
    executedMode: 'hybrid' as const,
    strategyVersion: 'streamcluster-test-hybrid-v1',
    channels: [
      { channel: 'keyword' as const, implementation: 'test-bm25f', version: 'test-bm25f-v1', resultCount: 0, elapsedMs: 1 },
      {
        channel: 'vector' as const, implementation: 'test-dense', version: 'test-dense-v1',
        model: 'test-embedding', revision: 'test-revision-v1', dimensions: 4,
        resultCount: 0, elapsedMs: 1,
      },
    ],
    fusion: {
      method: 'weighted_rrf' as const,
      version: 'test-rrf-v1',
      rankConstant: 60,
      keywordWeight: 0.5,
      vectorWeight: 0.5,
    },
    signals: [],
  }
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

let server: Server | undefined
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>(resolve => server?.close(() => { resolve() }) ?? resolve())
  server = undefined
})

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(error => {
      response.statusCode = 500
      response.end(JSON.stringify({ error: String(error) }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('StreamClusterTicketProvider HTTP contract', () => {
  it('handshakes once and re-sends the trusted principal on every bounded read', async () => {
    const calls: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined; body?: unknown }> = []
    const baseUrl = await listen(async (request, response) => {
      const call = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        ...(request.method === 'POST' ? { body: await jsonBody(request) } : {}),
      }
      calls.push(call)
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/ticket-retrieval/capabilities') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          providerId: 'streamcluster-test',
          readOnly: true,
          capabilities: {
            snapshot: true, search: true, evidenceRead: true, detailRead: true, status: true,
            keywordSearch: true, denseSearch: true, hybridFusion: true, reranking: false, rankingTrace: true,
          },
        }))
      } else if (request.url === '/v1/ticket-retrieval/snapshots') {
        response.end(JSON.stringify({ protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION, snapshot: snapshot() }))
      } else if (request.url === '/v1/ticket-retrieval/search') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          page: {
            snapshotId: 'snapshot-1', queryFingerprint: 'query-1', candidates: [], completeness: 'exhaustive',
            scanned: 0, returned: 0, elapsedMs: 2, appliedFilters: [], warnings: [],
            trace: searchTrace(),
          },
        }))
      } else if (request.url === '/v1/ticket-retrieval/evidence') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          result: {
            snapshotId: 'snapshot-1', evidence: [], requestedCandidateRefs: ['candidate-1'],
            rejectedCandidateRefs: ['candidate-1'], tokenBudget: 20, tokensUsed: 0, warnings: [],
          },
        }))
      } else if (request.url === '/v1/ticket-retrieval/details') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          result: { snapshotId: 'snapshot-1', details: [], rejectedCandidateRefs: ['candidate-1'], warnings: [] },
        }))
      } else {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          status: { providerId: 'streamcluster-test', ready: true, readOnly: true, snapshotValid: true, warnings: [] },
        }))
      }
    })
    const provider = new StreamClusterTicketProvider({
      baseUrl,
      providerId: 'streamcluster-test',
      authorization: 'Bearer test-token',
    })
    const opened = await provider.openSnapshot(principal, { traceId: 'trace-1' })
    expect(opened.fieldCatalog).toContainEqual(expect.objectContaining({ key: 'source.raw' }))
    const spec = provider.resolve({ target: 'ranked_cases', query: '  主副卡  ' })
    await provider.search(principal, opened.snapshotId, spec, { topK: 5, maxScan: 100, stage: 'baseline' })
    await provider.readEvidence(principal, {
      snapshotId: opened.snapshotId,
      candidateRefs: [TicketCandidateRef('candidate-1')],
      fields: ['answer'],
      tokenBudget: 20,
    })
    await provider.readDetails(principal, {
      snapshotId: opened.snapshotId,
      candidateRefs: [TicketCandidateRef('candidate-1')],
      fields: ['answer'],
      purpose: 'inline_detail',
    })
    await provider.status(principal, opened.snapshotId)

    expect(calls.filter(call => call.url === '/v1/ticket-retrieval/capabilities')).toHaveLength(1)
    expect(calls.every(call => call.authorization === 'Bearer test-token')).toBe(true)
    const postBodies = calls.filter(call => call.method === 'POST').map(call => call.body as Record<string, unknown>)
    expect(postBodies).toHaveLength(5)
    expect(postBodies.every(body => body.protocolVersion === STREAMCLUSTER_PROTOCOL_VERSION)).toBe(true)
    expect(postBodies.every(body => (body.principal as TrustedPrincipalContext).subjectId === 'development-admin')).toBe(true)
    expect(calls.find(call => call.url === '/v1/ticket-retrieval/search')?.body).toMatchObject({
      options: { topK: 5, maxScan: 100, stage: 'baseline' },
    })
    expect(spec.normalizedQuery).toBe('主副卡')
  })

  it('rejects snapshot drift and preserves a structured remote error', async () => {
    const baseUrl = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/ticket-retrieval/capabilities') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          providerId: 'streamcluster-test', readOnly: true,
          capabilities: {
            snapshot: true, search: true, evidenceRead: true, detailRead: true, status: true,
            keywordSearch: true, denseSearch: true, hybridFusion: true, reranking: false, rankingTrace: true,
          },
        }))
      } else if (request.url === '/v1/ticket-retrieval/snapshots') {
        response.end(JSON.stringify({ protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION, snapshot: snapshot() }))
      } else if (request.url === '/v1/ticket-retrieval/search') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          page: {
            snapshotId: 'changed', queryFingerprint: 'q', candidates: [], completeness: 'exhaustive',
            scanned: 0, returned: 0, elapsedMs: 0, appliedFilters: [], warnings: [],
            trace: searchTrace(),
          },
        }))
      } else {
        response.statusCode = 403
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          error: { code: 'UNAUTHORIZED', message: '授权快照已收窄。', retryable: false },
        }))
      }
    })
    const provider = new StreamClusterTicketProvider({ baseUrl, providerId: 'streamcluster-test' })
    const opened = await provider.openSnapshot(principal)
    await expect(provider.search(principal, opened.snapshotId, provider.resolve({ target: 'ranked_cases', query: 'test' }), {
      topK: 1,
      maxScan: 10,
      stage: 'baseline',
    })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
    await expect(provider.status(principal, opened.snapshotId)).rejects.toMatchObject({
      code: 'UNAUTHORIZED', publicMessage: '授权快照已收窄。', retryable: false,
    })
  })

  it('rejects a v2 handshake that omits a required ranking capability', async () => {
    const baseUrl = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url !== '/v1/ticket-retrieval/capabilities') throw new Error('snapshot must not open after a failed handshake')
      response.end(JSON.stringify({
        protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
        providerId: 'streamcluster-test',
        readOnly: true,
        capabilities: {
          snapshot: true, search: true, evidenceRead: true, detailRead: true, status: true,
          keywordSearch: true, denseSearch: true, hybridFusion: true, reranking: false,
        },
      }))
    })
    const provider = new StreamClusterTicketProvider({ baseUrl, providerId: 'streamcluster-test' })
    await expect(provider.openSnapshot(principal)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  })

  it('passes the requested stage and rejects a trace for a different stage', async () => {
    let receivedStage: unknown
    const baseUrl = await listen(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/ticket-retrieval/capabilities') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          providerId: 'streamcluster-test', readOnly: true,
          capabilities: {
            snapshot: true, search: true, evidenceRead: true, detailRead: true, status: true,
            keywordSearch: true, denseSearch: true, hybridFusion: true, reranking: false, rankingTrace: true,
          },
        }))
      } else if (request.url === '/v1/ticket-retrieval/snapshots') {
        response.end(JSON.stringify({ protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION, snapshot: snapshot() }))
      } else {
        const body = await jsonBody(request) as { readonly options?: { readonly stage?: unknown } }
        receivedStage = body.options?.stage
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          page: {
            snapshotId: 'snapshot-1', queryFingerprint: 'query-1', candidates: [], completeness: 'exhaustive',
            scanned: 0, returned: 0, elapsedMs: 1, appliedFilters: [], warnings: [],
            trace: { ...searchTrace(), stage: 'repair_search' },
          },
        }))
      }
    })
    const provider = new StreamClusterTicketProvider({ baseUrl, providerId: 'streamcluster-test' })
    const opened = await provider.openSnapshot(principal)
    await expect(provider.search(principal, opened.snapshotId, provider.resolve({ target: 'ranked_cases', query: 'test' }), {
      topK: 1,
      maxScan: 10,
      stage: 'initial_hybrid',
    })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
    expect(receivedStage).toBe('initial_hybrid')
  })

  it('rejects ranking signals that do not correspond to the returned candidate page', async () => {
    const baseUrl = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/ticket-retrieval/capabilities') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          providerId: 'streamcluster-test', readOnly: true,
          capabilities: {
            snapshot: true, search: true, evidenceRead: true, detailRead: true, status: true,
            keywordSearch: true, denseSearch: true, hybridFusion: true, reranking: false, rankingTrace: true,
          },
        }))
      } else if (request.url === '/v1/ticket-retrieval/snapshots') {
        response.end(JSON.stringify({ protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION, snapshot: snapshot() }))
      } else {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          page: {
            snapshotId: 'snapshot-1', queryFingerprint: 'query-1', candidates: [], completeness: 'exhaustive',
            scanned: 0, returned: 0, elapsedMs: 1, appliedFilters: [], warnings: [],
            trace: {
              ...searchTrace(),
              signals: [{
                candidateRef: 'invented-candidate', finalRank: 1, fusedScore: 0.1,
                channels: [{ channel: 'keyword', rank: 1, score: 1 }],
              }],
            },
          },
        }))
      }
    })
    const provider = new StreamClusterTicketProvider({ baseUrl, providerId: 'streamcluster-test' })
    const opened = await provider.openSnapshot(principal)
    await expect(provider.search(principal, opened.snapshotId, provider.resolve({ target: 'ranked_cases', query: 'test' }), {
      topK: 1,
      maxScan: 10,
      stage: 'baseline',
    })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  })

  it('distinguishes caller cancellation from the provider deadline', async () => {
    const baseUrl = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/ticket-retrieval/capabilities') {
        response.end(JSON.stringify({
          protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION,
          providerId: 'streamcluster-test', readOnly: true,
          capabilities: {
            snapshot: true, search: true, evidenceRead: true, detailRead: true, status: true,
            keywordSearch: true, denseSearch: true, hybridFusion: true, reranking: false, rankingTrace: true,
          },
        }))
      } else if (request.url === '/v1/ticket-retrieval/snapshots') {
        response.end(JSON.stringify({ protocolVersion: STREAMCLUSTER_PROTOCOL_VERSION, snapshot: snapshot() }))
      } else {
        setTimeout(() => response.end(JSON.stringify({})), 100)
      }
    })
    const provider = new StreamClusterTicketProvider({ baseUrl, providerId: 'streamcluster-test', timeoutMs: 20 })
    const opened = await provider.openSnapshot(principal)
    const spec = provider.resolve({ target: 'ranked_cases', query: 'test' })
    await expect(provider.search(principal, opened.snapshotId, spec, { topK: 1, maxScan: 10, stage: 'baseline' }))
      .rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
    const abort = new AbortController()
    abort.abort()
    await expect(provider.search(principal, opened.snapshotId, spec, { topK: 1, maxScan: 10, stage: 'baseline', signal: abort.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
