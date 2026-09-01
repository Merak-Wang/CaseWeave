import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { TicketFilter, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider, parseFixtureJsonl } from '@retrieval-agent/provider-local'
import { testHybridRanker } from './support/fake-model-gateway.js'

interface BronzeCase {
  readonly caseId: string
  readonly target: 'ranked_cases' | 'constrained_list' | 'cohort_collection' | 'resolution_path'
  readonly retrievalIntent?: 'known_item' | 'analogous_case'
  readonly query: string
  readonly filters: readonly TicketFilter[]
  readonly qrels: readonly { readonly ticketId: string }[]
}

const principal: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { group: ['admin'], role: ['administrator'], environment: ['development'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}

describe('migrated 162-case Bronze development baseline', () => {
  it('keeps every historical qrel in the deterministic Provider top 10', async () => {
    const records = parseFixtureJsonl(await readFile('packages/bundle/fixtures/tickets.jsonl', 'utf8'))
    const cases = (await readFile('python/evals/data/legacy-bronze-v1/cases.jsonl', 'utf8'))
      .split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as BronzeCase)
    const provider = new LocalTicketProvider(records, { now: () => new Date('2026-08-27T01:00:00.000Z'), ranker: testHybridRanker() })
    const opened = await provider.openSnapshot(principal)
    const failures: string[] = []
    for (const testCase of cases) {
      const spec = provider.resolve({
        target: testCase.target,
        query: testCase.query,
        filters: testCase.filters,
        ...(testCase.retrievalIntent === undefined ? {} : { retrievalIntent: testCase.retrievalIntent }),
        requestedCount: 10,
      })
      const page = await provider.search(principal, opened.snapshotId, spec, { topK: 10, maxScan: 100, stage: 'baseline' })
      const found = new Set(page.candidates.map(candidate => candidate.displayId))
      for (const qrel of testCase.qrels) if (!found.has(qrel.ticketId)) failures.push(`${testCase.caseId}:${qrel.ticketId}`)
      if (testCase.qrels.length === 0 && page.candidates.length > 0) failures.push(`${testCase.caseId}:expected-empty`)
    }
    expect(cases).toHaveLength(162)
    expect(failures).toEqual([])
  })
})
