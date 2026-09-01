import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider, parseTicketDatasetJsonl } from '@retrieval-agent/provider-local'
import { testHybridRanker } from './support/fake-model-gateway.js'

const ADMIN: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { group: ['admin'], role: ['administrator'], environment: ['development'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}

describe('complete captured development corpus', () => {
  it('loads all 2,040 captured records and searches provider-declared source fields', async () => {
    const root = 'packages/bundle/fixtures'
    const paths = [
      'tickets.jsonl',
      'public/fcc-1000-seed-20260825.jsonl',
      'public/bitext-1000-seed-20260825.jsonl',
    ]
    const records = (await Promise.all(paths.map(async path => parseTicketDatasetJsonl(await readFile(join(root, path), 'utf8'))))).flat()
    expect(records).toHaveLength(2_040)
    expect(new Set(records.map(record => record.ticketId)).size).toBe(2_040)
    expect(records.filter(record => record.rawSource !== undefined)).toHaveLength(2_000)

    const provider = new LocalTicketProvider(records, {
      now: () => new Date('2026-08-27T01:00:00.000Z'), maxRequestedCount: 50, ranker: testHybridRanker(),
    })
    const snapshot = await provider.openSnapshot(ADMIN)
    expect(snapshot.fieldCatalog.map(field => field.key)).toContain('source.raw')
    const spec = provider.resolve({
      target: 'constrained_list', query: 'Unwanted Calls', requestedCount: 20,
      filters: [{ field: 'source.dataset', op: 'eq', value: 'fcc/consumer-complaints-data' }],
    })
    const page = await provider.search(ADMIN, snapshot.snapshotId, spec, { topK: 20, maxScan: 50_000, stage: 'baseline' })
    expect(page.candidates.length).toBeGreaterThan(0)
    expect(page.candidates.every(candidate => candidate.displayId.startsWith('FCC-'))).toBe(true)
  })
})
