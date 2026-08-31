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
  it('carries a provider-declared raw field through the controller allowlist and bounded evidence read', async () => {
    const now = () => new Date('2026-08-27T01:00:00.000Z')
    const provider = new LocalTicketProvider([normalizePublicSnapshotTicket({
      ticket_id: 'PUBLIC-RAW-1', source_dataset: 'example/raw', source_version: 'v1',
      title: 'Extensible source record', summary: 'Contains an adapter-unknown value.', extension_blob: { future_key: 'future-value' },
    })], { now, ranker: testHybridRanker() })
    let serial = 0
    const controller = new RetrievalController(provider, new InMemoryRetrievalEventJournal({ now, eventId: () => `event-${serial++}` }), undefined, {
      now, id: () => `domain-${serial++}`,
    })
    let state = await controller.start(ADMIN, { target: 'ranked_cases', query: 'future value' })
    expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
    const candidate = state.candidates[0]!
    state = controller.assess(state, {
      decision: 'continue', coverage: 0.6, candidateQuality: 0.8,
      selectedCandidateRefs: [candidate.ref], excludedCandidateRefs: [],
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [candidate.ref], evaluator: 'model' }],
      nextAction: 'promote', stop: false,
    })
    expect(state.allowedActions.find(action => action.kind === 'promote')?.fieldAllowlist).toContain('source.raw')
    state = await controller.promote(ADMIN, state, [candidate.ref], ['source.raw'], 200)
    expect(state.promotedEvidence[0]?.text).toContain('future-value')
  })
})
