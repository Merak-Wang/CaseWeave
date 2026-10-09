import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { RetrievalController, InMemoryRetrievalEventJournal } from '@retrieval-agent/domain'
import { createTicketResultCollection } from '@retrieval-agent/domain/result'
import { isReadableTicketField } from '@retrieval-agent/contracts'
import type { RetrievalState, TicketSnapshot, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { testHybridRanker } from '../../../tests/support/fake-model-gateway.js'
import { LocalTicketProviderService } from './provider.js'
import { FixturePrincipalProviderService } from './principal.js'

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/tickets/synthetic/legacy-bronze-v1.jsonl')
const principalConfig = { tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: '1', groups: ['admin'], regions: ['cn'], developmentAdmin: true }

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(FixturePrincipalProviderService, principalConfig)
  await ctx.plugin(LocalTicketProviderService, { dataPath: fixture, retrievalMode: 'hybrid', embeddingRevision: 'synthetic-pinned', ranker: testHybridRanker() })
  return ctx
}

describe('shipped Provider wrapper restoration through the real Controller', () => {
  it.each(['active', 'terminal'] as const)('rehydrates the %s snapshot and candidate identities from fresh services without a test-side restore call', async lifecycle => {
    const first = await mount()
    let saved!: RetrievalState
    try {
      const principal = await first.ticketPrincipalProvider.resolve({ sessionId: 'synthetic-old-session', operation: 'snapshot_open' })
      const controller = new RetrievalController(first.ticketRetrievalProvider, new InMemoryRetrievalEventJournal())
      const active = await controller.start(principal, { target: 'ranked_cases', query: '副卡' })
      saved = lifecycle === 'terminal' ? controller.stopIncomplete(active, 'Synthetic snapshot restoration fixture') : active
      expect(saved.candidates.length).toBeGreaterThan(0)
    } finally { await first.fiber.dispose() }
    const second = await mount()
    try {
      const principal = await second.ticketPrincipalProvider.resolve({ sessionId: 'synthetic-old-session', operation: 'detail_read' })
      expect(await second.ticketRetrievalProvider.status(principal, saved.snapshot!.snapshotId)).toMatchObject({ snapshotValid: false })
      const restore = vi.spyOn(second.ticketRetrievalProvider as LocalTicketProviderService, 'restoreSnapshot')
      const opens = vi.spyOn(second.ticketRetrievalProvider, 'openSnapshot')
      const controller = new RetrievalController(second.ticketRetrievalProvider, new InMemoryRetrievalEventJournal())
      const restored = await controller.reauthorize(principal, saved)
      expect(restored).toBe(saved)
      expect(restored.snapshot).toBe(saved.snapshot)
      expect(restored.candidates.map(c => c.ref)).toEqual(saved.candidates.map(c => c.ref))
      expect(restored.stateId).toBe(saved.stateId)
      expect(restored.phase).toBe(saved.phase)
      expect(restored.frozenEvidence?.packId ?? restored.stateId).toBe(saved.frozenEvidence?.packId ?? saved.stateId)
      if (lifecycle === 'terminal') {
        expect(restored).toMatchObject({ phase: 'stopped', termination: 'partial' })
        expect(restored.frozenEvidence?.packId).toBeDefined()
        expect(createTicketResultCollection(restored)).toEqual(createTicketResultCollection(saved))
        expect(createTicketResultCollection(restored).resultRevision).toBe(createTicketResultCollection(saved).resultRevision)
      } else {
        expect(restored.phase).not.toBe('stopped')
        expect(() => createTicketResultCollection(saved)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
        expect(() => createTicketResultCollection(restored)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
      }
      expect(restore).toHaveBeenCalledOnce()
      expect(opens).not.toHaveBeenCalled()
      const summaryField = saved.snapshot!.fieldCatalog.find(field => field.key === 'summary')
      expect(summaryField).toMatchObject({ key: 'summary', valueKind: 'text', accessLevel: 'L1' })
      expect(isReadableTicketField(summaryField!)).toBe(true)
      const candidateRefs = saved.candidates.map(c => c.ref)
      // title is an overview property, not an advertised readable evidence field.
      const titleField = saved.snapshot!.fieldCatalog.find(field => field.key === 'title')
      expect(titleField === undefined || !isReadableTicketField(titleField)).toBe(true)
      await expect(second.ticketRetrievalProvider.readDetails(principal, { snapshotId: saved.snapshot!.snapshotId,
        candidateRefs, fields: ['title'], purpose: 'candidate_export' })).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
      const details = await second.ticketRetrievalProvider.readDetails(principal, { snapshotId: saved.snapshot!.snapshotId,
        candidateRefs, fields: [summaryField!.key], purpose: 'candidate_export' })
      expect(details).toMatchObject({ snapshotId: saved.snapshot!.snapshotId, rejectedCandidateRefs: [], warnings: [] })
      expect(details.details).toHaveLength(saved.candidates.length)
      expect(details.details).toMatchObject(saved.candidates.map(c => ({ candidateRef: c.ref,
        displayId: c.displayId, sourceVersion: c.sourceVersion, title: c.title, summary: c.summary,
        fields: { [summaryField!.key]: [c.summary] }, unavailableFields: [] })))
      expect(details.evidence).toHaveLength(saved.candidates.length)
      expect(details.evidence).toMatchObject(saved.candidates.map(c => ({ candidateRef: c.ref,
        displayId: c.displayId, sourceVersion: c.sourceVersion, contentHash: c.contentHash,
        field: summaryField!.key, text: c.summary, start: 0, end: c.summary.length,
        spanHash: createHash('sha256').update(c.summary).digest('hex'), origin: c.summaryOrigin,
        snapshotId: saved.snapshot!.snapshotId, authorizationVersion: saved.snapshot!.authorizationVersion,
        principalBindingHash: saved.snapshot!.principalBindingHash, truncated: false, readers: ['provider'] })))
      await controller.reauthorize(principal, restored)
      expect(restore).toHaveBeenCalledOnce()
    } finally { await second.fiber.dispose() }
  })

  it.each(['source', 'index', 'provider', 'expiry', 'binding', 'entitlement'] as const)('preserves the strict %s gate when replaying into the shipped wrapper', async gate => {
    const first = await mount()
    let saved!: RetrievalState
    try {
      const principal = await first.ticketPrincipalProvider.resolve({ sessionId: 'synthetic-old-session', operation: 'snapshot_open' })
      saved = await new RetrievalController(first.ticketRetrievalProvider, new InMemoryRetrievalEventJournal()).start(principal, { target: 'ranked_cases', query: '副卡' })
    } finally { await first.fiber.dispose() }
    const second = await mount()
    try {
      const original = saved.snapshot!
      const change: Partial<TicketSnapshot> = gate === 'source' ? { sourceVersion: 'changed' }
        : gate === 'index' ? { indexVersion: 'changed' }
        : gate === 'provider' ? { providerId: 'changed' }
        : gate === 'expiry' ? { expiresAt: new Date(Date.now()-1).toISOString() }
        : gate === 'binding' ? { principalBindingHash: 'changed' } : { authorizationVersion: 'changed' }
      const replay = { ...saved, snapshot: { ...original, ...change } }
      const principal: TrustedPrincipalContext = await second.ticketPrincipalProvider.resolve({ sessionId: 'synthetic-old-session', operation: 'detail_read' })
      const denied = await new RetrievalController(second.ticketRetrievalProvider, new InMemoryRetrievalEventJournal()).reauthorize(principal, replay)
      expect(denied.termination).toBe(gate === 'binding' || gate === 'entitlement' ? 'permission_blocked' : 'snapshot_invalid')
      expect(denied.accessValidation).toBe('required')
      expect(denied.candidates).toEqual([])
    } finally { await second.fiber.dispose() }
  })
})
