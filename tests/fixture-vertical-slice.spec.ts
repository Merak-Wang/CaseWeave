import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { InMemoryRetrievalEventJournal, RetrievalController } from '@retrieval-agent/domain'
import { LocalTicketProvider, parseFixtureJsonl } from '@retrieval-agent/provider-local'
import { CandidateExportService, InMemoryExportAuditSink } from '@retrieval-agent/product-api'
import { projectTicketCandidateNode } from '@retrieval-agent/ui-ticket-results'
import { testHybridRanker } from './support/fake-model-gateway.js'

const NOW = new Date('2026-08-27T04:00:00.000Z')
const LEGACY_REGRESSION_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tickets', 'synthetic', 'legacy-bronze-v1.jsonl')
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
  it('searches summary-bearing candidates, reads controlled body evidence, replays UI, and reauthorizes export', async () => {
    const records = parseFixtureJsonl(await readFile(LEGACY_REGRESSION_FIXTURE, 'utf8'))
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
    })

    let state = await controller.start(PRINCIPAL, {
      target: 'resolution_path', query: '如何处理：主副卡解绑后仍共享流量',
      countPolicy: 'adaptive',
    })
    expect(state.lastPage?.trace.stage).toBe('initial_hybrid')
    expect(state.candidates[0]?.displayId).toBe('TKT-0029')

    const selected = state.candidates[0]!
    state = controller.recordContextSelection(state, controller.projectContext(state))
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId, judgments: [],
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [selected.ref], evaluator: 'model', description: 'Need the documented handling steps.' }],
      action: { kind: 'inspect', candidateRefs: [selected.ref], fields: ['answer'] },
    })
    state = controller.recordContextSelection(state, controller.projectContext(state))
    const evidence = state.promotedEvidence.find(item => item.candidateRef === selected.ref)!
    expect(evidence).toBeDefined()
    state = await controller.decide(PRINCIPAL, state, { stateId: state.stateId,
      judgments: [{ candidateRef: selected.ref, verdict: 'accept', evidenceRefs: [evidence.evidenceId], reason: 'The documented steps resolve the unbinding/sharing issue.' }],
      gaps: [{ kind: 'depth', status: 'resolved', evidenceRefs: [evidence.evidenceId], evaluator: 'model' }],
      action: { kind: 'finish', explanation: 'The controlled steps provide a supported resolution case.' },
    })
    const node = projectTicketCandidateNode(journal.read(state.retrievalId), state.retrievalId)
    expect(node).toMatchObject({ status: 'results', completeness: 'bounded', exportEnabled: true })
    expect(node.alreadyReadEvidence.map(item => item.evidenceId)).toContain(evidence.evidenceId)
    expect(node.result).toMatchObject({
      type: 'ticket_collection',
      complete: false,
      topKAccepted: true,
      resultPagesExhausted: false,
      stoppingReason: 'top_k_accepted',
      tickets: [{ displayId: selected.displayId }],
    })
    expect(node.result?.tickets.map(candidate => candidate.ref)).toEqual([selected.ref])
    expect(node.result?.undeterminedCandidates?.map(candidate => candidate.ref)).toEqual(state.candidates.filter(candidate => candidate.ref !== selected.ref).map(candidate => candidate.ref))

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
