import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetrievalId } from '@retrieval-agent/contracts'
import { continueRetrieval } from './continue.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('continue retrieval client', () => {
  it('sends only the session and retrieval identities; the browser never owns the Provider cursor', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      retrievalId: 'retrieval-ui-continue', candidateCount: 12, nextPageAvailable: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(continueRetrieval('session-ui', RetrievalId('retrieval-ui-continue'))).resolves.toMatchObject({
      candidateCount: 12, nextPageAvailable: false,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      sessionId: 'session-ui', retrievalId: 'retrieval-ui-continue',
    })
  })

  it('rejects a mismatched retrieval identity in a nominal success response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      retrievalId: 'retrieval-other', candidateCount: 2, nextPageAvailable: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(continueRetrieval('session-ui', RetrievalId('retrieval-ui-continue')))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
