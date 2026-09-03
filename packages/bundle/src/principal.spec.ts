import { Context } from '@deepseek-ai/cordis'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FixturePrincipalProviderService } from './principal.js'
import { LocalTicketProviderService } from './provider.js'
import { StreamClusterTicketProviderService } from './streamcluster-provider.js'
import { testHybridRanker } from '../../../tests/support/fake-model-gateway.js'

const LEGACY_REGRESSION_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'tickets', 'synthetic', 'legacy-bronze-v1.jsonl')

describe('Cordis service wrappers', () => {
  it('rejects an unpinned model identity for the Hybrid development provider', async () => {
    const ctx = new Context()
    try {
      await expect(ctx.plugin(LocalTicketProviderService, {
        dataPath: LEGACY_REGRESSION_FIXTURE,
        providerId: 'unpinned-hybrid',
        retrievalMode: 'hybrid',
      })).rejects.toThrow('pinned embeddingRevision')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves the development principal and local provider through Cordis trace proxies', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(FixturePrincipalProviderService, {
        tenantId: 'demo',
        subjectId: 'development-admin',
        entitlementVersion: 'development-admin-v1',
        groups: ['admin'],
        regions: ['cn'],
        developmentAdmin: true,
      })
      await ctx.plugin(LocalTicketProviderService, {
        dataPath: LEGACY_REGRESSION_FIXTURE,
        providerId: 'cordis-proxy-local-v1',
        retrievalMode: 'keyword',
        ranker: testHybridRanker(),
      })

      const principal = await ctx.ticketPrincipalProvider.resolve({
        sessionId: 'cordis-proxy-session',
        operation: 'snapshot_open',
      })
      const query = ctx.ticketRetrievalProvider.resolve({
        target: 'ranked_cases',
        query: '副卡',
        requestedCount: 5,
        countPolicy: 'explicit',
        mode: 'keyword',
      })
      const snapshot = await ctx.ticketRetrievalProvider.openSnapshot(principal)
      const page = await ctx.ticketRetrievalProvider.search(principal, snapshot.snapshotId, query, {
        topK: 5,
        maxScan: 1_000,
        stage: 'baseline',
      })

      expect(principal.attributes).toMatchObject({ role: ['administrator'], environment: ['development'] })
      expect(ctx.ticketRetrievalProvider.providerId).toBe('cordis-proxy-local-v1')
      expect(page.candidates.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('can read the StreamCluster wrapper through a Cordis trace proxy before network I/O', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StreamClusterTicketProviderService, { baseUrl: 'http://127.0.0.1:9' })
      expect(ctx.ticketRetrievalProvider.providerId).toBe('streamcluster-v1')
      expect(ctx.ticketRetrievalProvider.resolve({ target: 'ranked_cases', query: '副卡', requestedCount: 5, countPolicy: 'explicit' }))
        .toMatchObject({ normalizedQuery: '副卡', requestedCount: 5 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
