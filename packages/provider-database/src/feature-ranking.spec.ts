import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createPool } from 'mysql2/promise'
import { TicketDatabase, DatabaseTicketProvider, MilvusClient } from '@retrieval-agent/provider-database'
import { normalizeFixtureTicket, principalBinding } from '@retrieval-agent/provider-local'
import type { NumericFeatureBlock, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'

const principal: TrustedPrincipalContext = { tenantId: 'ranking', subjectId: 'reader', entitlementVersion: '1',
  purpose: 'ticket_retrieval', attributes: {}, issuedAt: new Date().toISOString() }
const identity = { model: 'fixture', revision: 'v1', dimensions: 2, normalization: 'l2', metric: 'COSINE',
  chunkChars: 360, chunkVersion: 'field-codepoints-v3' } as const
const query = '副卡跨域'
const records = [
  ['000-low', '密码重置', [0, 1]], ['010-vector', '网络故障排除', [1, 0]],
  ['020-partial', '副卡', [0, 1]], ['030-full', query, [1, 0]],
  ['040-no-vector', query, null], ['050-private', query, [1, 0]],
] as const

describe.skipIf(process.env.RETRIEVAL_AGENT_DATABASE_TEST !== '1')('query-ranked numeric feature blocks in MySQL', () => {
  let db: TicketDatabase, name: string, generation: string
  const url = process.env.RETRIEVAL_AGENT_MYSQL_URL ?? 'mysql://root@127.0.0.1:13306/retrieval_agent'
  const embed = vi.fn<RetrievalModelGateway['embed']>(), ready = vi.fn<RetrievalModelGateway['ready']>()
  const model = { embed, ready } as unknown as RetrievalModelGateway
  const provider = () => new DatabaseTicketProvider(db, new MilvusClient(), model, 'ranking')
  beforeEach(async () => {
    embed.mockReset().mockResolvedValue([[3, 0]])
    ready.mockReset().mockResolvedValue({ protocolVersion: 'retrieval-agent.models.v1', serviceVersion: 'fixture',
      ready: true, device: 'cpu', limits: { maxBatchSize: 1, maxTotalTokens: 1000, maxRerankCandidates: 1 },
      models: [{ kind: 'embedding', model: identity.model, revision: identity.revision, dimensions: 2,
        loaded: true, dtype: 'float32', device: 'cpu', maxTokens: 1000 }] })
    name = `ra_ranking_${randomUUID().replaceAll('-', '')}`
    const admin = createPool(url)
    try { await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`) } finally { await admin.end() }
    const target = new URL(url); target.pathname = `/${name}`
    db = new TicketDatabase(target.toString()); await db.migrate()
    generation = await db.importRecords('ranking', records.map(([id, summary]) => normalizeFixtureTicket({
      ticketId: id, displayId: id, tenantId: 'ranking', sourceVersion: '1', title: summary, summary,
      allowedSubjectIds: id === '050-private' ? ['another-reader'] : [], requiredAttributes: {},
      conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable',
    })), 'ranking-fixture')
    await db.pool.query('INSERT INTO ra_index(id,generation,collection_name,identity_json,status,total_chunks,completed_chunks,watermark) VALUES (?,?,?,?,?,?,?,?)',
      ['fixture-index', generation, 'unused', JSON.stringify(identity), 'ready', 0, 0, 'ranking-fixture'])
    await db.pool.query('INSERT INTO ra_numeric_feature(index_id,ordinal,ticket_id,vector_blob) VALUES ?', [records.map(([id, , vector], ordinal) => {
      const bytes = vector ? Buffer.alloc(8) : null
      vector?.forEach((value, i) => bytes!.writeFloatLE(value, i * 4))
      return ['fixture-index', ordinal, id, bytes]
    })])
    await db.publish('ranking', generation, 'fixture-index')
  })
  afterEach(async () => {
    await db.close()
    if (!/^ra_ranking_[a-f0-9]{32}$/u.test(name)) throw new Error('Unexpected test database')
    const admin = createPool(url)
    try { await admin.query(`DROP DATABASE ${name}`) } finally { await admin.end() }
  })

  it('scores original-query coverage and cosine before annotation, independently of chunk width and ID order', async () => {
    await db.buildGrams(generation)
    const p = provider(), snapshot = await p.openSnapshot(principal)
    const request = { snapshotId: snapshot.snapshotId, rankingQuery: query, limit: 20 }
    const calls = vi.spyOn(db.pool, 'query')
    const full = await p.featureBlock(principal, request)
    expect(full.ids).toEqual([0, 1, 2, 3, 4])
    expect(full.scores).toEqual([0, .5, 1 / 6, 1, .5])
    expect(full.ids.toSorted((a, b) => full.scores![b]! - full.scores![a]! || a - b)).toEqual([3, 1, 4, 2, 0])
    const batches: NumericFeatureBlock[] = []
    let cursor: string | undefined
    do {
      const block = await p.featureBlock(principal, { ...request, limit: 2, ...(cursor ? { cursor } : {}) })
      batches.push(block); cursor = block.next_cursor ?? undefined
    } while (cursor)
    expect(batches.flatMap(block => block.scores!)).toEqual(full.scores)
    expect((await p.featureBlock(principal, { ...request, ids: [4, 3, 2] })).scores).toEqual([.5, 1, 1 / 6])
    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed.mock.calls[0]![0]).toMatchObject({ texts: [query], inputType: 'query', requireCompleteInput: true })
    expect(calls.mock.calls.some(([sql]) => /SELECT .*record_json AS record/u.test(String(sql)))).toBe(false)
    // 新 Provider 沿既有 embedding 缓存复用query；没有读取全库正文或重新计算文档向量。
    expect((await provider().featureBlock(principal, request)).scores).toEqual(full.scores)
    expect(embed).toHaveBeenCalledTimes(1)
    calls.mockRestore()
  })

  it('keeps the same coverage without a prepared gram index and handles single-character queries', async () => {
    const p = provider(), snapshot = await p.openSnapshot(principal)
    const request = { snapshotId: snapshot.snapshotId, rankingQuery: query, limit: 20 }
    const scanned = await p.featureBlock(principal, request)
    expect(scanned.scores).toEqual([0, .5, 1 / 6, 1, .5])
    await db.buildGrams(generation)
    expect((await p.featureBlock(principal, request)).scores).toEqual(scanned.scores)
    expect((await p.featureBlock(principal, { ...request, rankingQuery: '副' })).scores).toEqual([0, .5, .5, 1, .5])
    expect((await p.featureBlock(principal, { snapshotId: snapshot.snapshotId, limit: 20 })).scores).toBeUndefined()
  })

  it('pages only the completed recall run and binds feature identity to that scope', async () => {
    const p = provider(), snapshot = await p.openSnapshot(principal), scope = randomUUID().replaceAll('-', '').padEnd(64, '0')
    await db.pool.query('INSERT INTO ra_search_run(id,generation,binding_hash,fingerprint,status_json) VALUES (?,?,?,?,?)',
      [scope, generation, principalBinding(principal), 'f'.repeat(64), JSON.stringify({ channels: [], timings: {}, total: 2, eligible: 6, authorized: 6, finished: true })])
    await db.pool.query('INSERT INTO ra_search_candidate(run_id,ticket_id) VALUES ?', [[['010-vector'], ['030-full']].map(([id]) => [scope, id])])
    const ordinals = await db.rows<{ ordinal: number }>(
      'SELECT f.ordinal FROM ra_numeric_feature f JOIN ra_search_candidate c ON c.ticket_id=f.ticket_id WHERE f.index_id=? AND c.run_id=? ORDER BY f.ordinal',
      ['fixture-index', scope])

    const first = await p.featureBlock(principal, { snapshotId: snapshot.snapshotId, recallScope: scope, limit: 1 })
    expect(first.ids).toEqual([Number(ordinals[0]!.ordinal)]); expect(first.next_cursor).toBe(String(ordinals[0]!.ordinal))
    const second = await p.featureBlock(principal, { snapshotId: snapshot.snapshotId, recallScope: scope, limit: 1, cursor: first.next_cursor! })
    expect(second.ids).toEqual([Number(ordinals[1]!.ordinal)]); expect(second.next_cursor).toBe(String(ordinals[1]!.ordinal))
    expect(second.feature_id).not.toBe('fixture-index')
    const outside = [0, 1, 2, 3, 4].find(id => !ordinals.some(row => Number(row.ordinal) === id))!
    await expect(p.featureBlock(principal, { snapshotId: snapshot.snapshotId, recallScope: scope, ids: [outside], limit: 1 }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    const emptyScope = `${scope.slice(0, -1)}1`
    await db.pool.query('INSERT INTO ra_search_run(id,generation,binding_hash,fingerprint,status_json) VALUES (?,?,?,?,?)',
      [emptyScope, generation, principalBinding(principal), 'e'.repeat(64), JSON.stringify({ channels: [], timings: {}, total: 0, eligible: 6, authorized: 6, finished: true })])
    const empty = await p.featureBlock(principal, { snapshotId: snapshot.snapshotId, recallScope: emptyScope, limit: 1 })
    expect(empty.ids).toEqual([]); expect(empty.next_cursor).toBeNull()
    await db.pool.query('UPDATE ra_search_run SET status_json=JSON_SET(status_json,\'$.finished\',FALSE) WHERE id=?', [scope])
    await expect(p.featureBlock(principal, { snapshotId: snapshot.snapshotId, recallScope: scope, limit: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('retries a cancelled query embedding without poisoning the resumed snapshot', async () => {
    const p = provider(), snapshot = await p.openSnapshot(principal)
    const request = { snapshotId: snapshot.snapshotId, rankingQuery: query, limit: 20 }
    const controller = new AbortController()
    embed.mockImplementationOnce(async input => {
      controller.abort(); input.signal!.throwIfAborted(); return []
    })
    await expect(p.featureBlock(principal, request, { signal: controller.signal })).rejects.toThrow()
    expect((await p.featureBlock(principal, request)).scores).toEqual([0, .5, 1 / 6, 1, .5])
    expect(embed).toHaveBeenCalledTimes(2)
  })
})
