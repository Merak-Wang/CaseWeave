import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createPool } from 'mysql2/promise'
import { TicketDatabase, DatabaseTicketProvider, MilvusClient } from '@retrieval-agent/provider-database'
import { normalizeFixtureTicket, canRead, LocalTicketProvider } from '@retrieval-agent/provider-local'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'

const principal: TrustedPrincipalContext = { tenantId: 'scale', subjectId: 'reader', entitlementVersion: '1',
  purpose: 'ticket_retrieval', attributes: {}, issuedAt: new Date().toISOString() }
const ticket = (id: string, region = '上海', summary = '副卡') => normalizeFixtureTicket({ ticketId: id, displayId: id,
  tenantId: 'scale', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: '1', title: '副卡', summary,
  region, conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable' })
describe.skipIf(process.env.RETRIEVAL_AGENT_DATABASE_TEST !== '1')('database bounded reads and retained snapshots', () => {
  let db: TicketDatabase, name: string
  const url = process.env.RETRIEVAL_AGENT_MYSQL_URL ?? 'mysql://root@127.0.0.1:13306/retrieval_agent'
  const provider = () => new DatabaseTicketProvider(db, new MilvusClient(), {} as RetrievalModelGateway, 'scale')
  beforeEach(async () => {
    name = `ra_scale_${randomUUID().replaceAll('-', '')}`
    const admin = createPool(url)
    try { await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`) } finally { await admin.end() }
    const target = new URL(url); target.pathname = `/${name}`
    db = new TicketDatabase(target.toString()); await db.migrate()
  })
  afterEach(async () => {
    await db.close()
    if (!/^ra_scale_[a-f0-9]{32}$/u.test(name)) throw new Error('Unexpected test database')
    const admin = createPool(url)
    try { await admin.query(`DROP DATABASE ${name}`) } finally { await admin.end() }
  })
  it('materializes all keyword IDs once while returning only the requested body window', async () => {
    const records = Array.from({ length: 1200 }, (_, i) => ticket(String(i).padStart(4, '0'), '上海', i % 2 ? '宽带' : '到期'))
    const gen = await db.importRecords('scale', records, 'bulk-keyword'); await db.publish('scale', gen)
    const p = provider(), snapshot = await p.openSnapshot(principal)
    const spec = { ...p.resolve({ target: 'ranked_cases', query: '宽带 到期', mode: 'keyword' }),
      semanticHints: ['包年变包月'], keywordQuery: { terms: ['宽带', '到期'], operator: 'or' as const } }
    const calls = vi.spyOn(db.pool, 'query')
    const page = await p.search(principal, snapshot.snapshotId, spec, { topK: 100, maxScan: 50, stage: 'repair_search' })
    expect(page.boundary.rankedHits).toBe(1200)
    expect(page.candidates).toHaveLength(100)
    expect(page.nextCursor).toBeTruthy()
    const next = await p.search(principal, snapshot.snapshotId, spec, { topK: 100, maxScan: 50, stage: 'next_page', cursor: page.nextCursor! })
    expect(next.candidates).toHaveLength(100)
    expect(next.candidates.some(c => page.candidates.some(first => first.ref === c.ref))).toBe(false)
    expect(calls.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO ra_search_candidate(run_id,ticket_id,keyword_hit'))).toHaveLength(1)
    expect(calls.mock.calls.some(([sql]) => String(sql).includes('t.ticket_id>? ORDER BY t.ticket_id LIMIT'))).toBe(false)
    calls.mockRestore()
  }, 60_000)
  it('coalesces the same query across provider instances and rebuilds an interrupted result set', async () => {
    const generation = await db.importRecords('scale', [ticket('a'), ticket('b')], '1')
    await db.publish('scale', generation)
    const first = provider(), second = provider(), snapshot = await first.openSnapshot(principal)
    const spec = first.resolve({ target: 'ranked_cases', query: '副卡', mode: 'keyword',
      fastQuery: { schemaVersion: 2, source: 'direct_user', rewriteApplied: false,
        keyword: { terms: ['副卡'], operator: 'or' }, vector: { text: '副卡' } } })
    const options = { topK: 20, maxScan: 1, stage: 'initial_hybrid' as const }
    const calls = vi.spyOn(db.pool, 'query')
    const [a, b] = await Promise.all([first.search(principal, snapshot.snapshotId, spec, options), second.search(principal, snapshot.snapshotId, spec, options)])
    expect(a.candidates).toEqual(b.candidates)
    expect(calls.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT IGNORE INTO ra_search_run'))).toHaveLength(1)
    calls.mockRestore()
    const [run] = await db.rows<{ id: string }>('SELECT id FROM ra_search_run')
    await db.pool.query("UPDATE ra_search_run SET status_json=JSON_SET(status_json,'$.finished',FALSE) WHERE id=?", [run!.id])
    await db.pool.query("UPDATE ra_search_candidate SET vector_rank=1,vector_score=1,fused_score=1 WHERE run_id=? AND ticket_id='b'", [run!.id])
    await db.pool.query('INSERT INTO ra_search_candidate(run_id,ticket_id) VALUES (?,?)', [run!.id, 'interrupted-stale-hit'])
    const resumed = await provider().search(principal, snapshot.snapshotId, spec, options)
    expect(resumed.candidates).toEqual(a.candidates)
    expect(resumed.boundary.rankedHits).toBe(2)
    expect(resumed.trace.signals.every(s => s.channels.every(c => c.channel === 'keyword'))).toBe(true)
  })
  it('pushes the complete trusted grant into SQL and still rejects revoked source access on reread', async () => {
    const records = [ticket('public'), normalizeFixtureTicket({ ...ticket('other-user'), allowedSubjectIds: ['someone-else'] }),
      normalizeFixtureTicket({ ...ticket('private'), requiredAttributes: { 'team.with.dots': ['support'] } }),
      normalizeFixtureTicket({ ...ticket('pii'), piiRedactionStatus: 'unreviewed' }),
      normalizeFixtureTicket({ ...ticket('other-tenant'), tenantId: 'another' })]
    const gen = await db.importRecords('scale', records, '1'); await db.publish('scale', gen)
    let reread: (() => Promise<unknown>) | undefined
    for (const p of [principal, { ...principal, attributes: { 'team.with.dots': ['support'] } }]) {
      const backend = provider(), snapshot = await backend.openSnapshot(p)
      const spec = backend.resolve({ target: 'ranked_cases', query: '副卡', mode: 'keyword',
        fastQuery: { schemaVersion: 2, source: 'direct_user', rewriteApplied: false, keyword: { terms: ['副卡'], operator: 'or' }, vector: { text: '副卡' } } })
      const result = await backend.search(p, snapshot.snapshotId, spec, { topK: 20, maxScan: 1, stage: 'initial_hybrid' })
      expect(result.candidates.map(c => c.displayId).sort()).toEqual(records.filter(r => canRead(r, p)).map(r => r.displayId).sort())
      expect(result.boundary.semanticRecallKnown).toBe(false)
      if (p === principal) reread = () => backend.readDetails(p, { snapshotId: snapshot.snapshotId,
        candidateRefs: [result.candidates[0]!.ref], fields: ['summary'], purpose: 'inline_detail' })
    }
    const next = await db.importRecords('scale', records.map(r => r.ticketId === 'public' ? { ...r, allowedSubjectIds: ['another-reader'] } : r), '2')
    await db.publish('scale', next)
    await expect(reread!()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
  it('does not load the corpus, filters before capacity admission, ties literal scores and restores the same references', async () => {
    const generation = await db.importRecords('scale', [ticket('a'), ticket('b', '北京'), ticket('c')], '1')
    await db.publish('scale', generation)
    const fullRead = vi.spyOn(db, 'records').mockRejectedValue(new Error('online corpus loading forbidden'))
    const p = provider(), snapshot = await p.openSnapshot(principal)
    const spec = p.resolve({ target: 'ranked_cases', query: '副卡', mode: 'keyword',
      fastQuery: { schemaVersion: 2, source: 'direct_user', rewriteApplied: false, keyword: { terms: ['副卡'], operator: 'or' }, vector: { text: '副卡' } }, filters: [{ field: 'region', op: 'eq', value: '上海' }] })
    const first = await p.search(principal, snapshot.snapshotId, spec, { topK: 1, maxScan: 2, stage: 'initial_hybrid' })
    const second = await p.search(principal, snapshot.snapshotId, spec, { topK: 1, maxScan: 2, stage: 'initial_hybrid', cursor: first.nextCursor! })
    expect([first.candidates[0]?.displayId, second.candidates[0]?.displayId]).toEqual(['a', 'c'])
    expect(first.trace.signals[0]?.fusedScore).toBe(second.trace.signals[0]?.fusedScore)
    expect(fullRead).not.toHaveBeenCalled()
    fullRead.mockRestore()
    const next = await db.importRecords('scale', [ticket('a'), ticket('b', '北京'), ticket('c'), ticket('new')], '2')
    await db.publish('scale', next)
    const restored = provider()
    expect((await restored.status(principal, snapshot.snapshotId)).snapshotValid).toBe(true)
    const result = await restored.readDetails(principal, { snapshotId: snapshot.snapshotId,
      candidateRefs: [first.candidates[0]!.ref], fields: ['summary'], purpose: 'inline_detail' })
    expect(result.details[0]?.candidateRef).toBe(first.candidates[0]!.ref)
    await expect(restored.status({ ...principal, entitlementVersion: 'revoked' }, snapshot.snapshotId)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    // Reproduce the installed pre-v2 provider's composite hashes, opaque refs and offset cursor.
    const old = new LocalTicketProvider([ticket('a'), ticket('b', '北京'), ticket('c')], { providerId: p.providerId, defaultMode: 'hybrid', indexVersion: 'vector-unavailable' })
    const oldSnapshot = await old.openSnapshot(principal)
    const oldPage = old.projectRanking(principal, oldSnapshot.snapshotId, spec, { topK: 1, maxScan: 20, stage: 'initial_hybrid' }, {
      hits: ['a', 'c'].map((id, i) => ({ documentId: id, rank: i + 1, score: 1 / (61 + i), channels: [{ channel: 'keyword', rank: i + 1, score: 1 }] })),
      execution: { requestedMode: 'keyword', executedMode: 'keyword', strategyVersion: 'legacy', channels: [] },
      scanned: 3, keywordEligible: 2, rankedHits: 2, warnings: [],
    }, performance.now())
    expect(oldSnapshot.sourceVersion).not.toBe(generation)
    expect(oldSnapshot.indexVersion).not.toBe('vector-unavailable')
    await db.pool.query('INSERT INTO ra_provider_snapshot(id,dataset_id,generation,index_id,snapshot_json) VALUES (?,?,?,?,?)',
      [oldSnapshot.snapshotId, 'scale', generation, null, JSON.stringify({ ...oldSnapshot, expiresAt: '2020-01-01T00:00:00Z' })])
    const legacy = await provider().readDetails(principal, { snapshotId: oldSnapshot.snapshotId,
      candidateRefs: [oldPage.candidates[0]!.ref], fields: ['summary'], purpose: 'inline_detail' })
    expect(legacy.details[0]?.candidateRef).toBe(oldPage.candidates[0]!.ref)
    expect((await provider().status(principal, oldSnapshot.snapshotId)).sourceVersion).toBe(oldSnapshot.sourceVersion)
    const rebased = await provider().search(principal, oldSnapshot.snapshotId, spec, { topK: 1, maxScan: 2,
      stage: 'next_page', cursor: oldPage.nextCursor! })
    expect(rebased.candidates[0]?.ref).toBe(oldPage.candidates[0]?.ref)
    expect(rebased.warnings.some(w => w.startsWith('ranking_rebased:'))).toBe(true)
    const changed = await db.importRecords('scale', [ticket('a', '上海', 'changed'), ticket('c')], '3')
    await db.publish('scale', changed)
    await expect(restored.readDetails(principal, { snapshotId: snapshot.snapshotId,
      candidateRefs: [first.candidates[0]!.ref], fields: ['summary'], purpose: 'inline_detail' })).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
  })
})
