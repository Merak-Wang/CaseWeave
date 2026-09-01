import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider } from './provider.js'
import { normalizePublicSnapshotTicket } from './source.js'
import { testHybridRanker } from '../../../tests/support/fake-model-gateway.js'

const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { environment: ['development'], role: ['administrator'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}

describe('source-native public snapshot adapter', () => {
  it('keeps unknown raw keys inside the Provider and exposes them only through declared L3 detail access', async () => {
    const record = normalizePublicSnapshotTicket({
      ticket_id: 'PUBLIC-1', source_dataset: 'example/full', source_version: 'v1', source_kind: 'real',
      title: 'Router photon fault', summary: 'A customer reports a photon fault.', queue: 'network',
      tags: ['router'], near_duplicate_group: 'router|photon', custom_note: 'unmapped-photon-extension',
    })
    const provider = new LocalTicketProvider([record], { now: () => new Date('2026-08-27T01:00:00.000Z'), ranker: testHybridRanker() })
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    expect(snapshot.fieldCatalog).toContainEqual(expect.objectContaining({ key: 'source.raw', accessLevel: 'L3' }))
    const spec = provider.resolve({
      target: 'ranked_cases', query: 'unmapped photon',
      filters: [{ field: 'source.dataset', op: 'eq', value: 'example/full' }],
    })
    const page = await provider.search(PRINCIPAL, snapshot.snapshotId, spec, { topK: 5, maxScan: 10, stage: 'baseline' })
    expect(page.candidates).toHaveLength(1)
    expect(JSON.stringify(page.candidates[0])).not.toContain('unmapped-photon-extension')
    const raw = await provider.readDetails(PRINCIPAL, {
      snapshotId: snapshot.snapshotId,
      candidateRefs: [page.candidates[0]!.ref],
      fields: ['source.raw'],
      purpose: 'inline_detail',
    })
    expect(raw.details[0]?.fields['source.raw']?.join('\n')).toContain('unmapped-photon-extension')
  })

  it('rejects dynamic filters that the source catalog did not declare', () => {
    const provider = new LocalTicketProvider([normalizePublicSnapshotTicket({
      ticket_id: 'PUBLIC-2', source_dataset: 'example/full', source_version: 'v1',
      title: 'Example', summary: 'Example record', custom_filter: 'hidden',
    })])
    expect(() => provider.resolve({
      target: 'ranked_cases', query: 'Example', filters: [{ field: 'source.custom_filter', op: 'eq', value: 'hidden' }],
    })).toThrow(/不支持筛选字段/u)
  })
})
