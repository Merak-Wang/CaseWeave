import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { InMemoryRetrievalEventJournal, RetrievalController } from '@retrieval-agent/domain'
import { LocalTicketProvider, parseFixtureJsonl } from '@retrieval-agent/provider-local'
import { CandidateExportService, InMemoryExportAuditSink } from '@retrieval-agent/product-api'
import { projectTicketCandidateNode } from '@retrieval-agent/ui-ticket-results'
import { bundledFixturePath } from '@retrieval-agent/bundle/startup'
import { testHybridRanker } from './support/fake-model-gateway.js'

const NOW = new Date('2026-08-27T04:00:00.000Z')
const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo',
  subjectId: 'development-admin',
  entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval',
  attributes: { group: ['admin'], region: ['cn'], role: ['administrator'], environment: ['development'] },
  issuedAt: '2026-08-27T00:00:00.000Z',
  expiresAt: '2026-08-28T00:00:00.000Z',
}

function ids(prefix: string): () => string {
  let value = 0
  return () => `${prefix}-${value++}`
}

describe('fixture vertical slice', () => {
  it('searches one authorized snapshot, promotes evidence, replays UI, and reauthorizes export', async () => {
    const records = parseFixtureJsonl(await readFile(bundledFixturePath(), 'utf8'))
    const provider = new LocalTicketProvider(records, {
      now: () => NOW,
      snapshotTtlMs: 60_000,
      ranker: testHybridRanker(),
    })
    const eventIds = ids('event')
    const controllerIds = ids('domain')
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: eventIds })
    const controller = new RetrievalController(provider, journal, undefined, {
      now: () => NOW,
      id: controllerIds,
      searchTopK: 10,
      maxEvidenceTokens: 100,
    })

    let state = await controller.start(PRINCIPAL, {
      target: 'resolution_path', query: '如何处理：主副卡解绑后仍共享流量',
      requestedCount: 5, countPolicy: 'adaptive',
    })
    expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
    expect(state.candidates[0]?.displayId).toBe('TKT-0029')

    const selected = state.candidates[0]!
    state = controller.assess(state, {
      decision: 'continue',
      coverage: 0.6,
      candidateQuality: 0.9,
      selectedCandidateRefs: [selected.ref],
      excludedCandidateRefs: [],
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [selected.ref], evaluator: 'model' }],
      nextAction: 'promote',
      stop: false,
    })
    state = await controller.promote(PRINCIPAL, state, [selected.ref], ['problemDescription', 'answer'], 100)
    state = controller.assess(state, {
      decision: 'sufficient',
      coverage: 0.9,
      candidateQuality: 0.95,
      selectedCandidateRefs: [selected.ref],
      excludedCandidateRefs: [],
      gaps: [{ kind: 'depth', status: 'resolved', evidenceRefs: state.promotedEvidence.map(evidence => evidence.evidenceId), evaluator: 'model' }],
      nextAction: 'finish',
      stop: true,
    })
    state = controller.freeze(state, [selected.ref])
    const node = projectTicketCandidateNode(journal.read(state.retrievalId), state.retrievalId)
    expect(node).toMatchObject({ status: 'results', completeness: 'bounded', exportEnabled: true })
    expect(node.alreadyReadEvidence.length).toBeGreaterThan(0)
    expect(node.result).toMatchObject({
      type: 'ticket_collection',
      complete: false,
      topKAccepted: true,
      sourceExhausted: false,
      stoppingReason: 'sufficient',
      tickets: [{ displayId: selected.displayId }],
    })
    expect(node.candidates.map(candidate => candidate.ref)).toEqual([selected.ref])

    const audit = new InMemoryExportAuditSink()
    const exportIds = ['export-fixture', 'audit-fixture']
    const exported = await new CandidateExportService(provider, audit, {
      now: () => NOW,
      id: () => exportIds.shift()!,
    }).exportCsv(PRINCIPAL, state, [selected.ref])
    expect(exported.content).toContain(selected.displayId)
    expect(exported.receipt.rowCount).toBe(1)
    expect(audit.records).toHaveLength(1)

    await expect(new CandidateExportService(provider, audit).exportCsv({ ...PRINCIPAL, subjectId: 'other-user' }, state, [selected.ref]))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
