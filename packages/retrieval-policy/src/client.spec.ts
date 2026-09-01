import { describe, expect, it } from 'vitest'
import type { TicketCandidate, TicketCandidateRef } from '@retrieval-agent/contracts'
import { RetrievalPolicyClient } from './client.js'
import { RAG_POLICY_PROTOCOL_VERSION } from './protocol.js'

const CANDIDATE = { ref: 'c1' as TicketCandidateRef, rank: 1, displayId: 'INC-1', title: 'title', summary: 'summary' } as TicketCandidate

describe('RetrievalPolicyClient', () => {
  it('validates immutable history and rejects a forged active candidate', async () => {
    let forged = false
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      const active = forged ? [{ ...CANDIDATE, ref: 'forged' }] : [CANDIDATE]
      return new Response(JSON.stringify({
        protocolVersion: RAG_POLICY_PROTOCOL_VERSION,
        requestId: request.requestId,
        result: {
          version: 'candidate-ranking-v1', history: [CANDIDATE], active,
          observations: [{
            searchEventId: 'event-1', stage: 'initial_hybrid', queryFingerprint: 'query-1',
            ranking: [{ ref: 'c1', rank: 1 }],
          }],
        }, elapsedMs: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const client = new RetrievalPolicyClient({ baseUrl: 'http://rag.test', fetch })
    const input = {
      previousHistory: [], previousObservations: [], page: [CANDIDATE], searchEventId: 'event-1',
      stage: 'initial_hybrid' as const, queryFingerprint: 'query-1', excludedRefs: [],
    }
    await expect(client.updateCandidateRanking(input)).resolves.toMatchObject({ active: [{ ref: 'c1' }] })
    forged = true
    await expect(client.updateCandidateRanking(input)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  })
})
