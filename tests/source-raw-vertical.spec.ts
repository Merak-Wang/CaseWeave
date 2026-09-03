import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { InMemoryRetrievalEventJournal, RetrievalController } from '@retrieval-agent/domain'
import { LocalTicketProvider, normalizePublicSnapshotTicket } from '@retrieval-agent/provider-local'
import { testHybridRanker } from './support/fake-model-gateway.js'
import { testRetrievalPolicy } from './support/retrieval-policy.js'

const ADMIN: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { environment: ['development'], role: ['administrator'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}

describe('source raw vertical slice', () => {
  it('keeps provider-declared L3 raw data outside the model promotion allowlist and available to explicit detail reads', async () => {
    const now = () => new Date('2026-08-27T01:00:00.000Z')
    const provider = new LocalTicketProvider([
      normalizePublicSnapshotTicket({
        ticket_id: 'PUBLIC-RAW-1', source_dataset: 'example/raw', source_version: 'v1',
        title: 'Extensible source record one', summary: 'Contains future value one.', extension_blob: { future_key: 'future-value-one' },
      }),
      normalizePublicSnapshotTicket({
        ticket_id: 'PUBLIC-RAW-2', source_dataset: 'example/raw', source_version: 'v1',
        title: 'Extensible source record two', summary: 'Contains future value two.', extension_blob: { future_key: 'future-value-two' },
      }),
    ], { now, ranker: testHybridRanker() })
    let serial = 0
    const controller = new RetrievalController(provider, new InMemoryRetrievalEventJournal({ now, eventId: () => `event-${serial++}` }), undefined, {
      policy: testRetrievalPolicy(), now, id: () => `domain-${serial++}`,
    })
    let state = await controller.start(ADMIN, {
      target: 'ranked_cases', query: 'future value', requestedCount: 5, countPolicy: 'explicit',
    })
    expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
    const candidates = state.candidates
    expect(candidates.map(candidate => candidate.summary)).toEqual([
      'Contains future value one.', 'Contains future value two.',
    ])
    expect(candidates.every(candidate => !Object.hasOwn(candidate, 'rawPayload'))).toBe(true)
    state = await controller.assess(state, {
      decision: 'continue', evaluator: 'model',
      selectedCandidateRefs: candidates.map(candidate => candidate.ref),
      excludedCandidateRefs: [],
      gaps: [{
        kind: 'depth', status: 'open', evaluator: 'model',
        evidenceRefs: candidates.map(candidate => candidate.ref),
        description: 'L2 summaries do not expose the source extension values.',
      }],
      nextAction: 'read_l3_details',
    })
    expect(state.allowedActions.find(action => action.kind === 'read_l3_details')).toMatchObject({
      candidateAllowlist: candidates.map(candidate => candidate.ref), fieldAllowlist: ['source.raw'],
    })
    const refs = candidates.map(candidate => candidate.ref).reverse()
    const raw = await controller.readL3Details(ADMIN, state, refs)
    expect(raw.details.map(detail => detail.candidateRef)).toEqual(refs)
    expect(JSON.stringify(raw.details.map(detail => detail.rawPayload))).toContain('future-value-two')
    await expect(provider.readDetails(ADMIN, {
      snapshotId: state.snapshot!.snapshotId,
      candidateRefs: refs,
      fields: ['source.raw'],
      purpose: 'inline_detail',
    })).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
  })
})
