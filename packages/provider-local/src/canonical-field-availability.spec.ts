import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { sourceEvidenceFields } from '../../domain/src/evidence-requirements.js'
import { testHybridRanker } from '../../../tests/support/fake-model-gateway.js'
import { LocalTicketProvider } from './provider.js'
import { normalizeFixtureTicket } from './fixture.js'

const now = new Date('2026-10-08T00:00:00Z')
const principal: TrustedPrincipalContext = { tenantId: 'synthetic', subjectId: 'reader',
  entitlementVersion: 'v1', purpose: 'ticket_retrieval', attributes: {}, issuedAt: now.toISOString() }
const row = normalizeFixtureTicket({ ticketId: 'synthetic-1', displayId: 'synthetic-1', tenantId: 'synthetic',
  sourceVersion: 'v1', allowedSubjectIds: [], requiredAttributes: {}, title: '合成设备故障', summary: '合成摘要',
  conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable' })

describe('canonical provider declaration for fixed custom intent', () => {
  it('declares the actual projection and unavailable raw fields instead of phantom source evidence', async () => {
    const provider = new LocalTicketProvider([row], { ranker: testHybridRanker(), now: () => now,
      documentProjection: 'canonical-title-abstract-v1' })
    const snapshot = await provider.openSnapshot(principal)
    expect(snapshot.documentProjection).toBe('canonical-title-abstract-v1')
    const raw = snapshot.fieldCatalog.filter(field => ['L2', 'L3'].includes(field.accessLevel))
    expect(raw.length).toBeGreaterThanOrEqual(6)
    expect(raw.every(field => field.capability?.availability === 'unavailable')).toBe(true)
    expect(sourceEvidenceFields(snapshot.fieldCatalog)).toEqual([])
    expect(snapshot.fieldCatalog.find(field => field.key === 'summary')?.accessLevel).toBe('L1')
  })

  it('leaves the legacy document projection and its source evidence vocabulary unchanged', async () => {
    const provider = new LocalTicketProvider([row], { ranker: testHybridRanker(), now: () => now,
      documentProjection: 'ticket-search-projection-v1' })
    const snapshot = await provider.openSnapshot(principal)
    expect(snapshot.documentProjection).toBe('ticket-search-projection-v1')
    expect(sourceEvidenceFields(snapshot.fieldCatalog).some(field => field.key === 'problemDescription')).toBe(true)
  })
})
