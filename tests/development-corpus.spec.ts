import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider, parseTicketDatasetJsonl } from '@retrieval-agent/provider-local'
import { bundledDefaultTicketPaths, bundledFixtureRoot } from '@retrieval-agent/bundle/startup'
import { testHybridRanker } from './support/fake-model-gateway.js'

const ADMIN: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { group: ['admin'], role: ['administrator'], environment: ['development'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}

describe('complete captured development corpus', () => {
  it('loads the complete default ESFT train profile and searches provider-declared source fields', async () => {
    const manifest = JSON.parse(await readFile(join(bundledFixtureRoot(), 'manifest.json'), 'utf8'))
    expect(manifest.sourcePolicy).toMatchObject({
      authoritativeSource: 'deepseek-ai/ESFT',
      runtimeTicketSources: ['deepseek-ai/ESFT'],
      fallbackSources: [],
    })
    expect(Object.keys(manifest.ticketProfiles)).toEqual(['esft-summary-train-v1'])
    expect(Object.keys(manifest.evaluations)).toEqual(['esft-summary-eval-v1'])
    const records = (await Promise.all(bundledDefaultTicketPaths()
      .map(async path => parseTicketDatasetJsonl(await readFile(path, 'utf8'))))).flat()
    expect(records).toHaveLength(manifest.ticketProfiles[manifest.defaultTicketProfile].recordCount)
    expect(records).toHaveLength(19_587)
    expect(new Set(records.map(record => record.ticketId)).size).toBe(19_587)
    expect(records.filter(record => record.rawSource !== undefined)).toHaveLength(19_587)
    expect(records.every(record => record.piiRedactionStatus === 'redacted')).toBe(true)
    expect(records.every(record => {
      const source = record.rawSource?.payload as Readonly<Record<string, unknown>> | undefined
      return source !== undefined
        && typeof source.title === 'string'
        && typeof source.summary === 'string'
        && Array.isArray(source.raw_dialogue)
        && !('answer' in source)
        && !('answers' in source)
        && !('prompt' in source)
        && !JSON.stringify(source).includes('请总结下面这段客服对话')
    })).toBe(true)

    const provider = new LocalTicketProvider(records, {
      now: () => new Date('2026-08-27T01:00:00.000Z'), maxPageSize: 50, ranker: testHybridRanker(),
    })
    const snapshot = await provider.openSnapshot(ADMIN)
    expect(snapshot.fieldCatalog.map(field => field.key)).toContain('source.raw')
    const spec = provider.resolve({
      target: 'constrained_list', query: '副卡流量费用',
      filters: [{ field: 'source.dataset', op: 'eq', value: 'deepseek-ai/ESFT' }],
    })
    const page = await provider.search(ADMIN, snapshot.snapshotId, spec, { topK: 20, maxScan: 50_000, stage: 'baseline' })
    expect(page.candidates.length).toBeGreaterThan(0)
    expect(page.candidates.every(candidate => candidate.displayId.startsWith('ESFT-SUMMARY-TRAIN-'))).toBe(true)
  // This is an exhaustive 19,587-row integrity/search check using the deterministic
  // CPU fake ranker. Its watchdog is a test-runner guard, not a production startup SLA.
  }, 120_000)
})
