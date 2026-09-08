import { afterEach, describe, expect, it, vi } from 'vitest'
import { TicketCandidateRef } from '@retrieval-agent/contracts'
import { readTicketDetail, TicketDetailClientError } from './detail-client.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('ticket detail client', () => {
  it('sends only the opaque candidate ref and returns the authorized Host detail', async () => {
    const ref = TicketCandidateRef('candidate-opaque-1')
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
      details: [{
        candidateRef: ref,
        displayId: 'TKT-0007',
        sourceVersion: 'source-v1',
        title: '副卡在省外漫游无法上网',
        summary: '副卡在省外漫游无法上网',
        l0: { region: '湖南' },
        fields: { problemDescription: ['省外漫游时无法建立数据连接。'] },
        unavailableFields: [],
      }],
      rejectedCandidateRefs: [],
      warnings: [],
      receipt: { readId: 'read-1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)

    const detail = await readTicketDetail('session-1', 'retrieval-1', ref, ['problemDescription'])

    expect(detail.displayId).toBe('TKT-0007')
    const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request).toEqual({
      sessionId: 'session-1',
      retrievalId: 'retrieval-1',
      candidateRefs: ['candidate-opaque-1'],
      fields: ['problemDescription'],
    })
    expect(request).not.toHaveProperty('ticketId')
  })

  it('keeps structured authorization failures visible to the UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'UNAUTHORIZED', message: '无权读取。', retryable: false,
    }), { status: 403, headers: { 'content-type': 'application/json' } })))

    await expect(readTicketDetail('session-1', 'retrieval-1', TicketCandidateRef('candidate-1'), []))
      .rejects.toBeInstanceOf(TicketDetailClientError)
  })
})
