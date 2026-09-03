import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/ticket-collection'
import { InMemoryRetrievalEventJournal, RetrievalController } from '@retrieval-agent/domain'
import { LocalTicketProvider, parseFixtureJsonl } from '@retrieval-agent/provider-local'
import { testHybridRanker } from './support/fake-model-gateway.js'
import { buildFastTicketRequest } from '@retrieval-agent/query-understanding'
import { fixtureQueryAnalyzer } from './support/query-analyzer.js'
import { testRetrievalPolicy } from './support/retrieval-policy.js'

const NOW = new Date('2026-08-27T04:00:00.000Z')
const LEGACY_REGRESSION_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tickets', 'synthetic', 'legacy-bronze-v1.jsonl')
const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { group: ['admin'], region: ['cn'], role: ['administrator'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2030-08-28T00:00:00.000Z',
}

describe('fixed first-pass Hybrid retrieval', () => {
  it('keeps all 11 exact 副卡 title matches reachable across the unmodified fast-search result pages', async () => {
    const provider = new LocalTicketProvider(parseFixtureJsonl(await readFile(LEGACY_REGRESSION_FIXTURE, 'utf8')), {
      now: () => NOW,
      ranker: testHybridRanker(),
      defaultMode: 'hybrid',
    })
    const request = await buildFastTicketRequest('帮我查找副卡有关工单', {
      analyzer: fixtureQueryAnalyzer(['副卡']),
    })
    const spec = provider.resolve(request)
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    const seen = new Set<string>()
    let cursor: string | undefined
    let first = true
    do {
      const page = await provider.search(PRINCIPAL, snapshot.snapshotId, spec, {
        topK: 8,
        maxScan: 100,
        stage: cursor === undefined ? 'initial_hybrid' : 'next_page',
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (first) {
        expect(page.candidates).toHaveLength(8)
        expect(page.nextCursor).toBeDefined()
        expect(page.boundary).toMatchObject({
          documentsEligibleForKeywordChannel: 11,
          resultPagesExhausted: false,
          semanticRecallKnown: false,
        })
        expect(page.trace.channels).toEqual(expect.arrayContaining([
          expect.objectContaining({ channel: 'keyword', querySource: 'direct_user_keywords', resultCount: 11 }),
          expect.objectContaining({ channel: 'vector', querySource: 'direct_user_original' }),
        ]))
        first = false
      }
      page.candidates.forEach(candidate => seen.add(candidate.displayId))
      cursor = page.nextCursor
    } while (cursor !== undefined)

    expect([...seen]).toEqual(expect.arrayContaining([
      'TKT-0001', 'TKT-0002', 'TKT-0003', 'TKT-0004', 'TKT-0005', 'TKT-0007',
      'TKT-0008', 'TKT-0027', 'TKT-0028', 'TKT-0029', 'TKT-0030',
    ]))
  })

  it('keeps vector diagnostics separate while assessment selects the automatic Hybrid result collection', async () => {
    const provider = new LocalTicketProvider(parseFixtureJsonl(await readFile(LEGACY_REGRESSION_FIXTURE, 'utf8')), {
      now: () => NOW,
      ranker: testHybridRanker(),
    })
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    const dense = await provider.search(PRINCIPAL, snapshot.snapshotId, provider.resolve({
      target: 'ranked_cases', query: '主副卡解绑后仍共享流量', mode: 'dense', requestedCount: 5, countPolicy: 'explicit',
    }), { topK: 5, maxScan: 100, stage: 'baseline' })
    expect(dense.trace.executedMode).toBe('dense')
    expect(dense.trace.channels.map(channel => channel.channel)).toEqual(['vector'])

    let serial = 0
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: () => `hybrid-event-${serial++}` })
    const controller = new RetrievalController(provider, journal, undefined, {
      policy: testRetrievalPolicy(), now: () => NOW, id: () => `hybrid-domain-${serial++}`, searchTopK: 5,
    })
    let state = await controller.start(PRINCIPAL, {
      target: 'ranked_cases', query: '主副卡解绑后仍共享流量', requestedCount: 5, countPolicy: 'explicit',
    })
    expect(state.lastPage?.trace).toMatchObject({ stage: 'initial_hybrid', requestedMode: 'hybrid', executedMode: 'hybrid' })
    expect(state.lastPage?.trace.channels.map(channel => channel.channel)).toEqual(['keyword', 'vector'])
    expect(await controller.finalizeExhaustedEmptyResult(state)).toBe(state)
    state = await controller.assess(state, {
      decision: 'accept_current_top_k', evaluator: 'model',
      selectedCandidateRefs: state.candidates.map(candidate => candidate.ref), excludedCandidateRefs: [],
      gaps: [], nextAction: 'accept_current_top_k',
    })
    state = controller.freeze(state, state.selectedCandidateRefs)

    const collection = createTicketResultCollection(state)
    expect(collection).toMatchObject({ type: 'ticket_collection', stoppingReason: 'top_k_accepted' })
    expect(collection.tickets).toHaveLength(5)
    expect(collection.tickets.map(ticket => ticket.displayId)).toContain('TKT-0029')
  })
})
