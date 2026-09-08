import { RetrievalError, assertTrustedPrincipal, evaluateQuery, validateQueryExpression,
  type DetailReadRequest, type EvidenceReadRequest, type ProviderCallOptions, type TicketRetrievalProvider,
  type TicketRetrievalRequest, type TicketRetrievalSpec, type TicketSearchOptions, type TicketSearchPage, type TicketSearchProgress,
  type TicketSnapshot, type TrustedPrincipalContext, type NormalizedTicketRecord, type QueryExpression } from '@retrieval-agent/contracts'
import { LocalTicketProvider, canRead, principalBinding, sha256, stableJson } from '@retrieval-agent/provider-local'
import type { RankingResult, RankingHit } from '@retrieval-agent/retrieval-ranking'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import { TicketDatabase, type Generation, type IndexGeneration } from './store.js'
import { MilvusClient } from './milvus.js'
import { queryDocument, ticketChunks } from './projection.js'

interface Entry { local: LocalTicketProvider; source: Generation; index?: IndexGeneration; snapshot: TicketSnapshot; records: NormalizedTicketRecord[] }
const all: QueryExpression = { kind: 'constant', value: true }
const and = (...children: QueryExpression[]): QueryExpression => ({ kind: 'and', children })
function filters(spec: TicketRetrievalSpec): QueryExpression {
  return spec.filters.length ? and(...spec.filters.map((f): QueryExpression => {
    if (f.op === 'gte' || f.op === 'lte') return { kind: 'field', field: f.field, op: 'range', ...(f.op === 'gte' ? { lower: f.value } : { upper: f.value, upperInclusive: true }) }
    const expr: QueryExpression = { kind: 'field', field: f.field, op: f.op === 'contains' ? 'in' : 'eq', values: [f.value] }
    return f.op === 'neq' ? { kind: 'not', child: expr } : expr
  })) : all
}
export class DatabaseTicketProvider implements TicketRetrievalProvider {
  readonly providerId = 'mysql-milvus-v1'
  readonly #entries = new Map<string, Entry>()
  readonly #rankings = new Map<string, RankingResult>()
  readonly #inflight = new Map<string, Promise<RankingResult>>()
  #loaded: { key: string; value: Promise<{ records: NormalizedTicketRecord[]; local: LocalTicketProvider }> } | undefined
  readonly #resolver = new LocalTicketProvider([], { defaultMode: 'hybrid' })
  constructor(readonly db: TicketDatabase, readonly milvus: MilvusClient, readonly model: RetrievalModelGateway,
    readonly datasetId = 'esft-development', readonly denseTopK = 15) {}
  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec { return this.#resolver.resolve(request) }
  async openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot> {
    assertTrustedPrincipal(principal); options?.signal?.throwIfAborted()
    const { source, index } = await this.db.publication(this.datasetId)
    const key = `${source.id}:${index?.id ?? 'unavailable'}`
    if (this.#loaded?.key !== key) {
      const value = this.db.records(source.id).then(records => ({ records,
        local: new LocalTicketProvider(records, { providerId: this.providerId, defaultMode: 'hybrid', indexVersion: index?.id ?? 'vector-unavailable' }) }))
      this.#loaded = { key, value }
      value.catch(() => { if (this.#loaded?.key === key) this.#loaded = undefined })
    }
    const { records, local } = await this.#loaded.value
    const { expiresAt: _demoDeadline, ...base } = await local.openSnapshot(principal, options)
    const snapshot: TicketSnapshot = { ...base,
      queryFields: source.fields_json,
      fieldCatalog: base.fieldCatalog.map(f => { const capability = source.fields_json.find(c => c.key === f.key); return { ...f, ...(capability ? { capability } : {}) } }),
      capabilities: { ...base.capabilities, denseSearch: true, hybridFusion: true },
    }
    // Durable identity is valid only while the published source/index and current grant match.
    // The in-memory demo's 15-minute lifetime must not expire saved database tasks.
    local.restoreSnapshot(principal, snapshot)
    this.#entries.set(snapshot.snapshotId, { source, ...(index ? { index } : {}), local, snapshot, records })
    await this.db.pool.query('INSERT INTO ra_provider_snapshot(id,dataset_id,generation,index_id,snapshot_json) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE snapshot_json=VALUES(snapshot_json)',
      [snapshot.snapshotId, this.datasetId, source.id, index?.id ?? null, JSON.stringify(snapshot)])
    return snapshot
  }
  async #entry(principal: TrustedPrincipalContext, snapshotId: TicketSnapshot['snapshotId']): Promise<Entry> {
    assertTrustedPrincipal(principal)
    let entry = this.#entries.get(snapshotId)
    if (!entry) {
      const saved = (await this.db.rows<{ generation: string; index_id: string | null; snapshot_json: TicketSnapshot }>(
        'SELECT generation,index_id,snapshot_json FROM ra_provider_snapshot WHERE id=? AND dataset_id=?', [snapshotId, this.datasetId]))[0]
      if (!saved) throw new RetrievalError('SNAPSHOT_NOT_FOUND', '数据库快照不存在，请重新打开。')
      const { source, index } = await this.db.publication(this.datasetId)
      if (source.id !== saved.generation || (index?.id ?? null) !== saved.index_id) throw new RetrievalError('SNAPSHOT_INVALID', '历史来源或索引发布已改变。')
      const records = await this.db.records(source.id)
      const local = new LocalTicketProvider(records, { providerId: this.providerId, defaultMode: 'hybrid', indexVersion: index?.id ?? 'vector-unavailable' })
      // Migrate old database snapshots only after checking the current publication above.
      // restoreSnapshot still verifies the fresh grant, authorized source hash and index.
      const { expiresAt: _legacyDemoDeadline, ...snapshot } = saved.snapshot_json
      local.restoreSnapshot(principal, snapshot)
      entry = { source, ...(index ? { index } : {}), records, local, snapshot }
      this.#entries.set(snapshotId, entry)
    }
    const current = await this.db.publication(this.datasetId)
    if (current.source.id !== entry.source.id) throw new RetrievalError('SNAPSHOT_INVALID', '工单来源已更新，旧快照不能继续确认或下载。')
    if ((current.index?.id ?? null) !== (entry.index?.id ?? null)) throw new RetrievalError('SNAPSHOT_INVALID', '检索索引发布已改变，请重新检索。')
    if ((await entry.local.status(principal, snapshotId)).snapshotValid !== true) throw new RetrievalError('SNAPSHOT_INVALID', '当前快照不可访问。')
    return entry
  }
  async search(principal: TrustedPrincipalContext, snapshotId: TicketSnapshot['snapshotId'], spec: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
    if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 100) throw new RetrievalError('INVALID_REQUEST', '单页数量必须为 1–100。')
    const started = performance.now(); const entry = await this.#entry(principal, snapshotId)
    const key = sha256(stableJson({ snapshotId, spec }))
    let ranked = this.#rankings.get(key)
    if (!ranked) {
      let pending = this.#inflight.get(key)
      if (!pending) {
        pending = this.#retrieve(entry, principal, spec, options, key)
        this.#inflight.set(key, pending)
      }
      try { ranked = await pending; this.#rankings.set(key, ranked) } finally { this.#inflight.delete(key) }
    }
    const page = entry.local.projectRanking(principal, snapshotId, spec, options, ranked, started)
    const failed = ranked.warnings.some(w => w.startsWith('channel_failed:'))
    return failed ? { ...page, completeness: 'unknown', boundary: { ...page.boundary, resultPagesExhausted: false } } : page
  }
  async #retrieve(entry: Entry, principal: TrustedPrincipalContext, spec: TicketRetrievalSpec, options: TicketSearchOptions, runId: string): Promise<RankingResult> {
    const started = performance.now()
    const timings: Record<string, number> = { parseMs: spec.queryPlan?.elapsedMs ?? 0 }
    const channels: { channel: 'keyword' | 'vector'; status: 'running' | 'completed' | 'failed' | 'skipped'; count: number; error?: string; cursor?: string }[] = [
      { channel: 'keyword', status: spec.mode === 'dense' ? 'skipped' : 'running', count: 0 },
      { channel: 'vector', status: spec.mode === 'keyword' ? 'skipped' : 'running', count: 0 },
    ]
    const byId = new Map(entry.records.filter(r => canRead(r, principal)).map(r => [r.ticketId as string, r]))
    if (byId.size > options.maxScan) throw new RetrievalError('CAPACITY_EXCEEDED', '授权工单集合超过检索资源边界，尚未开始枚举。')
    const hard = and(spec.queryPlan?.hard ?? all, filters(spec))
    const unchanged = JSON.stringify(spec.keywordQuery) === JSON.stringify(spec.fastQuery?.keyword)
    const keyword = unchanged && spec.queryPlan ? spec.queryPlan.keyword
      : spec.keywordQuery ? { kind: spec.keywordQuery.operator, children: spec.keywordQuery.terms.map(text => ({ kind: 'literal' as const, op: 'contains' as const, text })) } as QueryExpression
        : spec.queryPlan?.keyword ?? { kind: 'constant' as const, value: false }
    const expression = and(hard, keyword, ...spec.excludedTerms.map(text => ({ kind: 'not' as const, child: { kind: 'literal' as const, op: 'contains' as const, text } })))
    validateQueryExpression(expression, entry.source.fields_json); validateQueryExpression(hard, entry.source.fields_json)
    const hits = new Map<string, RankingHit>(); const warnings: string[] = []
    await this.db.pool.query('INSERT IGNORE INTO ra_search_run(id,generation,binding_hash,fingerprint,status_json) VALUES (?,?,?,?,?)', [runId, entry.source.id, principalBinding(principal), sha256(stableJson(spec)), JSON.stringify(channels)])
    const result = (): RankingResult => {
      const sorted = [...hits.values()].sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId)).map((hit, i) => ({ ...hit, rank: i + 1 }))
      const complete = channels.filter(c => c.status === 'completed')
      return { hits: sorted, scanned: byId.size, keywordEligible: channels[0]!.count, rankedHits: sorted.length, warnings: [...warnings],
        execution: { requestedMode: spec.mode, executedMode: complete.length === 2 ? 'hybrid' : complete[0]?.channel === 'vector' ? 'dense' : 'keyword',
          strategyVersion: 'mysql-milvus-rrf-v1', channels: complete.map(c => ({ channel: c.channel, implementation: c.channel === 'keyword' ? 'mysql-locate' : 'milvus-rest',
            version: c.channel === 'keyword' ? entry.source.id : entry.index!.id, resultCount: c.count, elapsedMs: timings[`${c.channel}Ms`] ?? 0,
            querySource: options.stage === 'repair_search' ? 'agent_rewrite' : c.channel === 'keyword' ? 'direct_user_keywords' : 'direct_user_original' })) } }
    }
    let notificationTail = Promise.resolve()
    const notify = (): Promise<void> => {
      const snapshotChannels = structuredClone(channels); const ranked = result()
      notificationTail = notificationTail.then(async () => {
        options.signal?.throwIfAborted()
        await this.#entry(principal, entry.snapshot.snapshotId)
        await this.db.pool.query('UPDATE ra_search_run SET status_json=? WHERE id=?', [JSON.stringify({ channels: snapshotChannels, timings }), runId])
        const { cursor: _cursor, ...progressOptions } = options
        const page = entry.local.projectRanking(principal, entry.snapshot.snapshotId, spec, progressOptions, ranked)
        const progress: TicketSearchProgress = { page: { ...page, completeness: 'unknown', boundary: { ...page.boundary, resultPagesExhausted: false } }, channels: snapshotChannels, timings: { ...timings, elapsedMs: performance.now() - started } }
        await options.onProgress?.(progress)
      })
      return notificationTail
    }
    const add = async (record: NormalizedTicketRecord, channel: 'keyword' | 'vector', rank: number, score: number, detail?: unknown): Promise<void> => {
      const previous = hits.get(record.ticketId)
      const contributions = [...(previous?.channels ?? []).filter(c => c.channel !== channel), { channel, rank, score }]
      hits.set(record.ticketId, { documentId: record.ticketId, rank, score: contributions.reduce((sum, c) => sum + 1 / (60 + c.rank), 0), channels: contributions })
      await this.db.pool.query('INSERT INTO ra_search_hit(run_id,ticket_id,channel,rank_no,score,source_hash,detail_json) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE rank_no=VALUES(rank_no),score=VALUES(score),detail_json=VALUES(detail_json)', [runId, record.ticketId, channel, rank, score, record.contentHash, detail === undefined ? null : JSON.stringify(detail)])
    }
    const run = async (i: number, work: () => Promise<void>): Promise<void> => {
      const channel = channels[i]!; if (channel.status === 'skipped') return
      const at = performance.now()
      try { await work(); channel.status = 'completed' }
      catch (error) {
        if (options.signal?.aborted) throw error
        if (error instanceof RetrievalError && ['UNAUTHORIZED', 'SNAPSHOT_INVALID', 'SNAPSHOT_NOT_FOUND'].includes(error.code)) throw error
        channel.status = 'failed'; channel.error = error instanceof Error ? error.message : 'channel unavailable'
        warnings.push(`channel_failed:${channel.channel}:${channel.error}`)
      }
      timings[`${channel.channel}Ms`] = performance.now() - at
      await notify()
    }
    await notify()
    const outcomes = await Promise.allSettled([
      run(0, async () => {
        for await (const page of this.db.enumerate(entry.source.id, expression, entry.source.fields_json, { pageSize: 100, accelerate: Boolean(entry.source.grams_ready), ...(options.signal ? { signal: options.signal } : {}) })) {
          timings.sqlMs = (timings.sqlMs ?? 0) + page.elapsedMs; timings.sqlFirstBatchMs ??= performance.now() - started
          for (const record of page.records) if (byId.has(record.ticketId)) await add(record, 'keyword', ++channels[0]!.count, 1)
          channels[0]!.cursor = page.cursor
          await notify()
        }
      }),
      run(1, async () => {
        if (!entry.index) throw new Error('No index published for this SQL generation')
        const ready = await this.model.ready(options.signal)
        const modelIdentity = ready.models.find(m => m.kind === 'embedding')
        if (modelIdentity?.model !== entry.index.identity_json.model || modelIdentity.revision !== entry.index.identity_json.revision || modelIdentity.dimensions !== entry.index.identity_json.dimensions) throw new Error('Query model and published index identities differ')
        const at = performance.now()
        const [vector] = await this.model.embed({ texts: [options.stage === 'repair_search' ? spec.semanticQuery ?? spec.normalizedQuery : spec.queryPlan?.vector.text ?? spec.fastQuery?.vector.text ?? spec.originalQuery], inputType: 'query', requireCompleteInput: true,
          onTiming: values => { timings.embeddingQueueMs = values.queueMs ?? 0; timings.embeddingComputeMs = values.computeMs ?? 0 }, ...(options.signal ? { signal: options.signal } : {}) })
        timings.embeddingMs = performance.now() - at
        timings.embeddingTransportMs = Math.max(0, timings.embeddingMs - (timings.embeddingQueueMs ?? 0) - (timings.embeddingComputeMs ?? 0))
        if (!vector || vector.length !== entry.index.identity_json.dimensions) throw new Error('Embedding/index dimension mismatch')
        const eligible: string[] = []
        const eligibilityStarted = performance.now()
        for await (const ids of this.db.enumerateIds(entry.source.id, hard, entry.source.fields_json, options.signal)) {
          for (const id of ids) if (byId.has(id)) eligible.push(id)
        }
        timings.sqlEligibilityMs = performance.now() - eligibilityStarted
        const ann = performance.now()
        const found = await this.milvus.search(entry.index.collection_name, vector, eligible, this.denseTopK, options.signal)
        timings.milvusMs = performance.now() - ann
        for (const hit of found) {
          const record = byId.get(hit.ticket_id)
          if (!record || record.contentHash !== hit.content_hash || record.sourceVersion !== hit.source_version || evaluateQuery(hard, queryDocument(record)) !== true) throw new Error('Milvus returned stale or unauthorized source identity')
          const chunk = ticketChunks(record, entry.index.identity_json.chunkChars).find(c => c.id === hit.id)
          if (!chunk || chunk.textHash !== hit.text_hash || chunk.field !== hit.field || chunk.part !== Number(hit.part) || chunk.start !== Number(hit.start) || chunk.end !== Number(hit.end)) throw new Error('Milvus fragment identity mismatch')
          await add(record, 'vector', ++channels[1]!.count, hit.distance, hit)
        }
      }),
    ])
    const rejected = outcomes.find(outcome => outcome.status === 'rejected')
    if (rejected?.status === 'rejected') {
      for (const channel of channels) if (channel.status === 'running') { channel.status = 'failed'; channel.error = options.signal?.aborted ? 'CANCELLED' : 'Search interrupted' }
      await this.db.pool.query('UPDATE ra_search_run SET status_json=? WHERE id=?', [JSON.stringify({ channels, timings, interrupted: true }), runId])
      if (options.signal?.aborted) throw new RetrievalError('CANCELLED', '检索已取消，已持久化通道结果保留。')
      throw rejected.reason
    }
    await notificationTail
    return result()
  }
  async readEvidence(principal: TrustedPrincipalContext, request: EvidenceReadRequest, options?: ProviderCallOptions) { return (await this.#entry(principal, request.snapshotId)).local.readEvidence(principal, request, options) }
  async readDetails(principal: TrustedPrincipalContext, request: DetailReadRequest, options?: ProviderCallOptions) { return (await this.#entry(principal, request.snapshotId)).local.readDetails(principal, request, options) }
  async status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshot['snapshotId']) {
    if (snapshotId) return (await this.#entry(principal, snapshotId)).local.status(principal, snapshotId)
    assertTrustedPrincipal(principal); const current = await this.db.publication(this.datasetId)
    return { providerId: this.providerId, ready: true, readOnly: true as const, warnings: current.index ? [] : ['vector_index_unavailable'] }
  }
}
