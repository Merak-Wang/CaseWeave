import { randomUUID } from 'node:crypto'
import { RetrievalError, assertTrustedPrincipal, validateQueryExpression, TicketSnapshotId, TicketCandidateRef,
  type DetailReadRequest, type EvidenceReadRequest, type ProviderCallOptions, type TicketRetrievalProvider,
  type TicketRetrievalRequest, type TicketRetrievalSpec, type TicketSearchOptions, type TicketSearchPage,
  type TicketSnapshot, type TrustedPrincipalContext, type QueryExpression } from '@retrieval-agent/contracts'
import { LocalTicketProvider, principalBinding, sha256, stableJson, shortOpaque, candidateL0, matchFragment,
  overviewOrigin, projectDetails, projectEvidence } from '@retrieval-agent/provider-local'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import type { ResultSetHeader } from 'mysql2/promise'
import { TicketDatabase, type Generation, type IndexGeneration } from './store.js'
import { DatabaseQueryStore } from './query-store.js'
import { MilvusClient } from './milvus.js'
import { ticketChunks } from './projection.js'

const PROFILE = 'mysql-milvus-set-vector-v2'
interface Entry { source: Generation; index?: IndexGeneration; snapshot: TicketSnapshot }
interface Channel { channel: 'keyword' | 'vector'; status: 'running' | 'completed' | 'failed' | 'skipped'; count: number; error?: string; cursor?: string }
interface Run { channels: Channel[]; timings: Record<string, number>; total: number; eligible: number; authorized: number; finished: boolean }
interface Hit { ticket_id: string; keyword_hit: number; vector_rank: number | null; vector_score: number | null; fused_score: number }
interface Cursor { run: string; score: number; id: string; offset: number }
const all: QueryExpression = { kind: 'constant', value: true }
const and = (...children: QueryExpression[]): QueryExpression => ({ kind: 'and', children })
function filters(spec: TicketRetrievalSpec): QueryExpression {
  return spec.filters.length ? and(...spec.filters.map((f): QueryExpression => {
    if (f.op === 'gte' || f.op === 'lte') return { kind: 'field', field: f.field, op: 'range', ...(f.op === 'gte' ? { lower: f.value } : { upper: f.value, upperInclusive: true }) }
    const expr: QueryExpression = { kind: 'field', field: f.field, op: f.op === 'contains' ? 'in' : 'eq', values: [f.value] }
    return f.op === 'neq' ? { kind: 'not', child: expr } : expr
  })) : all
}
/** Online searches keep identities and indexed rankings in SQL; only requested windows cross into Node. */
export class DatabaseTicketProvider implements TicketRetrievalProvider {
  readonly providerId = 'mysql-milvus-v1'
  readonly #inflight = new Map<string, Promise<Run>>()
  readonly #resolver = new LocalTicketProvider([], { defaultMode: 'hybrid' })
  readonly #query: DatabaseQueryStore
  constructor(readonly db: TicketDatabase, readonly milvus: MilvusClient, readonly model: RetrievalModelGateway,
    readonly datasetId = 'esft-development', readonly denseTopK = 15) { this.#query = new DatabaseQueryStore(db) }
  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec { return this.#resolver.resolve(request) }
  async openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot> {
    assertTrustedPrincipal(principal); options?.signal?.throwIfAborted()
    const { source, index } = await this.db.publication(this.datasetId)
    const snapshotId = TicketSnapshotId(shortOpaque('snap', principalBinding(principal), source.id, index?.id ?? '', randomUUID()))
    const snapshot: TicketSnapshot = { snapshotId, shortId: sha256(snapshotId).slice(0, 10), providerId: this.providerId,
      createdAt: new Date().toISOString(), sourceVersion: source.id, indexVersion: index?.id ?? 'vector-unavailable',
      retrievalProfileVersion: PROFILE, authorizationVersion: principal.entitlementVersion,
      principalBindingHash: principalBinding(principal), queryPolicyVersion: 'query-policy-v1', queryFields: source.fields_json,
      fieldCatalog: (await this.#query.catalog(source.id)).map(f => { const capability = source.fields_json.find(c => c.key === f.key); return { ...f, ...(capability ? { capability } : {}) } }),
      capabilities: { exhaustive: true, pagination: true, evidencePromotion: true, detailRead: true, exportRead: true,
        keywordSearch: true, denseSearch: true, hybridFusion: true, reranking: false } }
    await this.db.pool.query('INSERT INTO ra_provider_snapshot(id,dataset_id,generation,index_id,snapshot_json) VALUES (?,?,?,?,?)',
      [snapshotId, this.datasetId, source.id, index?.id ?? null, JSON.stringify(snapshot)])
    options?.signal?.throwIfAborted()
    return snapshot
  }
  async #entry(principal: TrustedPrincipalContext, snapshotId: TicketSnapshot['snapshotId']): Promise<Entry> {
    assertTrustedPrincipal(principal)
    const saved = (await this.db.rows<{ generation: string; index_id: string | null; snapshot_json: TicketSnapshot }>(
      'SELECT generation,index_id,snapshot_json FROM ra_provider_snapshot WHERE id=? AND dataset_id=?', [snapshotId, this.datasetId]))[0]
    if (!saved) throw new RetrievalError('SNAPSHOT_NOT_FOUND', '数据库快照不存在。')
    const { expiresAt: _legacyDeadline, ...snapshot } = saved.snapshot_json
    if (snapshot.providerId !== this.providerId || snapshot.snapshotId !== snapshotId) throw new RetrievalError('SNAPSHOT_INVALID', '快照身份不一致。')
    if (snapshot.principalBindingHash !== principalBinding(principal) || snapshot.authorizationVersion !== principal.entitlementVersion) throw new RetrievalError('UNAUTHORIZED', '当前身份无权恢复此快照。')
    const source = await this.db.generation(saved.generation)
    const index = saved.index_id ? (await this.db.rows<IndexGeneration>('SELECT * FROM ra_index WHERE id=?', [saved.index_id]))[0] : undefined
    // Pre-v2 snapshots used LocalTicketProvider's composite source/index hashes.
    if (source.dataset_id !== this.datasetId || snapshot.retrievalProfileVersion === PROFILE
        && (snapshot.sourceVersion !== source.id || snapshot.indexVersion !== (saved.index_id ?? 'vector-unavailable'))
      || saved.index_id && (!index || index.generation !== source.id || index.status !== 'ready'
        || index.watermark !== source.source_watermark || index.completed_chunks !== index.total_chunks)) throw new RetrievalError('SNAPSHOT_INVALID', '快照来源或索引已不可用。')
    return { source, ...(index ? { index } : {}), snapshot }
  }
  async search(principal: TrustedPrincipalContext, snapshotId: TicketSnapshot['snapshotId'], spec: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
    if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 100 || !Number.isSafeInteger(options.maxScan) || options.maxScan < 1) throw new RetrievalError('INVALID_REQUEST', '单页数量必须为 1–100，读取批次容量必须为正整数。')
    options.signal?.throwIfAborted()
    const entry = await this.#entry(principal, snapshotId), key = sha256(stableJson({ snapshotId, spec, profile: PROFILE }))
    let pending = this.#inflight.get(key)
    if (!pending) {
      pending = this.db.exclusiveSearch(key, async () => {
        const saved = (await this.db.rows<{ status_json: Run }>('SELECT status_json FROM ra_search_run WHERE id=?', [key]))[0]?.status_json
        return saved?.finished ? saved : this.#retrieve(entry, principal, spec, options, key)
      }, options.signal)
      this.#inflight.set(key, pending)
    }
    try { return await this.#page(entry, principal, spec, options, key, await pending) }
    finally { if (this.#inflight.get(key) === pending) this.#inflight.delete(key) }
  }
  async #page(entry: Entry, principal: TrustedPrincipalContext, spec: TicketRetrievalSpec, options: TicketSearchOptions, key: string, run: Run): Promise<TicketSearchPage> {
    options.signal?.throwIfAborted()
    let cursor: Cursor | undefined, rebased = false
    if (options.cursor) {
      const decoded = Buffer.from(options.cursor, 'base64url').toString('utf8')
      if (!decoded.startsWith('{') && entry.snapshot.retrievalProfileVersion !== PROFILE) {
        const [offset, fingerprint, signature, extra] = decoded.split(':')
        if (extra !== undefined || !/^\d+$/u.test(offset ?? '') || fingerprint !== sha256(stableJson(spec))
          || signature !== sha256(`${entry.snapshot.snapshotId}:${offset}:${fingerprint}`).slice(0, 16)) throw new RetrievalError('INVALID_REQUEST', '旧游标不属于当前查询。')
        // Ranking semantics changed; restart enumeration instead of skipping an old offset in a new order.
        rebased = true
      } else {
        try { cursor = JSON.parse(decoded) as Cursor } catch { throw new RetrievalError('INVALID_REQUEST', '检索游标无效。') }
        if (!cursor || cursor.run !== key || !Number.isFinite(cursor.score) || typeof cursor.id !== 'string' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new RetrievalError('INVALID_REQUEST', '游标不属于当前查询。')
      }
    }
    const hits = await this.db.rows<Hit>(`SELECT ticket_id,keyword_hit,vector_rank,vector_score,fused_score FROM ra_search_candidate
      WHERE run_id=? ${cursor ? 'AND (fused_score<? OR (fused_score=? AND ticket_id>?))' : ''}
      ORDER BY fused_score DESC,ticket_id LIMIT ?`, [key, ...(cursor ? [cursor.score, cursor.score, cursor.id] : []), options.topK + 1])
    const selected = hits.slice(0, options.topK), ids = selected.map(h => h.ticket_id)
    await this.#query.validate(entry.source.id, (await this.db.publication(this.datasetId)).source.id, ids, principal)
    const records = new Map((await this.#query.records(entry.source.id, ids, false)).map(r => [r.ticketId as string, r]))
    const offset = cursor?.offset ?? 0, terms = spec.keywordQuery?.terms ?? []
    const candidates = selected.map((hit, i) => {
      const r = records.get(hit.ticket_id)!
      const fragment = (field: 'title' | 'summary') => { const match = matchFragment(r[field], terms); return match ? [{ field, ...match }] : [] }
      return { ref: TicketCandidateRef(shortOpaque('cand', entry.snapshot.snapshotId, r.ticketId)), displayId: r.displayId,
        sourceVersion: r.sourceVersion, snapshotId: entry.snapshot.snapshotId, contentHash: r.contentHash,
        evidenceLevel: 'L1' as const, projectionVersion: 2 as const, title: r.title, summary: r.summary,
        summaryOrigin: overviewOrigin(r, 'summary'), titleOrigin: overviewOrigin(r, 'title'), l0: candidateL0(r), rank: offset + i + 1,
        matchFragments: [...fragment('title'), ...fragment('summary')], matchSignals: { keywordTerms: [...terms],
          channels: [...(hit.keyword_hit ? ['keyword' as const] : []), ...(hit.vector_rank ? ['vector' as const] : [])] } }
    })
    if (candidates.length) await this.db.pool.query('INSERT IGNORE INTO ra_provider_candidate(snapshot_id,candidate_ref,ticket_id,source_hash) VALUES ?',
      [candidates.map((c, i) => [entry.snapshot.snapshotId, c.ref, selected[i]!.ticket_id, c.contentHash])])
    const complete = run.channels.filter(c => c.status === 'completed'), last = selected.at(-1), hasNext = hits.length > selected.length
    options.signal?.throwIfAborted()
    return { snapshotId: entry.snapshot.snapshotId, queryFingerprint: sha256(stableJson(spec)), candidates,
      completeness: !run.finished || run.channels.some(c => c.status === 'failed') ? 'unknown' : hasNext ? 'bounded' : 'exhaustive',
      ...(run.finished && hasNext && last ? { nextCursor: Buffer.from(JSON.stringify({ run: key, score: last.fused_score, id: last.ticket_id, offset: offset + selected.length })).toString('base64url') } : {}),
      scanned: run.eligible, returned: candidates.length, elapsedMs: run.timings.elapsedMs ?? 0, appliedFilters: [...spec.filters],
      warnings: [...run.channels.filter(c => c.status === 'failed').map(c => `channel_failed:${c.channel}:${c.error}`), ...(rebased ? ['ranking_rebased:排序规则升级，已从头枚举并保留原候选引用。'] : [])],
      trace: { stage: options.stage, requestedMode: spec.mode,
        executedMode: complete.length === 2 ? 'hybrid' : complete[0]?.channel === 'vector' ? 'dense' : 'keyword', strategyVersion: PROFILE,
        channels: complete.map(c => ({ channel: c.channel, implementation: c.channel === 'keyword' ? 'mysql-locate-set' : 'milvus-rest',
          version: c.channel === 'keyword' ? entry.source.id : entry.index!.id, resultCount: c.count, elapsedMs: run.timings[`${c.channel}Ms`] ?? 0,
          querySource: options.stage === 'repair_search' ? 'agent_rewrite' : c.channel === 'keyword' ? 'direct_user_keywords' : 'direct_user_original' })),
        signals: candidates.map((c, i) => { const h = selected[i]!; return { candidateRef: c.ref, finalRank: c.rank, fusedScore: h.fused_score,
          channels: [...(h.keyword_hit ? [{ channel: 'keyword' as const, rank: 1, score: 1 }] : []),
            ...(h.vector_rank ? [{ channel: 'vector' as const, rank: h.vector_rank, score: h.vector_score! }] : [])] } }) },
      boundary: { authorizedCorpusSize: run.authorized, documentsAfterStructuredFilters: run.eligible,
        documentsEligibleForKeywordChannel: run.channels[0]!.count, rankedHits: run.total,
        resultPagesExhausted: run.finished && !hasNext && !run.channels.some(c => c.status === 'failed'), semanticRecallKnown: false } }
  }
  async #retrieve(entry: Entry, principal: TrustedPrincipalContext, spec: TicketRetrievalSpec, options: TicketSearchOptions, key: string): Promise<Run> {
    const started = performance.now(), current = await this.db.publication(this.datasetId)
    const hard = and(spec.queryPlan?.hard ?? all, filters(spec)), unchanged = JSON.stringify(spec.keywordQuery) === JSON.stringify(spec.fastQuery?.keyword)
    const keyword = unchanged && spec.queryPlan ? spec.queryPlan.keyword : spec.keywordQuery
      ? { kind: spec.keywordQuery.operator, children: spec.keywordQuery.terms.map(text => ({ kind: 'literal' as const, op: 'contains' as const, text })) } as QueryExpression
      : spec.queryPlan?.keyword ?? { kind: 'constant' as const, value: false }
    const expression = and(hard, keyword, ...spec.excludedTerms.map(text => ({ kind: 'not' as const, child: { kind: 'literal' as const, op: 'contains' as const, text } })))
    validateQueryExpression(expression, entry.source.fields_json); validateQueryExpression(hard, entry.source.fields_json)
    const scope = (e: QueryExpression) => this.#query.scope(entry.source.id, current.source.id, principal, e, entry.source.fields_json, Boolean(entry.source.grams_ready))
    const [authorizedScope, eligibleScope, keywordScope] = await Promise.all([scope(all), scope(hard), scope(expression)])
    const [authorized, eligible] = await Promise.all([this.#query.count(authorizedScope), this.#query.count(eligibleScope)])
    const run: Run = { channels: [{ channel: 'keyword', status: spec.mode === 'dense' ? 'skipped' : 'running', count: 0 },
      { channel: 'vector', status: spec.mode === 'keyword' ? 'skipped' : 'running', count: 0 }],
      timings: { parseMs: spec.queryPlan?.elapsedMs ?? 0 }, total: 0, eligible, authorized, finished: false }
    await this.db.pool.query('INSERT IGNORE INTO ra_search_run(id,generation,binding_hash,fingerprint,status_json) VALUES (?,?,?,?,?)',
      [key, entry.source.id, principalBinding(principal), sha256(stableJson(spec)), JSON.stringify(run)])
    // A crashed attempt may contain partial vector ranks. Rebuild under the cross-process lock;
    // never merge a previous attempt's scores or counts into the new channel outcome.
    await this.db.pool.query('DELETE FROM ra_search_candidate WHERE run_id=?', [key])
    await this.db.pool.query('DELETE FROM ra_search_hit WHERE run_id=?', [key])
    let tail = Promise.resolve()
    const notify = () => {
      tail = tail.then(async () => {
        options.signal?.throwIfAborted(); run.timings.elapsedMs = performance.now() - started
        await this.db.pool.query('UPDATE ra_search_run SET status_json=? WHERE id=?', [JSON.stringify(run), key])
        if (options.onProgress) {
          const { cursor: _cursor, ...first } = options
          const page = await this.#page(entry, principal, spec, first, key, run)
          await options.onProgress({ page: { ...page, completeness: 'unknown', boundary: { ...page.boundary, resultPagesExhausted: false } }, channels: structuredClone(run.channels), timings: { ...run.timings } })
        }
      }); return tail
    }
    const add = async (ids: string[], channel: 'keyword' | 'vector', rank = 1, score = 1, detail?: unknown) => {
      if (!ids.length) return
      options.signal?.throwIfAborted()
      const [inserted] = await this.db.pool.query<ResultSetHeader>('INSERT IGNORE INTO ra_search_candidate(run_id,ticket_id) VALUES ?', [ids.map(id => [key, id])])
      run.total += inserted.affectedRows
      if (channel === 'keyword') await this.db.pool.query('UPDATE ra_search_candidate SET keyword_hit=TRUE,fused_score=1.0/61+IF(vector_rank IS NULL,0,1.0/(60+vector_rank)) WHERE run_id=? AND ticket_id IN (?)', [key, ids])
      else await this.db.pool.query('UPDATE ra_search_candidate SET vector_rank=?,vector_score=?,fused_score=IF(keyword_hit,1.0/61,0)+1.0/(60+?) WHERE run_id=? AND ticket_id=?', [rank, score, rank, key, ids[0]])
      await this.db.pool.query(`INSERT INTO ra_search_hit(run_id,ticket_id,channel,rank_no,score,source_hash,detail_json)
        SELECT ?,ticket_id,?,?,?,content_hash,? FROM ra_ticket WHERE generation=? AND ticket_id IN (?)
        ON DUPLICATE KEY UPDATE rank_no=VALUES(rank_no),score=VALUES(score),detail_json=VALUES(detail_json)`,
      [key, channel, rank, score, detail === undefined ? null : JSON.stringify(detail), entry.source.id, ids])
    }
    const work = async (i: number, execute: () => Promise<void>) => {
      const c = run.channels[i]!; if (c.status === 'skipped') return
      const at = performance.now()
      try { await execute(); c.status = 'completed' }
      catch (error) {
        if (options.signal?.aborted || error instanceof RetrievalError && ['UNAUTHORIZED', 'SNAPSHOT_INVALID', 'SNAPSHOT_NOT_FOUND'].includes(error.code)) throw error
        c.status = 'failed'; c.error = error instanceof Error ? error.message : 'Channel unavailable'
      }
      run.timings[`${c.channel}Ms`] = performance.now() - at
      await notify()
    }
    await notify()
    const outcomes = await Promise.allSettled([
      work(0, async () => {
        const at = performance.now()
        for await (const ids of this.#query.ids(keywordScope, Math.min(500, options.maxScan), options.signal)) {
          run.timings.sqlFirstBatchMs ??= performance.now() - started
          await add(ids, 'keyword'); run.channels[0]!.count += ids.length; run.channels[0]!.cursor = ids.at(-1)!
          await notify()
        }
        run.timings.sqlMs = performance.now() - at
      }),
      work(1, async () => {
        if (!entry.index) throw new Error('No index published for this SQL generation')
        const ready = await this.model.ready(options.signal), identity = ready.models.find(m => m.kind === 'embedding')
        if (identity?.model !== entry.index.identity_json.model || identity.revision !== entry.index.identity_json.revision || identity.dimensions !== entry.index.identity_json.dimensions) throw new Error('Query model and published index identities differ')
        const at = performance.now()
        const [vector] = await this.model.embed({ texts: [options.stage === 'repair_search' ? spec.semanticQuery ?? spec.normalizedQuery : spec.queryPlan?.vector.text ?? spec.fastQuery?.vector.text ?? spec.originalQuery], inputType: 'query', requireCompleteInput: true,
          onTiming: values => { run.timings.embeddingQueueMs = values.queueMs ?? 0; run.timings.embeddingComputeMs = values.computeMs ?? 0 }, ...(options.signal ? { signal: options.signal } : {}) })
        if (!vector || vector.length !== entry.index.identity_json.dimensions) throw new Error('Embedding/index dimension mismatch')
        run.timings.embeddingMs = performance.now() - at
        const ann = performance.now()
        const found = eligible === entry.source.record_count
          ? await this.milvus.searchCollection(entry.index.collection_name, vector, this.denseTopK, options.signal)
          : await this.milvus.searchBatches(entry.index.collection_name, vector, this.#query.ids(eligibleScope, Math.min(1000, options.maxScan), options.signal), this.denseTopK, options.signal)
        run.timings.milvusMs = performance.now() - ann
        const ids = found.map(h => h.ticket_id)
        await this.#query.validate(entry.source.id, (await this.db.publication(this.datasetId)).source.id, ids, principal)
        const records = new Map((await this.#query.records(entry.source.id, ids, true)).map(r => [r.ticketId as string, r]))
        for (const hit of found) {
          const record = records.get(hit.ticket_id)
          if (!record || record.contentHash !== hit.content_hash || record.sourceVersion !== hit.source_version) throw new Error('Milvus source identity mismatch')
          const chunk = ticketChunks(record, entry.index.identity_json.chunkChars).find(c => c.id === hit.id)
          if (!chunk || chunk.textHash !== hit.text_hash || chunk.field !== hit.field || chunk.part !== Number(hit.part) || chunk.start !== Number(hit.start) || chunk.end !== Number(hit.end)) throw new Error('Milvus fragment identity mismatch')
          await add([hit.ticket_id], 'vector', ++run.channels[1]!.count, hit.distance, hit)
        }
      }),
    ])
    await tail
    const failed = outcomes.find(o => o.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    run.finished = true; run.timings.elapsedMs = performance.now() - started
    await this.db.pool.query('UPDATE ra_search_run SET status_json=? WHERE id=?', [JSON.stringify(run), key])
    return run
  }
  async #references(entry: Entry, principal: TrustedPrincipalContext, refs: readonly TicketCandidateRef[]): Promise<Map<string, string>> {
    const found = new Map<string, string>(), current = await this.db.publication(this.datasetId)
    for (let offset = 0; offset < refs.length; offset += 500) {
      const batch = refs.slice(offset, offset + 500)
      let rows = await this.db.rows<{ candidate_ref: string; ticket_id: string }>('SELECT candidate_ref,ticket_id FROM ra_provider_candidate WHERE snapshot_id=? AND candidate_ref IN (?)', [entry.snapshot.snapshotId, batch])
      // Compatibility for saved pre-v2 snapshots, which did not persist issued identities.
      if (rows.length !== batch.length && entry.snapshot.retrievalProfileVersion !== PROFILE) rows = await this.db.rows<{ candidate_ref: string; ticket_id: string }>(
        "SELECT CONCAT('cand_',LEFT(SHA2(CONCAT(?,CHAR(0),ticket_id),256),32)) candidate_ref,ticket_id FROM ra_ticket WHERE generation=? HAVING candidate_ref IN (?)", [entry.snapshot.snapshotId, entry.source.id, batch])
      await this.#query.validate(entry.source.id, current.source.id, rows.map(r => r.ticket_id), principal)
      for (const row of rows) found.set(row.candidate_ref, row.ticket_id)
    }
    return found
  }
  async readFeatures(principal: TrustedPrincipalContext,
    request: { readonly snapshotId: TicketSnapshotId; readonly candidateRefs: readonly TicketCandidateRef[] }, options?: ProviderCallOptions) {
    const entry = await this.#entry(principal, request.snapshotId), refs = await this.#references(entry, principal, request.candidateRefs)
    if (refs.size !== new Set(request.candidateRefs).size) throw new RetrievalError('UNAUTHORIZED', '特征读取需要当前已授权候选。')
    if (!entry.index) return []
    const records = await this.#query.records(entry.source.id, [...refs.values()], true)
    const vectors = new Map<string, number[][]>()
    for (const record of records) {
      const chunks = ticketChunks(record, entry.index.identity_json.chunkChars)
      const parts: number[][] = []
      for (let start = 0; start < chunks.length; start += 256) {
        const batch = chunks.slice(start, start + 256)
        const found = await this.milvus.readVectors(entry.index.collection_name, batch.map(c => c.id), options?.signal)
        for (const value of found) {
          if (!batch.some(c => c.id === value.id) || value.ticket_id !== record.ticketId || value.content_hash !== record.contentHash
            || value.source_version !== record.sourceVersion) throw new Error('Milvus feature source mismatch')
          parts.push(value.vector)
        }
      }
      vectors.set(record.ticketId, parts)
    }
    await this.#references(entry, principal, request.candidateRefs)
    return [...refs].map(([ref, id]) => {
      const record = records.find(r => r.ticketId === id)!
      return { ref, version: record.sourceVersion, content_hash: record.contentHash,
        embedding_id: sha256(stableJson(entry.index!.identity_json)), vectors: vectors.get(id) ?? [] }
    })
  }

  async scanFeatures(principal: TrustedPrincipalContext,
    request: { snapshotId: TicketSnapshotId; cursor?: string; limit: number }, options?: ProviderCallOptions) {
    const entry = await this.#entry(principal, request.snapshotId), current = await this.db.publication(this.datasetId)
    const scope = await this.#query.scope(entry.source.id, current.source.id, principal, all, entry.source.fields_json)
    const records = await this.db.rows<{ ticket_id: string; source_version: string; content_hash: string }>(
      `SELECT t.ticket_id,t.source_version,t.content_hash FROM ${scope.from} WHERE ${scope.where} AND t.ticket_id>? ORDER BY t.ticket_id LIMIT ?`,
      [...scope.params, request.cursor ?? '', request.limit])
    const ids = records.map(r => r.ticket_id), byId = new Map(records.map(r => [r.ticket_id, r]))
    const features = new Map<string, { sum: number[]; parts: number }>()
    if (entry.index) for (const v of await this.milvus.ticketVectors(entry.index.collection_name, ids, options?.signal)) {
      const r = byId.get(v.ticket_id)
      if (!r || r.content_hash !== v.content_hash || r.source_version !== v.source_version) throw new RetrievalError('SNAPSHOT_INVALID', '全库特征版本与工单不一致。')
      const aggregate = features.get(v.ticket_id)
      if (aggregate) { for (let i = 0; i < v.vector.length; i++) aggregate.sum[i]! += v.vector[i]!; aggregate.parts++ }
      else features.set(v.ticket_id, { sum: [...v.vector], parts: 1 })
    }
    await this.#query.validate(entry.source.id, (await this.db.publication(this.datasetId)).source.id, ids, principal)
    // 相同的分片均值在 Provider 内聚合；跨进程每条只传一个向量，Python 再做 L2 归一化。
    const featureId = entry.index ? sha256(stableJson({ embedding: entry.index.identity_json, projection: 'mean-chunks-l2-v1' })) : ''
    const rows = records.map(r => {
      const feature = features.get(r.ticket_id)
      return { ref: shortOpaque('cand', request.snapshotId, r.ticket_id), version: r.source_version,
        content_hash: r.content_hash, embedding_id: featureId, vectors: feature ? [feature.sum.map(v => v / feature.parts)] : [] }
    })
    if (rows.length) await this.db.pool.query('INSERT IGNORE INTO ra_provider_candidate(snapshot_id,candidate_ref,ticket_id,source_hash) VALUES ?',
      [rows.map((r, i) => [request.snapshotId, r.ref, ids[i], r.content_hash])])
    return { rows, ...(!request.cursor ? { total: await this.#query.count(scope) } : {}),
      ...(records.length === request.limit ? { nextCursor: ids.at(-1)! } : {}) }
  }
  async featureBlock(principal: TrustedPrincipalContext,
    request: Parameters<NonNullable<TicketRetrievalProvider['featureBlock']>>[1], options?: ProviderCallOptions) {
    options?.signal?.throwIfAborted()
    const entry = await this.#entry(principal, request.snapshotId), current = await this.db.publication(this.datasetId)
    if (!entry.index) throw new RetrievalError('PROVIDER_UNAVAILABLE', '数值索引未准备；不会全库逐条强判。')
    const scope = await this.#query.scope(entry.source.id, current.source.id, principal,
      filters({ filters: request.filters ?? [] } as unknown as TicketRetrievalSpec), entry.source.fields_json)
    const refIds = request.refs ? [...(await this.#references(entry, principal, request.refs)).values()] : undefined
    const selector = request.ids ? 'f.ordinal IN (?)' : refIds ? 'f.ticket_id IN (?)' : 'f.ordinal>?'
    if (request.ids?.length === 0 || refIds?.length === 0) return { ids: [], dense: '', available: '', dimensions: entry.index.identity_json.dimensions, feature_id: entry.index.id, next_cursor: null }
    const rows = await this.db.rows<{ ordinal: number; ticket_id: string; vector_blob: Buffer | null }>(
      `SELECT f.ordinal,f.ticket_id,f.vector_blob FROM ${scope.from} JOIN ra_numeric_feature f ON f.index_id=? AND f.ticket_id=t.ticket_id WHERE ${scope.where} AND ${selector} ORDER BY f.ordinal LIMIT ?`,
      // scope 的 FROM 参数在 JOIN 参数之前，WHERE 参数在之后。
      [...(current.source.id === entry.source.id ? [] : [current.source.id]), entry.index.id,
        ...scope.params.slice(current.source.id === entry.source.id ? 0 : 1), request.ids ?? refIds ?? Number(request.cursor ?? -1), request.limit])
    const byId = new Map(rows.map(r => [Number(r.ordinal), r]))
    const ordered = request.ids ? request.ids.map(id => byId.get(id)!) : rows
    if (ordered.some(r => !r)) throw new RetrievalError('UNAUTHORIZED', '数值 ID 不属于授权查询范围。')
    if (!request.cursor && !request.ids && !request.refs) {
      const prepared = await this.db.rows<{ n: number }>('SELECT COUNT(*) n FROM ra_numeric_feature WHERE index_id=?', [entry.index.id])
        if (Number(prepared[0]?.n) !== Number(entry.source.record_count)) throw new RetrievalError('PROVIDER_UNAVAILABLE', '数值索引不完整，请重新执行索引准备。')
    }
    const dimensions = entry.index.identity_json.dimensions
    return { ids: ordered.map(r => Number(r.ordinal)), dimensions,
      dense: Buffer.concat(ordered.map(r => r.vector_blob ?? Buffer.alloc(dimensions * 4))).toString('base64'),
      available: Buffer.from(ordered.map(r => r.vector_blob ? 1 : 0)).toString('base64'), feature_id: entry.index.id,
      next_cursor: !request.ids && !request.refs && rows.length === request.limit ? String(rows.at(-1)!.ordinal) : null }
  }
  async resolveFeatureIds(principal: TrustedPrincipalContext,
    request: Parameters<NonNullable<TicketRetrievalProvider['resolveFeatureIds']>>[1], options?: ProviderCallOptions) {
    const entry = await this.#entry(principal, request.snapshotId)
    if (!request.ids.length) return []
    const rows = await this.db.rows<{ ordinal: number; ticket_id: string; content_hash: string }>(
      'SELECT f.ordinal,f.ticket_id,t.content_hash FROM ra_numeric_feature f JOIN ra_ticket t ON t.generation=? AND t.ticket_id=f.ticket_id WHERE f.index_id=? AND f.ordinal IN (?)',
      [entry.source.id, entry.index?.id, request.ids])
    await this.#query.validate(entry.source.id, (await this.db.publication(this.datasetId)).source.id, rows.map(r => r.ticket_id), principal)
    const refs = new Map(rows.map(r => [Number(r.ordinal), TicketCandidateRef(shortOpaque('cand', request.snapshotId, r.ticket_id))]))
    if (rows.length !== new Set(request.ids).size) throw new RetrievalError('UNAUTHORIZED', '数值 ID 不属于当前索引。')
    await this.db.pool.query('INSERT IGNORE INTO ra_provider_candidate(snapshot_id,candidate_ref,ticket_id,source_hash) VALUES ?',
      [rows.map(r => [request.snapshotId, refs.get(Number(r.ordinal)), r.ticket_id, r.content_hash])])
    return this.readCandidates(principal, { snapshotId: request.snapshotId, candidateRefs: request.ids.map(id => refs.get(id)!) }, options)
  }
  async readCandidates(principal: TrustedPrincipalContext,
    request: { snapshotId: TicketSnapshotId; candidateRefs: readonly TicketCandidateRef[] }, options?: ProviderCallOptions) {
    options?.signal?.throwIfAborted()
    const entry = await this.#entry(principal, request.snapshotId), refs = await this.#references(entry, principal, request.candidateRefs)
    if (refs.size !== new Set(request.candidateRefs).size) throw new RetrievalError('UNAUTHORIZED', '工单不属于授权全库。')
    const records = new Map((await this.#query.records(entry.source.id, [...refs.values()], false)).map(r => [r.ticketId as string, r]))
    return request.candidateRefs.map(ref => {
      const r = records.get(refs.get(ref)!)!
      return { ref, displayId: r.displayId, sourceVersion: r.sourceVersion, contentHash: r.contentHash,
        snapshotId: request.snapshotId, evidenceLevel: 'L1' as const, projectionVersion: 2 as const, rank: 0,
        title: r.title, summary: r.summary, summaryOrigin: overviewOrigin(r, 'summary'), titleOrigin: overviewOrigin(r, 'title'),
        l0: candidateL0(r), matchFragments: [], matchSignals: { channels: [], keywordTerms: [] } }
    })
  }
  async readEvidence(principal: TrustedPrincipalContext, request: EvidenceReadRequest, options?: ProviderCallOptions) {
    options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget < 1) throw new RetrievalError('INVALID_REQUEST', '证据 token 预算无效。')
    if (!request.fields.length && request.position) throw new RetrievalError('INVALID_REQUEST', '续读位置不属于本次候选和字段。')
    const entry = await this.#entry(principal, request.snapshotId), refs = await this.#references(entry, principal, request.candidateRefs)
    if (!request.fields.length) return { snapshotId: request.snapshotId, evidence: [], requestedCandidateRefs: [...request.candidateRefs],
      rejectedCandidateRefs: request.candidateRefs.filter(r => !refs.has(r)), tokenBudget: request.tokenBudget, tokensUsed: 0, warnings: [] }
    const records = new Map((await this.#query.records(entry.source.id, [...refs.values()], true)).map(r => [shortOpaque('cand', request.snapshotId, r.ticketId), r]))
    return projectEvidence({ snapshot: entry.snapshot, candidateRefs: records }, principal, request, options)
  }
  async readDetails(principal: TrustedPrincipalContext, request: DetailReadRequest, options?: ProviderCallOptions) {
    options?.signal?.throwIfAborted()
    const entry = await this.#entry(principal, request.snapshotId), refs = await this.#references(entry, principal, request.candidateRefs)
    const records = new Map((await this.#query.records(entry.source.id, [...refs.values()], request.fields.length > 0)).map(r => [shortOpaque('cand', request.snapshotId, r.ticketId), r]))
    return projectDetails({ snapshot: entry.snapshot, candidateRefs: records }, principal, request, options)
  }
  async status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshot['snapshotId']) {
    assertTrustedPrincipal(principal)
    if (!snapshotId) { const current = await this.db.publication(this.datasetId); return { providerId: this.providerId, ready: true, readOnly: true as const, warnings: current.index ? [] : ['vector_index_unavailable'] } }
    const entry = await this.#entry(principal, snapshotId)
    let after = ''
    while (true) {
      const refs = await this.db.rows<{ candidate_ref: TicketCandidateRef }>('SELECT candidate_ref FROM ra_provider_candidate WHERE snapshot_id=? AND candidate_ref>? ORDER BY candidate_ref LIMIT 500', [snapshotId, after])
      if (!refs.length) break
      await this.#references(entry, principal, refs.map(r => r.candidate_ref)); after = refs.at(-1)!.candidate_ref
    }
    return { providerId: this.providerId, ready: true, readOnly: true as const, snapshotValid: true,
      sourceVersion: entry.snapshot.sourceVersion, indexVersion: entry.snapshot.indexVersion, warnings: [] }
  }
}
