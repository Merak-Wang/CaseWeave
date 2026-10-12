import { beforeEach, expect, it, vi } from 'vitest'
import { mapMongoTicket, mongoDatasetQuery, parseMongoDatasetSpec, downloadMongoDataset, previewMongoDataset, emptyDatasetCounts } from './mongo-import.js'

const mongo = vi.hoisted(() => ({ docs: [] as Record<string, unknown>[], options: [] as Record<string, unknown>[], queries: [] as any[], sorts: [] as unknown[], limits: [] as number[], aggregate: [] as unknown[] }))
vi.mock('mongodb', () => ({ MongoClient: class {
  async connect() {} async close() {}
  db() { return { collection: () => ({
    aggregate: (pipeline: unknown) => { mongo.aggregate.push(pipeline); return { toArray: async () => [{ fields: ['_id', 'create_time', 'large_model_title', 'large_model_abstract'], timeType: 'date' }] } },
    countDocuments: async () => mongo.docs.length,
    find: (query: unknown, options: Record<string, unknown>) => { mongo.queries.push(query); mongo.options.push(options); const cursor = {
      sort: (value: unknown) => { mongo.sorts.push(value); return cursor }, limit: (value: number) => { mongo.limits.push(value); return cursor }, batchSize: () => cursor,
      toArray: async () => mongo.docs.slice(0, 5), async *[Symbol.asyncIterator]() { for (const doc of mongo.docs.slice(0, mongo.limits.at(-1))) yield doc },
    }; return cursor },
  }) } }
} }))
const input = () => ({ name: 'local synthetic', connection: { uri: 'mongodb://localhost', database: 'fixture', collection: 'tickets' },
  time: { start: '2026-09-10T00:00:00+08:00', end: '2026-10-10T00:00:00+08:00' } })
beforeEach(() => { mongo.docs = []; mongo.options = []; mongo.queries = []; mongo.sorts = []; mongo.limits = []; mongo.aggregate = [] })
it('defaults to Mongo identity and constructs center/time/required-field filters without host timezone', () => {
  const spec = parseMongoDatasetSpec(input()), query = mongoDatasetQuery(spec)
  expect(spec.fields.id).toBe('_id')
  expect(query.$and[0]).toEqual({ create_time: { $gte: '2026-09-10 00:00:00', $lt: '2026-10-10 00:00:00' } })
  expect(query.$and[1]).toEqual({ user_business_line_two: '运保中心' })
  expect(() => parseMongoDatasetSpec({ ...input(), time: { start: '2026-09-10T00:00', end: '2026-10-10T00:00' } })).toThrow('时区')
})
it('preserves two physical Mongo tickets sharing group_id and marks generated title/abstract', () => {
  const spec = parseMongoDatasetSpec(input()), doc = { _id: 'a', group_id: 'shared', large_model_title: ' 标题 ', large_model_abstract: ' 摘要\0 ', user_business_line_two: '运保中心', create_time: '2026-09-20 00:00:00' }
  const a = mapMongoTicket(doc, spec, 'one', 'actual-tenant')!, b = mapMongoTicket({ ...doc, _id: 'b' }, spec, 'one', 'actual-tenant')!
  expect(a.ticketId).not.toBe(b.ticketId); expect(a.tenantId).toBe('actual-tenant')
  expect(a.summary).toBe('摘要'); expect(a.titleOrigin).toMatchObject({ kind: 'generated', verification: 'unverified' })
  expect(a.rawSource?.payload).not.toHaveProperty('group_id'); expect(a.conversationOrUpdates).toEqual([])
  expect(a.additionalFields?.[0]?.value).toBe('运保中心')
  expect(mapMongoTicket({ ...doc, user_business_line_two: 'other' }, spec, 'one', 'actual-tenant')!.contentHash).not.toBe(a.contentHash)
})
it('limits raw download, counts duplicates/invalids and uses only time sort and selected projection', async () => {
  const doc = { _id: 'one', large_model_title: '标题', large_model_abstract: '摘要' }
  mongo.docs = [doc, doc, { ...doc, _id: 'bad', large_model_abstract: '' }, { ...doc, _id: 'outside' }]
  const spec = parseMongoDatasetSpec({ ...input(), limit: 3 }), counts = emptyDatasetCounts(), signal = new AbortController().signal
  const rows = await downloadMongoDataset(spec, 'dataset', 'tenant', counts, async () => {}, signal)
  expect(rows).toHaveLength(1); expect(counts).toMatchObject({ read: 3, valid: 1, duplicate: 1, skipped: 1 })
  expect(mongo.limits).toEqual([3]); expect(mongo.sorts).toEqual([{ create_time: -1 }])
  expect(mongo.options[0]?.signal).toBe(signal); expect(mongo.options[0]?.projection).not.toHaveProperty('origin_conversation')
})
it('preview discovers only keys/type and uses detected BSON date on its first query', async () => {
  mongo.docs = [{ _id: 'one', large_model_title: '标题', large_model_abstract: '摘要' }]
  const preview = await previewMongoDataset(parseMongoDatasetSpec(input()))
  expect(preview.timeType).toBe('date'); expect(preview.matchedCount).toBe(1)
  expect(mongo.queries[0].$and[0].create_time.$gte).toEqual(new Date('2026-09-09T16:00:00Z'))
  expect(mongo.aggregate[0]).toMatchObject([{ $limit: 5 }, { $project: { _id: 0 } }])
  expect(mongo.options[0]?.projection).not.toHaveProperty('origin_conversation')
})
