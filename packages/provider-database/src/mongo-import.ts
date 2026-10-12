import { MongoClient, type Document } from 'mongodb'
import { TicketId, type NormalizedTicketRecord } from '@retrieval-agent/contracts'
import { sha256, stableJson } from '@retrieval-agent/provider-local'

export interface MongoDatasetSpec {
  name: string
  connection: { uri: string; database: string; collection: string }
  time: { field: string; type: 'string' | 'date'; start: string; end: string; timezone: 'Asia/Shanghai' }
  source: { field: string; value: string }
  fields: { id: string; title: string; abstract: string }
  limit: number
  timeoutSeconds: number
}
export interface DatasetCounts { read: number; valid: number; duplicate: number; skipped: number; embeddedChunks: number; indexedChunks: number; totalChunks: number }
export const emptyDatasetCounts = (): DatasetCounts => ({ read: 0, valid: 0, duplicate: 0, skipped: 0, embeddedChunks: 0, indexedChunks: 0, totalChunks: 0 })
export function parseMongoDatasetSpec(input: unknown): MongoDatasetSpec {
  const v = input as Partial<MongoDatasetSpec>
  const spec: MongoDatasetSpec = { name: v?.name?.trim() ?? '', connection: { uri: v?.connection?.uri ?? '', database: v?.connection?.database ?? 'xciopdfs', collection: v?.connection?.collection ?? 'output_fields_date' },
    time: { field: 'create_time', type: 'string', timezone: 'Asia/Shanghai', ...v?.time, start: v?.time?.start ?? '', end: v?.time?.end ?? '' },
    source: { field: 'user_business_line_two', value: '运保中心', ...v?.source }, fields: { id: '_id', title: 'large_model_title', abstract: 'large_model_abstract', ...v?.fields },
    limit: v?.limit ?? 10000, timeoutSeconds: v?.timeoutSeconds ?? 30 }
  if (!spec.name || spec.name.length > 191 || !/^mongodb(?:\+srv)?:\/\//.test(spec.connection.uri) || !spec.connection.database || !spec.connection.collection) throw new TypeError('请填写数据集名称与 Mongo 连接、数据库和集合。')
  if (!['string', 'date'].includes(spec.time.type) || spec.time.timezone !== 'Asia/Shanghai' || ![spec.time.start, spec.time.end].every(t => /(?:Z|[+-]\d\d:\d\d)$/.test(t)) || !Number.isFinite(Date.parse(spec.time.start)) || !(Date.parse(spec.time.end) > Date.parse(spec.time.start))) throw new TypeError('请选择带时区的开始、结束时间和有效时间类型。')
  if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 10000 || !Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1 || spec.timeoutSeconds > 600) throw new TypeError('下载数量应为 1–10000，超时应为 1–600 秒。')
  for (const field of [spec.time.field, spec.source.field, ...Object.values(spec.fields)]) if (!field || field.startsWith('$') || field.includes('\0')) throw new TypeError('字段名称无效。')
  return spec
}
const localTime = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
export function mongoDatasetQuery(spec: MongoDatasetSpec): Document {
  return { $and: [{ [spec.time.field]: { $gte: spec.time.type === 'date' ? new Date(spec.time.start) : localTime(spec.time.start), $lt: spec.time.type === 'date' ? new Date(spec.time.end) : localTime(spec.time.end) } },
    { [spec.source.field]: spec.source.value }, ...[spec.fields.title, spec.fields.abstract].map(field => ({ [field]: { $type: 'string', $regex: '\\S' } }))] }
}
function fieldValue(document: Document, field: string): unknown { return field.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Document)[key] : undefined, document) }
const cleanText = (value: unknown) => typeof value === 'string' ? value.replace(/\0/g, '').replace(/\r\n?/g, '\n').trim() : ''
export function mapMongoTicket(document: Document, spec: MongoDatasetSpec, datasetId: string, tenantId: string): NormalizedTicketRecord | undefined {
  const rawId = fieldValue(document, spec.fields.id), id = rawId == null ? '' : String(rawId), title = cleanText(fieldValue(document, spec.fields.title)), summary = cleanText(fieldValue(document, spec.fields.abstract))
  if (!id || id.length > 191 || !title || !summary) return undefined
  const rawDate = fieldValue(document, spec.time.field), createdAt = rawDate instanceof Date ? rawDate.toISOString() : typeof rawDate === 'string' ? rawDate : undefined
  return { ticketId: TicketId(id), displayId: id, tenantId, allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: `mongo/${datasetId}/title-abstract-v1`,
    contentHash: sha256(stableJson({ id, title, summary, createdAt, source: fieldValue(document, spec.source.field) })), title, summary, ...(createdAt ? { createdAt } : {}),
    titleOrigin: { kind: 'generated', verification: 'unverified', sourceFields: [spec.fields.title] },
    summaryOrigin: { kind: 'generated', verification: 'unverified', sourceFields: [spec.fields.abstract] },
    rawSource: { datasetId, datasetVersion: `mongo/${datasetId}/title-abstract-v1`, schemaVersion: 'mongo-title-abstract-v1', recordId: id,
      payload: Object.fromEntries([spec.fields.id, spec.fields.title, spec.fields.abstract, spec.time.field, spec.source.field].map(f => [f, fieldValue(document, f)])) },
    additionalFields: [{ key: 'source.business_line', label: spec.source.field, value: String(fieldValue(document, spec.source.field) ?? ''), sourcePath: spec.source.field }],
    conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable' }
}
export interface DatasetPreview { fields: string[]; timeType: 'string' | 'date' | 'unknown'; matchedCount: number; samples: { id: string; title: string; abstract: string; date?: string; source: string }[] }
export async function previewMongoDataset(spec: MongoDatasetSpec, signal?: AbortSignal): Promise<DatasetPreview> {
  const client = new MongoClient(spec.connection.uri, { serverSelectionTimeoutMS: spec.timeoutSeconds * 1000, connectTimeoutMS: spec.timeoutSeconds * 1000 })
  const abort = () => { void client.close() }; signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted(); await client.connect(); const collection = client.db(spec.connection.database).collection(spec.connection.collection)
    const discover = await collection.aggregate<{ fields: string[]; timeType: string }>([{ $limit: 5 }, { $project: { _id: 0,
      fields: { $map: { input: { $objectToArray: '$$ROOT' }, as: 'field', in: '$$field.k' } }, timeType: { $type: `$${spec.time.field}` } } }], { signal, maxTimeMS: spec.timeoutSeconds * 1000 }).toArray()
    const detected = discover.map(d => d.timeType).find(t => ['date', 'string'].includes(t)), effective = { ...spec, time: { ...spec.time, type: detected === 'date' ? 'date' as const : detected === 'string' ? 'string' as const : spec.time.type } }
    const projection = Object.fromEntries([spec.fields.id, spec.fields.title, spec.fields.abstract, spec.time.field, spec.source.field].map(field => [field, 1]))
    const query = mongoDatasetQuery(effective), docs = await collection.find(query, { signal, projection, maxTimeMS: spec.timeoutSeconds * 1000 }).sort({ [spec.time.field]: -1 }).limit(5).toArray()
    const matchedCount = await collection.countDocuments(query, { signal, maxTimeMS: spec.timeoutSeconds * 1000 }); signal?.throwIfAborted()
    return { fields: [...new Set(discover.flatMap(d => d.fields))].sort(), timeType: detected === 'date' ? 'date' : detected === 'string' ? 'string' : 'unknown', matchedCount,
      samples: docs.map(d => mapMongoTicket(d, spec, 'preview', 'preview')).filter((r): r is NormalizedTicketRecord => Boolean(r)).map(r => ({ id: r.ticketId, title: r.title, abstract: r.summary, ...(r.createdAt ? { date: r.createdAt } : {}), source: spec.source.value })) }
  } finally { signal?.removeEventListener('abort', abort); await client.close() }
}
export async function downloadMongoDataset(spec: MongoDatasetSpec, datasetId: string, tenantId: string, counts: DatasetCounts,
  onProgress: () => Promise<void>, signal?: AbortSignal): Promise<NormalizedTicketRecord[]> {
  const client = new MongoClient(spec.connection.uri, { serverSelectionTimeoutMS: spec.timeoutSeconds * 1000, connectTimeoutMS: spec.timeoutSeconds * 1000 })
  const abort = () => { void client.close() }; signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted(); await client.connect()
    const projection = Object.fromEntries([spec.fields.id, spec.fields.title, spec.fields.abstract, spec.time.field, spec.source.field].map(field => [field, 1]))
    const cursor = client.db(spec.connection.database).collection(spec.connection.collection).find(mongoDatasetQuery(spec), { signal, projection, maxTimeMS: spec.timeoutSeconds * 1000 }).sort({ [spec.time.field]: -1 }).limit(spec.limit).batchSize(200)
    const records: NormalizedTicketRecord[] = [], seen = new Set<string>()
    for await (const document of cursor) {
      signal?.throwIfAborted(); counts.read++
      const record = mapMongoTicket(document, spec, datasetId, tenantId)
      if (!record) counts.skipped++
      else if (seen.has(record.ticketId)) counts.duplicate++
      else { seen.add(record.ticketId); records.push(record); counts.valid++ }
      if (counts.read % 200 === 0) await onProgress()
      if (records.length >= spec.limit) break
    }
    await onProgress(); return records
  } finally { signal?.removeEventListener('abort', abort); await client.close() }
}
