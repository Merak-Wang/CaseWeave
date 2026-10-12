import { randomUUID } from 'node:crypto'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import { EMBEDDING_INSTRUCTION } from '@retrieval-agent/model-service-client/ranking'
import { buildIndex } from './indexing.js'
import type { TicketDatabase, EmbeddingIdentity } from './store.js'
import type { MilvusClient } from './milvus.js'
import { downloadMongoDataset, emptyDatasetCounts, parseMongoDatasetSpec, previewMongoDataset, type MongoDatasetSpec, type DatasetCounts } from './mongo-import.js'

export type DatasetStage = 'connecting' | 'download' | 'clean' | 'embed' | 'index' | 'ready' | 'failed' | 'cancelled'
export interface DatasetProgress {
  id: string; datasetId: string; name: string; stage: DatasetStage; counts: DatasetCounts; createdAt: string
  sourceVersion?: string; indexVersion?: string; error?: string
}
export interface DatasetServiceOptions { db: TicketDatabase; milvus: MilvusClient; model: RetrievalModelGateway; tenantId: string | (() => Promise<string>); ready?: Promise<void> }
export class DatasetService {
  private readonly controllers = new Map<string, AbortController>()
  private readonly active = new Set<Promise<void>>()
  private readonly initialized: Promise<void>
  constructor(private readonly options: DatasetServiceOptions) {
    this.initialized = (options.ready ?? options.db.migrate()).then(async () => {
      // URI只存在执行闭包内，重启后旧构建如实失败；已发布数据和索引不变。
      const rows = await options.db.rows<{ id: string; progress_json: DatasetProgress }>('SELECT id,progress_json FROM ra_dataset WHERE stage NOT IN (?,?,?)', ['ready', 'failed', 'cancelled'])
      for (const row of rows) await this.save({ ...row.progress_json, stage: 'failed', error: '应用已重启，本次导入未完成，请重新连接后导入。' })
    })
  }
  private async save(progress: DatasetProgress) {
    await this.options.db.pool.query('UPDATE ra_dataset SET stage=?,progress_json=? WHERE id=?', [progress.stage, JSON.stringify(progress), progress.id])
  }
  async list(): Promise<{ datasets: DatasetProgress[] }> {
    await this.initialized
    const rows = await this.options.db.rows<{ progress_json: DatasetProgress }>('SELECT progress_json FROM ra_dataset ORDER BY created_at DESC')
    const datasets = rows.map(r => r.progress_json)
    // 既有发布无需新目录迁移，继续作为可选数据集显示。
    const publications = await this.options.db.rows<{ dataset_id: string; generation: string; index_id: string; record_count: number; created_at: Date | string }>(
      "SELECT p.dataset_id,p.generation,p.index_id,g.record_count,g.created_at FROM ra_publication p JOIN ra_generation g ON g.id=p.generation JOIN ra_index i ON i.id=p.index_id WHERE g.status='ready' AND i.status='ready' AND i.generation=g.id AND i.completed_chunks=i.total_chunks AND i.watermark=g.source_watermark")
    for (const p of publications) {
      const at = datasets.findIndex(d => d.datasetId === p.dataset_id), previous = datasets[at]
      const ready: DatasetProgress = { ...(previous ?? { id: p.dataset_id, datasetId: p.dataset_id, name: p.dataset_id, createdAt: new Date(p.created_at).toISOString() }), stage: 'ready',
        counts: { ...(previous?.counts ?? emptyDatasetCounts()), valid: p.record_count }, sourceVersion: p.generation, indexVersion: p.index_id }
      delete ready.error
      if (at < 0) datasets.push(ready); else datasets[at] = ready
    }
    return { datasets }
  }
  async get(id: string): Promise<DatasetProgress> {
    const result = (await this.list()).datasets.find(d => d.id === id)
    if (!result) throw new TypeError('数据集不存在。')
    return result
  }
  async preview(raw: unknown, signal?: AbortSignal) {
    const spec = parseMongoDatasetSpec(raw)
    try { return await previewMongoDataset(spec, signal) }
    catch { throw new TypeError(signal?.aborted ? '连接预览已取消。' : 'Mongo 连接或预览失败，请检查地址、权限、字段与时间类型。') }
  }
  async start(raw: unknown): Promise<DatasetProgress> {
    const spec = parseMongoDatasetSpec(raw); await this.initialized
    const id = `mongo-${randomUUID()}`, controller = new AbortController()
    const progress: DatasetProgress = { id, datasetId: id, name: spec.name, stage: 'connecting', counts: emptyDatasetCounts(), createdAt: new Date().toISOString() }
    const { uri: _uri, ...connection } = spec.connection
    await this.options.db.pool.query('INSERT INTO ra_dataset(id,name,stage,spec_json,progress_json) VALUES (?,?,?,?,?)',
      [id, spec.name, progress.stage, JSON.stringify({ ...spec, connection }), JSON.stringify(progress)])
    this.controllers.set(id, controller)
    const work = this.run(spec, progress, controller.signal).catch(() => {}).finally(() => { this.controllers.delete(id); this.active.delete(work) })
    this.active.add(work)
    return structuredClone(progress)
  }
  async cancel(id: string): Promise<DatasetProgress> {
    const progress = await this.get(id)
    if (!['ready', 'failed', 'cancelled'].includes(progress.stage)) {
      const controller = this.controllers.get(id)
      if (!controller) throw new TypeError('数据集正在提交发布，已无法取消。')
      controller.abort()
    }
    return progress
  }
  private async run(spec: MongoDatasetSpec, progress: DatasetProgress, signal: AbortSignal): Promise<void> {
    const { db, model, milvus } = this.options
    const stage = async (value: DatasetStage) => { signal.throwIfAborted(); progress.stage = value; await this.save(progress) }
    try {
      const tenantId = typeof this.options.tenantId === 'function' ? await this.options.tenantId() : this.options.tenantId
      await stage('download')
      const records = await downloadMongoDataset(spec, progress.id, tenantId, progress.counts, () => this.save(progress), signal)
      await stage('clean')
      if (!records.length) throw new Error('empty')
      const generation = await db.importRecords(progress.id, records, `mongo/${progress.id}`, () => { signal.throwIfAborted() })
      progress.sourceVersion = generation; signal.throwIfAborted()
      await db.buildGrams(generation, () => { signal.throwIfAborted() }); signal.throwIfAborted()
      const ready = await model.ready(signal), embedding = ready.models.find(m => m.kind === 'embedding' && m.loaded)
      if (!ready.ready || !embedding || embedding.dimensions !== 1024 || embedding.pooling !== 'last_token' || embedding.normalization !== 'l2') throw new Error('embedding unavailable')
      const identity: EmbeddingIdentity = { model: embedding.model, revision: embedding.revision, dimensions: embedding.dimensions,
        normalization: 'l2', metric: 'COSINE', chunkChars: 360, chunkVersion: 'canonical-title-abstract-codepoints-v1', documentProjection: 'canonical-title-abstract-v1',
        pooling: 'last_token', queryInstruction: EMBEDDING_INSTRUCTION }
      const countedModel: RetrievalModelGateway = { ready: signal => model.ready(signal), rerank: input => model.rerank(input), embed: async input => {
        await stage('embed'); const vectors = await model.embed(input); progress.counts.embeddedChunks += vectors.length; await this.save(progress); return vectors
      } }
      await stage('index')
      const index = await buildIndex(db, milvus, countedModel, generation, identity, { signal, onProgress: async (completed, total) => {
        progress.stage = 'index'; progress.counts.indexedChunks = completed; progress.counts.totalChunks = total; await this.save(progress)
      } })
      signal.throwIfAborted(); this.controllers.delete(progress.id); await db.publish(progress.id, generation, index)
      progress.indexVersion = index; progress.stage = 'ready'; await this.save(progress)
    } catch (error) {
      progress.stage = signal.aborted ? 'cancelled' : 'failed'
      progress.error = signal.aborted ? '导入已取消；未发布新的检索数据集。' : error instanceof Error && error.message === 'empty' ? '筛选后无有效工单，请检查时间、来源和字段映射。' : '导入未完成，请检查 Mongo 条件、连接或模型与索引服务后重试。'
      await this.save(progress)
    }
  }
  async close(): Promise<void> { for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled(this.active) }
}
