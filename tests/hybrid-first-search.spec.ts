import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/ticket-collection'
import { InMemoryRetrievalEventJournal, RetrievalController } from '@retrieval-agent/domain'
import { LocalTicketProvider, parseFixtureJsonl } from '@retrieval-agent/provider-local'
import { bundledFixturePath } from '@retrieval-agent/bundle/startup'
import { testHybridRanker } from './support/fake-model-gateway.js'

const NOW = new Date('2026-08-27T04:00:00.000Z')
const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { group: ['admin'], region: ['cn'], role: ['administrator'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2030-08-28T00:00:00.000Z',
}

describe('fixed first-pass Hybrid retrieval', () => {
  it('keeps vector diagnostics separate while assessment selects the automatic Hybrid result collection', async () => {
    const provider = new LocalTicketProvider(parseFixtureJsonl(await readFile(bundledFixturePath(), 'utf8')), {
      now: () => NOW,
      ranker: testHybridRanker(),
    })
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    const dense = await provider.search(PRINCIPAL, snapshot.snapshotId, provider.resolve({
      target: 'ranked_cases', query: '主副卡解绑后仍共享流量', mode: 'dense',
    }), { topK: 5, maxScan: 100, stage: 'baseline' })
    expect(dense.trace.executedMode).toBe('dense')
    expect(dense.trace.channels.map(channel => channel.channel)).toEqual(['vector'])

    let serial = 0
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: () => `hybrid-event-${serial++}` })
    const controller = new RetrievalController(provider, journal, undefined, {
      now: () => NOW, id: () => `hybrid-domain-${serial++}`, searchTopK: 5,
    })
    let state = await controller.start(PRINCIPAL, {
      target: 'ranked_cases', query: '主副卡解绑后仍共享流量', requestedCount: 5,
    })
    expect(state.lastPage?.trace).toMatchObject({ stage: 'initial_hybrid', requestedMode: 'hybrid', executedMode: 'hybrid' })
    expect(state.lastPage?.trace.channels.map(channel => channel.channel)).toEqual(['keyword', 'vector'])
    expect(controller.finalizeExhaustedEmptyResult(state)).toBe(state)
    state = controller.assess(state, {
      decision: 'sufficient', coverage: 1, candidateQuality: 0.9,
      selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
      gaps: [], nextAction: 'finish', stop: true,
    })
    state = controller.freeze(state, state.selectedCandidateRefs)

    const collection = createTicketResultCollection(state)
    expect(collection).toMatchObject({ type: 'ticket_collection', stoppingReason: 'sufficient' })
    expect(collection.tickets).toHaveLength(5)
    expect(collection.tickets.map(ticket => ticket.displayId)).toContain('TKT-0029')
  })
})
