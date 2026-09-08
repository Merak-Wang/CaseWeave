import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TicketDatabase, DatabaseTicketProvider, MilvusClient, buildIndex, queryDocument, fieldCapabilities, compileSql } from '@retrieval-agent/provider-database'
import { ModelServiceClient, type RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import { normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { compileQueryPlan, buildFastTicketRequest, SpacyQueryAnalyzer } from '@retrieval-agent/query-understanding'
import { evaluateQuery, type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { RetrievalController, InMemoryRetrievalEventJournal, foldRetrievalEvents } from '@retrieval-agent/domain'

const enabled = process.env.RETRIEVAL_AGENT_DATABASE_TEST === '1'
const modelServiceUrl = process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012'
const principal: TrustedPrincipalContext = { tenantId: 'demo', subjectId: 'test', entitlementVersion: 'v1', purpose: 'ticket_retrieval', attributes: {}, issuedAt: new Date().toISOString() }
function record(id: string, title: string, body: string, region?: string) {
  return normalizeFixtureTicket({ ticketId: id, displayId: id, tenantId: 'demo', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'test-v1', title, summary: title,
    problemDescription: body, conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable', ...(region ? { region } : {}) })
}
describe.skipIf(!enabled)('real MySQL / Milvus public provider and controller', () => {
  it('restores durable snapshots after the former demo deadline, while rejecting changed grants and sources', async () => {
    const db = new TicketDatabase(), dataset = `snapshot-lifecycle-${randomUUID()}`
    const model = new ModelServiceClient({ baseUrl: modelServiceUrl, embeddingModel: 'Qwen/Qwen3-Embedding-0.6B', embeddingRevision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3', embeddingDimensions: 1024 })
    const provider = () => new DatabaseTicketProvider(db, new MilvusClient(), model, dataset)
    try {
      await db.migrate()
      const source = await db.importRecords(dataset, [record('durable-a', '副卡', '跨域')], 'first')
      await db.publish(dataset, source)
      const snapshot = await provider().openSnapshot(principal)
      const request = await buildFastTicketRequest('副卡', { analyzer: new SpacyQueryAnalyzer({ baseUrl: modelServiceUrl }) })
      const page = await provider().search(principal, snapshot.snapshotId, { ...provider().resolve(request), mode: 'keyword' }, { topK: 10, maxScan: 100, stage: 'initial_hybrid' })
      expect(page.candidates.map(c => c.displayId)).toEqual(['durable-a'])
      // Persist the old deployment's elapsed demo deadline, then use a fresh Provider instance.
      await db.pool.query('UPDATE ra_provider_snapshot SET snapshot_json=? WHERE id=?', [JSON.stringify({ ...snapshot, expiresAt: '2020-01-01T00:00:00.000Z' }), snapshot.snapshotId])
      const restored = provider()
      expect((await restored.status(principal, snapshot.snapshotId)).snapshotValid).toBe(true)
      const details = await restored.readDetails(principal, { snapshotId: snapshot.snapshotId, candidateRefs: page.candidates.map(c => c.ref), fields: [], purpose: 'inline_detail' })
      expect(details.details.map(d => d.candidateRef)).toEqual(page.candidates.map(c => c.ref))
      expect(snapshot.expiresAt).toBeUndefined()
      await expect(restored.status({ ...principal, entitlementVersion: 'revoked' }, snapshot.snapshotId)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      const changed = await db.importRecords(dataset, [record('durable-a', '副卡', '原文已变更')], 'next')
      await db.publish(dataset, changed)
      await expect(restored.status(principal, snapshot.snapshotId)).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
      await expect(provider().status(principal, snapshot.snapshotId)).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
    } finally { await db.close() }
  }, 30_000)

  it('compiles natural language branches, enumerates every SQL hit, publishes indexes, and replays partial channel progress', async () => {
    const db = new TicketDatabase(); const milvus = new MilvusClient()
    const dataset = `acceptance-${randomUUID()}`
    const records = [record('a', '副卡', '跨域', '上海'), record('b', '副卡跨域', '测试单', '广东'), record('c', '宽带', '断网', '广东'), record('d', '跨', '域'), record('e', '副卡', '已缴清欠费仍不能上网'), record('f', 'ＡＢＣ 100%_\\', '融合')]
    try {
      await db.migrate()
      const generation = await db.importRecords(dataset, records, 'w1')
      expect(await db.importRecords(dataset, records, 'w1')).toBe(generation)
      await db.publish(dataset, generation)
      const fields = fieldCapabilities(records)
      for (const [query, terms] of [ ['副卡 AND 跨域', ['副卡', '跨域']], ['上海的副卡问题，或广东的宽带问题', ['副卡', '宽带']], ['(副卡 AND 跨域) OR (宽带 AND NOT 测试单)', ['副卡', '跨域', '宽带', '测试单']], ['正文包含“跨域”', []], ['“100%_\\”', []] ] as const) {
        const plan = compileQueryPlan(query, terms, { fields })
        const expected = records.filter(r => evaluateQuery(plan.keyword, queryDocument(r)) === true).map(r => r.ticketId).sort()
        const actual: string[] = []
        for await (const page of db.enumerate(generation, plan.keyword, fields, { pageSize: 1 })) actual.push(...page.records.map(r => r.ticketId))
        expect(actual.sort(), query).toEqual(expected)
      }
      const nullCase = compileSql({ kind: 'not', child: { kind: 'field', field: 'region', op: 'eq', values: ['上海'] } }, fields)
      const rows = await db.rows<{ ticket_id: string }>(`SELECT t.ticket_id FROM ra_ticket t WHERE generation=? AND (${nullCase.sql}) IS TRUE ORDER BY ticket_id`, [generation, ...nullCase.params])
      expect(rows.map(r => r.ticket_id)).toEqual(['b', 'c'])
      const absentLiteral = { kind: 'not', child: { kind: 'literal', field: 'resolution', op: 'contains', text: '完成' } } as const
      const absentHits = []
      for await (const page of db.enumerate(generation, absentLiteral, fields)) absentHits.push(...page.records)
      expect(absentHits).toEqual([])
      expect(records.every(r => evaluateQuery(absentLiteral, queryDocument(r)) === null)).toBe(true)
      await db.buildGrams(generation)
      const expr = compileQueryPlan('副卡 AND 跨域', ['副卡', '跨域'], { fields }).keyword
      const accelerated = []
      for await (const page of db.enumerate(generation, expr, fields, { accelerate: true, pageSize: 1 })) accelerated.push(...page.records.map(r => r.ticketId))
      expect(accelerated).toEqual(['a', 'b'])

      const identity = { model: 'Qwen/Qwen3-Embedding-0.6B', revision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3', dimensions: 1024, normalization: 'l2', metric: 'COSINE', chunkChars: 360, chunkVersion: 'field-codepoints-v3' } as const
      const model = new ModelServiceClient({ baseUrl: modelServiceUrl, embeddingModel: identity.model, embeddingRevision: identity.revision, embeddingDimensions: identity.dimensions, defaultDeadlineMs: 120_000 })
      const provider = new DatabaseTicketProvider(db, milvus, model, dataset, 3)
      const analyzer = new SpacyQueryAnalyzer({ baseUrl: modelServiceUrl })
      const request = await buildFastTicketRequest('帮我找副卡和跨域有关工单', { analyzer })
      const journal = new InMemoryRetrievalEventJournal()
      const controller = new RetrievalController(provider, journal, undefined, { searchTopK: 1 })
      const partial = await controller.start(principal, request)
      expect(partial.searchProgress?.channels.find(c => c.channel === 'keyword')?.status).toBe('completed')
      expect(partial.searchProgress?.channels.find(c => c.channel === 'vector')?.status).toBe('failed')
      expect(partial.candidates.length).toBeGreaterThan(0)
      expect(partial.lastPage?.completeness).toBe('unknown')
      expect(foldRetrievalEvents(journal.read(partial.retrievalId))?.revision).toBe(partial.revision)

      const index = await buildIndex(db, milvus, model, generation, identity)
      expect(await buildIndex(db, milvus, model, generation, identity)).toBe(index)
      await db.publish(dataset, generation, index)
      const readyProvider = new DatabaseTicketProvider(db, milvus, model, dataset, 3)
      const readyJournal = new InMemoryRetrievalEventJournal()
      const readyController = new RetrievalController(readyProvider, readyJournal, undefined, { searchTopK: 1 })
      let state = await readyController.start(principal, request)
      expect(state.searchProgress?.channels.map(c => c.status)).toEqual(['completed', 'completed'])
      const sourceRefs = new Set(state.candidates.map(c => c.displayId))
      while (state.lastPage?.nextCursor) { state = await readyController.continueRanking(principal, state); state.candidates.forEach(c => sourceRefs.add(c.displayId)) }
      expect(sourceRefs.has('a') && sourceRefs.has('b')).toBe(true)
      expect(state.lastPage?.trace.channels.find(c => c.channel === 'vector')?.implementation).toBe('milvus-rest')
      expect(state.searchProgress?.timings.embeddingComputeMs).toBeGreaterThan(0)
      // A fresh Provider process reconstructs the same identities from MySQL; no in-memory snapshot is copied.
      const restarted = new DatabaseTicketProvider(db, milvus, model, dataset, 3)
      expect((await restarted.status(principal, state.snapshot!.snapshotId)).snapshotValid).toBe(true)
      const restoredDetails = await restarted.readDetails(principal, { snapshotId: state.snapshot!.snapshotId, candidateRefs: state.candidates.map(c => c.ref), fields: [], purpose: 'inline_detail' })
      expect(restoredDetails.details.map(d => d.candidateRef)).toEqual(state.candidates.map(c => c.ref))
      const nestedRequest = await buildFastTicketRequest('(上海的副卡 OR 广东的宽带) AND NOT 测试单', { analyzer })
      expect(nestedRequest.filters).toEqual([])
      const nestedState = await new RetrievalController(readyProvider, new InMemoryRetrievalEventJournal()).start(principal, nestedRequest)
      expect(nestedState.candidates.map(c => c.displayId).sort()).toEqual(['a', 'c'])
      const unavailableRequest = await buildFastTicketRequest('现在未解决的副卡工单', { analyzer })
      const unavailableState = await new RetrievalController(readyProvider, new InMemoryRetrievalEventJournal()).start(principal, unavailableRequest)
      expect(unavailableState.query.unresolvedConstraints.length).toBeGreaterThan(0)
      expect(unavailableState.query.spec.queryPlan?.fields.find(f => f.key === 'status')?.availability).toBe('unavailable')
      expect(unavailableState.candidates).toEqual([])
      const feedbackController = new RetrievalController(readyProvider, new InMemoryRetrievalEventJournal())
      const beforeFeedback = await feedbackController.start(principal, request)
      const missingFieldFeedback = await feedbackController.applyUserFeedback(principal, beforeFeedback, {
        accepted: true, answer: '只看未解决的工单', filters: [{ field: 'status', op: 'eq', value: 'open' }],
        requirements: [{ text: '未解决', status: 'compiled', filters: [{ field: 'status', op: 'eq', value: 'open' }] }],
      })
      expect(missingFieldFeedback.query.unresolvedConstraints.some(text => text.includes('status'))).toBe(true)
      expect((await feedbackController.finalizeExhaustedEmptyResult(missingFieldFeedback)).termination).not.toBe('no_result')

      // Delay only scheduling; the released call still runs the real Qwen service and Milvus.
      let releaseVector!: () => void; let firstKeyword!: () => void; let embeds = 0
      const gate = new Promise<void>(resolve => { releaseVector = resolve })
      const keywordVisible = new Promise<void>(resolve => { firstKeyword = resolve })
      const delayed: RetrievalModelGateway = { ready: signal => model.ready(signal), rerank: input => model.rerank(input),
        embed: async input => { embeds++; await gate; return model.embed(input) } }
      const concurrentProvider = new DatabaseTicketProvider(db, milvus, delayed, dataset, 3)
      const concurrentSnapshot = await concurrentProvider.openSnapshot(principal)
      const searchOptions = { topK: 1, maxScan: 100, stage: 'initial_hybrid' as const,
        onProgress: async (progress: import('@retrieval-agent/contracts').TicketSearchProgress) => {
          if (progress.channels[0]?.count && progress.channels[1]?.status === 'running') firstKeyword()
        } }
      const first = concurrentProvider.search(principal, concurrentSnapshot.snapshotId, concurrentProvider.resolve(request), searchOptions)
      const duplicate = concurrentProvider.search(principal, concurrentSnapshot.snapshotId, concurrentProvider.resolve(request), searchOptions)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([keywordVisible, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Keyword progress waited for the vector lane')), 10_000) })])
        expect(embeds).toBe(1)
      } finally { clearTimeout(timer); releaseVector() }
      expect((await first).candidates.map(c => c.ref)).toEqual((await duplicate).candidates.map(c => c.ref))
      expect(embeds).toBe(1)

      const revised = await readyController.applyUserFeedback(principal, state, { accepted: true, answer: '只要上海', filters: [{ field: 'region', op: 'eq', value: '上海' }], requirements: [{ text: '上海', status: 'compiled', filters: [{ field: 'region', op: 'eq', value: '上海' }] }] })
      expect(revised.candidates.map(c => c.displayId)).toEqual(['a'])
      expect(revised.query.contract?.queryPlan).toEqual(revised.query.spec.queryPlan)
      const changedRegion = await readyController.applyUserFeedback(principal, revised, { accepted: true, answer: '改成广东', filters: [{ field: 'region', op: 'eq', value: '广东' }], requirements: [{ text: '广东', status: 'compiled', filters: [{ field: 'region', op: 'eq', value: '广东' }] }] })
      expect(changedRegion.candidates.every(c => ['b', 'c'].includes(c.displayId))).toBe(true)
      expect(changedRegion.candidates.length).toBeGreaterThan(0)
      expect(changedRegion.candidateHistory.some(c => c.displayId === 'a')).toBe(true)
      const updated = [record('a', '副卡', '跨域已变更', '上海'), ...records.slice(2)]
      const next = await db.importRecords(dataset, updated, 'w2')
      await expect(db.publish(dataset, next, index)).rejects.toThrow('mismatch')
      expect((await db.rows<{ operation: string }>('SELECT operation FROM ra_index_job WHERE generation=? AND ticket_id=?', [next, 'b']))[0]?.operation).toBe('delete')
      const nextIndex = await buildIndex(db, milvus, model, next, identity)
      await db.publish(dataset, next, nextIndex)
      const nextProvider = new DatabaseTicketProvider(db, milvus, model, dataset, 10)
      const nextState = await new RetrievalController(nextProvider, new InMemoryRetrievalEventJournal()).start(principal, request)
      expect(nextState.candidates.some(c => c.displayId === 'b')).toBe(false)
      expect(nextState.candidates.find(c => c.displayId === 'a')?.contentHash).not.toBe(state.candidates.find(c => c.displayId === 'a')?.contentHash)
      await expect(readyProvider.status(principal, state.snapshot!.snapshotId)).rejects.toThrow('来源已更新')
      await db.publish(dataset, generation, index)
      expect((await db.publication(dataset)).source.id).toBe(generation)
    } finally { await db.close() }
  }, 180_000)
})
