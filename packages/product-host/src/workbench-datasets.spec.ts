import { describe, expect, it } from 'vitest'
import { datasetPayload, datasetProgressText, preferredDataset, datasetInitialDates, datasetPreviewTimeout } from './workbench-datasets.js'
import { DATASET_SELECTOR_HTML, DATASET_SETTINGS_HTML } from './workbench-datasets-layout.js'

const input = { name: '测试工单', uri: 'mongodb://private', database: 'xciopdfs', collection: 'output_fields_date', timeField: 'create_time', timeType: 'string', start: '2026-09-09T00:00', end: '2026-10-10T08:00:00', sourceField: 'user_business_line_two', sourceValue: '运保中心', idField: '_id', titleField: 'large_model_title', abstractField: 'large_model_abstract', limit: '10000', timeout: '60' }
describe('dataset workbench mapping', () => {
  it('lets configured long Mongo previews finish before the browser timeout', () => {
    expect(datasetPreviewTimeout({ timeoutSeconds: 120 })).toBe(125000)
    expect(datasetPreviewTimeout({ timeoutSeconds: 600 })).toBe(605000)
    expect(datasetPreviewTimeout({ timeoutSeconds: 30 })).toBe(35000)
    expect(datasetPreviewTimeout()).toBe(35000)
  })
  it('starts with one calendar month in Shanghai time and handles month-end clipping', () => {
    expect(datasetInitialDates(new Date('2026-10-10T02:00:01Z'))).toEqual({ start: '2026-09-10T10:00:01', end: '2026-10-10T10:00:01', name: '运保中心·2026-10-10' })
    expect(datasetInitialDates(new Date('2026-03-31T12:00:00Z')).start).toBe('2026-02-28T20:00:00')
  })
  it('preserves explicit selection and keeps the original default above newly imported small datasets', () => {
    const rows = [{ id: 'small64', stage: 'ready' }, { id: 'original10000', stage: 'ready' }, { id: 'building', stage: 'embed' }]
    expect(preferredDataset(rows, '', 'original10000')).toBe('original10000')
    expect(preferredDataset(rows, 'small64', 'original10000')).toBe('small64')
    expect(preferredDataset(rows, 'building', 'original10000')).toBe('original10000')
    expect(preferredDataset(rows, '', 'absent')).toBe('small64')
  })
  it('sends configurable ticket fields and explicit Shanghai half-open time inputs', () => {
    expect(datasetPayload(input)).toEqual({ name: '测试工单', connection: { uri: 'mongodb://private', database: 'xciopdfs', collection: 'output_fields_date' }, time: { field: 'create_time', type: 'string', start: '2026-09-09T00:00:00+08:00', end: '2026-10-10T08:00:00+08:00', timezone: 'Asia/Shanghai' }, source: { field: 'user_business_line_two', value: '运保中心' }, fields: { id: '_id', title: 'large_model_title', abstract: 'large_model_abstract' }, limit: 10000, timeoutSeconds: 60 })
    expect(() => datasetPayload({ ...input, end: input.start })).toThrow('结束时间必须晚于开始时间')
  })
  it('keeps missing bounds open and reports actual pipeline counts without invented completion', () => {
    expect(datasetPayload({ ...input, start: '', end: '' }).time).toMatchObject({ start: null, end: null })
    expect(datasetProgressText({ counts: { read: 100, valid: 90, duplicate: 3, skipped: 7, embeddedChunks: 50, indexedChunks: 20, totalChunks: 90 } })).toBe('读取 100 · 有效 90 · 重复 3 · 跳过 7 · 向量 50/90 · 已索引 20')
  })
  it('uses a private URI input, configurable collection and ready dataset selector', () => {
    expect(DATASET_SETTINGS_HTML).toContain('id="mongo-uri" type="password"')
    expect(DATASET_SETTINGS_HTML).toContain('id="dataset-id-field" value="_id"')
    expect(DATASET_SETTINGS_HTML).toContain('结束时间（不含）')
    expect(DATASET_SELECTOR_HTML).toContain('id="dataset-selector"')
    expect(DATASET_SETTINGS_HTML).not.toContain('origin_conversation')
  })
})
