import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { InMemoryRetrievalEventJournal, RetrievalController } from '@retrieval-agent/domain'
import { LocalTicketProvider, parseFixtureJsonl } from '@retrieval-agent/provider-local'
import { CandidateExportService, InMemoryExportAuditSink } from '@retrieval-agent/product-api'
import { exportCandidatesForAgent } from '@retrieval-agent/product-host'
import { projectTicketCandidateNode } from '@retrieval-agent/ui-ticket-results'
import { bundledFixturePath } from '@retrieval-agent/bundle/startup'

const NOW = new Date('2026-08-27T04:00:00.000Z')
const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo',
  subjectId: 'demo-user',
  entitlementVersion: 'fixture-entitlements-v1',
  purpose: 'ticket_retrieval',
  attributes: { group: ['support'], region: ['cn'] },
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
    const provider = new LocalTicketProvider(records, { now: () => NOW, snapshotTtlMs: 60_000 })
    const eventIds = ids('event')
    const controllerIds = ids('domain')
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: eventIds })
    const controller = new RetrievalController(provider, journal, undefined, {
      now: () => NOW,
      id: controllerIds,
      searchTopK: 10,
      maxEvidenceTokens: 100,
    })

    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录', requestedCount: 5 })
    state = await controller.search(PRINCIPAL, state)
    expect(state.candidates.map(candidate => candidate.displayId)).toEqual(['INC-1002', 'INC-1001'])
    expect(state.candidates.map(candidate => candidate.displayId)).not.toContain('INC-1003')
    expect(state.candidates.map(candidate => candidate.displayId)).not.toContain('INC-1004')
    expect(state.candidates.map(candidate => candidate.displayId)).not.toContain('INC-1005')

    const selected = state.candidates[0]!
    state = controller.assess(state, {
      decision: 'continue',
      selectedCandidateRefs: [selected.ref],
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [selected.ref], evaluator: 'model' }],
    })
    state = await controller.promote(PRINCIPAL, state, [selected.ref], ['rootCause', 'resolutionSteps'], 100)
    state = controller.assess(state, {
      decision: 'sufficient',
      selectedCandidateRefs: [selected.ref],
      gaps: [{ kind: 'depth', status: 'resolved', evidenceRefs: state.promotedEvidence.map(evidence => evidence.evidenceId), evaluator: 'model' }],
    })
    state = controller.freeze(state, [selected.ref])

    const node = projectTicketCandidateNode(journal.read(state.retrievalId), state.retrievalId)
    expect(node).toMatchObject({ status: 'results', completeness: 'exhaustive', exportEnabled: true })
    expect(node.alreadyReadEvidence.length).toBeGreaterThan(0)

    const audit = new InMemoryExportAuditSink()
    const exportIds = ['export-fixture', 'audit-fixture']
    const exported = await new CandidateExportService(provider, audit, {
      now: () => NOW,
      id: () => exportIds.shift()!,
    }).exportCsv(PRINCIPAL, state, [selected.ref])
    expect(exported.content).toContain(selected.displayId)
    expect(exported.receipt.rowCount).toBe(1)
    expect(audit.records).toHaveLength(1)

    const hostAudit = new InMemoryExportAuditSink()
    const agent = {
      ctx: {
        ticketRetrievalProvider: provider,
        retrievalAgent: {
          currentOrUndefined: () => state,
          principal: () => Promise.resolve(PRINCIPAL),
        },
      },
    } as unknown as Parameters<typeof exportCandidatesForAgent>[0]
    const hostExport = await exportCandidatesForAgent(agent, {
      sessionId: 'fixture-session', retrievalId: state.retrievalId, candidateRefs: [selected.ref],
    }, hostAudit)
    expect(hostExport.contentUtf8).toContain(selected.displayId)
    expect(hostAudit.records).toHaveLength(1)

    await expect(new CandidateExportService(provider, audit).exportCsv({ ...PRINCIPAL, subjectId: 'other-user' }, state, [selected.ref]))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
