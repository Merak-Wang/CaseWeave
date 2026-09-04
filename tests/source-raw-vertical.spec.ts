import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { InMemoryRetrievalEventJournal, RetrievalController } from '@retrieval-agent/domain'
import { LocalTicketProvider, normalizePublicSnapshotTicket } from '@retrieval-agent/provider-local'
import { testHybridRanker } from './support/fake-model-gateway.js'

const ADMIN: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { environment: ['development'], role: ['administrator'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}

describe('source raw vertical slice', () => {
  it('prevents declared legacy raw fields from entering model or user controlled-evidence reads', async () => {
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
      now, id: () => `domain-${serial++}`,
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
    state = controller.recordContextSelection(state, controller.projectContext(state))
    await expect(controller.decide(ADMIN, state, { stateId: state.stateId, judgments: [],
      gaps: [{ kind: 'depth', status: 'open', evaluator: 'model', evidenceRefs: candidates.map(candidate => candidate.ref), description: 'Need more than the summary.' }],
      action: { kind: 'inspect', candidateRefs: candidates.map(candidate => candidate.ref), fields: ['source.raw'] },
    })).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
    expect(state.promotedEvidence).toEqual([])
    expect(controller.projectContext(state).rendered).not.toContain('future-value-two')
    const refs = candidates.map(candidate => candidate.ref).reverse()
    await expect(provider.readDetails(ADMIN, {
      snapshotId: state.snapshot!.snapshotId,
      candidateRefs: refs,
      fields: ['source.raw'],
      purpose: 'inline_detail',
    })).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
  })
})
