import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RetrievalStateId, type RetrievalState } from '@retrieval-agent/contracts'
import type { MySqlTaskStore, DeliveryRecord } from '@retrieval-agent/agent-plugin'
import { describe, expect, it, vi } from 'vitest'
import { TaskDeliveryHost, parseDelivery } from './delivery.js'
import { CandidateExportService, InMemoryExportAuditSink } from '@retrieval-agent/product-api'
import { PRINCIPAL, provider, retrievalState } from '../../../tests/export-fixture.js'
import { xlsxRows } from '../../../tests/xlsx-assertions.js'
import { predictionFixture, predictionProvider } from '../../../tests/prediction-fixture.js'

/** Memory staging stands in for MySQL. No database, model or network calls occur. */
function harness(kind: 'csv' | 'jsonl' | 'xlsx' | 'report', maxExportBytes?: number, predictionState?: RetrievalState, allowPredictionExport = true) {
  let state = predictionState ?? { ...retrievalState(), accessValidation: 'current' as const }
  let inputRevision = 1
  const source = predictionState ? predictionProvider(state) : provider(), parts: Buffer[] = []
  const tasks = { ready: Promise.resolve(), pool: { query: vi.fn().mockResolvedValue([[], []]) },
    commands: vi.fn().mockResolvedValue([]), rows: vi.fn().mockResolvedValue([]),
    read: vi.fn(async () => ({ id: state.retrievalId, session_id: 'synthetic-session', owner_hash: 'synthetic-owner',
      original_query: state.query.original, event_seq: 1, input_revision: inputRevision, semantic_revision: 1,
      query_revision: 1, state_json: state, failure: null, created_at: new Date() })) } as unknown as MySqlTaskStore
  const host = new TaskDeliveryHost(tasks, { allowPredictionExport, ...(maxExportBytes === undefined ? {} : { maxExportBytes }),
    access: async () => ({ state, principal: PRINCIPAL, agent: {} as Agent }), providerFor: () => source })
  const job: DeliveryRecord = { id: 'a'.repeat(48), task_id: state.retrievalId, operation_id: 'xlsx-operation', request_hash: 'hash',
    spec_json: { kind, template: 'summary', audience: 'operator', resultRevision: state.stateId, ...(predictionState ? { collection: 'predictions' as const, predictionSelection: 'all' as const } : {}) },
    status: 'running', fence: 1, owner: host.owner, attempts: 1, row_count: 0, byte_count: 0, part_count: 0,
    content_sha256: null, meta_json: null, error: null, expires_at: new Date(Date.now() + 600000), lease_until: new Date(Date.now() + 600000) }
  let complete!: () => void
  const finished = new Promise<void>(resolve => { complete = resolve })
  vi.spyOn(host.store, 'claim').mockResolvedValueOnce(job).mockResolvedValue(undefined)
  vi.spyOn(host.store, 'renew').mockResolvedValue(undefined)
  vi.spyOn(host.store, 'release').mockResolvedValue(undefined)
  vi.spyOn(host.store, 'trace').mockResolvedValue(undefined)
  const append = vi.spyOn(host.store, 'append').mockImplementation(async (_job, data, rows) => {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    parts.push(bytes); job.byte_count += bytes.length; job.part_count++; job.row_count = rows
  })
  const publish = vi.spyOn(host.store, 'publish').mockImplementation(async (_job, hash, meta) => {
    job.content_sha256 = hash; job.meta_json = meta; job.status = 'ready'; complete()
  })
  const fail = vi.spyOn(host.store, 'fail').mockImplementation(async (_job, error) => { job.error = error; job.status = 'failed'; complete() })
  vi.spyOn(host.store, 'read').mockImplementation(async () => job)
  vi.spyOn(host.store, 'chunks').mockImplementation(async function* () { for (const part of parts) yield part })
  return { host, job, source, parts, append, publish, fail, state, async run() { await host.pump(); await finished },
    revise() { state = { ...state, stateId: RetrievalStateId('another-result') } },
    reviseInput() { inputRevision++ } }
}
function response() { return { writeHead: vi.fn(), write: vi.fn((_data: Uint8Array) => true), end: vi.fn(), destroyed: false } }

describe('persistent confirmed XLSX delivery', () => {
  it('reads saved report bytes despite JSON numeric normalization and rejects corrupt bytes', async () => {
    const h = harness('report')
    try {
      await h.run()
      vi.spyOn(h.host.store, 'list').mockResolvedValue([h.job])
      const saved = h.job.meta_json!.report
      saved.learning = { modelId: 'm', featureId: 'f', hashBasis: 'numeric',
        quality: { basis: 'unmeasured', business_accuracy: 'not_measured' }, statistics: { scanSeconds: 0.9934273789986036 } }
      await expect(h.host.report(h.state.retrievalId, h.state.stateId, 'operator')).resolves.toBe(saved)
      h.parts[0] = Buffer.from('corrupt report')
      await expect(h.host.report(h.state.retrievalId, h.state.stateId, 'operator')).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
    } finally { await h.host.close() }
  })
  it('rejects prediction requests and legacy saved files when research export is disabled', async () => {
    const h = harness('xlsx', undefined, predictionFixture(), false)
    const create = vi.spyOn(h.host.store, 'create')
    try {
      await expect(h.host.request(h.state.retrievalId, { operationId: 'prediction-request', kind: 'xlsx',
        resultRevision: h.state.stateId, collection: 'predictions' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      const sink = response()
      await expect(h.host.content(h.job, sink as unknown as ServerResponse)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(create).not.toHaveBeenCalled(); expect(sink.writeHead).not.toHaveBeenCalled()
    } finally { await h.host.close() }
  })
  it('rejects saved prediction bytes after task revision changes while semantic generation stays the same', async () => {
    const h = harness('xlsx', undefined, predictionFixture())
    try {
      await h.run()
      expect(h.publish).toHaveBeenCalledOnce()
      expect(h.job.meta_json?.receipt.exportBinding).toMatchObject({ inputRevision: 1, semanticGeneration: 1 })
      h.reviseInput()
      const sink = response()
      await expect(h.host.content(h.job, sink as unknown as ServerResponse)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
      expect(sink.writeHead).not.toHaveBeenCalled(); expect(sink.write).not.toHaveBeenCalled()
    } finally { await h.host.close() }
  })
  it('refuses legacy saved prediction bytes without a binding', async () => {
    const h = harness('xlsx', undefined, predictionFixture())
    try {
      await h.run()
      delete h.job.meta_json!.receipt.exportBinding
      const sink = response()
      await expect(h.host.content(h.job, sink as unknown as ServerResponse)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
      expect(sink.writeHead).not.toHaveBeenCalled()
    } finally { await h.host.close() }
  })
  it('accepts XLSX without changing the CSV/JSONL/report command contracts', () => {
    for (const kind of ['csv', 'jsonl', 'xlsx', 'report']) expect(parseDelivery({ operationId: 'op-1', kind, resultRevision: 'v1' }).spec.kind).toBe(kind)
    expect(() => parseDelivery({ operationId: 'op-1', kind: 'zip', resultRevision: 'v1' })).toThrow('格式')
  })
  it('accepts a prediction download request when the authorized task has zero confirmed tickets', async () => {
    const h = harness('xlsx', undefined, predictionFixture())
    const create = vi.spyOn(h.host.store, 'create').mockResolvedValue(h.job)
    try {
      const spec = { operationId: 'prediction-request', kind: 'xlsx', template: 'full', audience: 'operator',
        resultRevision: h.state.stateId, collection: 'predictions', predictionSelection: 'all' }
      await expect(h.host.request(h.state.retrievalId, spec)).resolves.toMatchObject({ id: h.job.id })
      expect(create).toHaveBeenCalledOnce()
      await expect(h.host.request(h.state.retrievalId, { operationId: 'confirmed-request', kind: 'xlsx',
        resultRevision: h.state.stateId })).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
      expect(create).toHaveBeenCalledOnce()
    } finally { await h.host.close() }
  })
  it('publishes a nonempty candidate workbook with all predicted classes and reauthorizes zero-confirmed saved content', async () => {
    const state = predictionFixture(), h = harness('xlsx', undefined, state)
    try {
      await h.run()
      expect(h.publish).toHaveBeenCalledOnce()
      const [headers, ...rows] = xlsxRows(Buffer.concat(h.parts))
      expect(rows.map(row => row[headers!.indexOf('prediction_label')])).toEqual(['accept', 'exclude', 'undetermined'])
      expect(rows.every(row => row[headers!.indexOf('judgment')] === 'candidate_unmeasured')).toBe(true)
      expect(h.job.meta_json?.receipt.rowCount).toBe(3); expect(state.selectedCandidateRefs).toEqual([])
      const sink = response()
      await h.host.content(h.job, sink as unknown as ServerResponse)
      expect(Buffer.concat(sink.write.mock.calls.map(call => Buffer.from(call[0])))).toEqual(Buffer.concat(h.parts))
      h.source.status.mockResolvedValue({ providerId: h.source.providerId, ready: true, readOnly: true, snapshotValid: false, warnings: [] })
      const revoked = response()
      await expect(h.host.content(h.job, revoked as unknown as ServerResponse)).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
      expect(revoked.writeHead).not.toHaveBeenCalled()
    } finally { await h.host.close() }
  })
  it('stages binary workbook then publishes the exact receipt and reauthorizes before serving saved bytes', async () => {
    const h = harness('xlsx')
    try {
      await h.run()
      expect(h.publish).toHaveBeenCalledTimes(1); expect(h.fail).not.toHaveBeenCalled()
      const bytes = Buffer.concat(h.parts), [header, ...rows] = xlsxRows(bytes)
      expect(rows.map(row => row[header!.indexOf('ticket')])).toEqual(['INC-1'])
      expect(h.job.row_count).toBe(rows.length); expect(h.job.byte_count).toBe(bytes.length)
      expect(h.job.content_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(h.job.meta_json?.receipt).toMatchObject({ rowCount: 1, resultRevision: h.state.stateId })
      expect(h.job.meta_json?.mediaType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const sink = response()
      await h.host.content(h.job, sink as unknown as ServerResponse)
      expect(Buffer.concat(sink.write.mock.calls.map(call => Buffer.from(call[0])))).toEqual(bytes)
      expect(sink.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-length': String(bytes.length), 'x-result-revision': h.state.stateId }))
      expect(sink.end).toHaveBeenCalledTimes(1)
    } finally { await h.host.close() }
  })
  it.each(['csv', 'jsonl', 'xlsx'] as const)('uses the same byte boundary as synchronous %s and never publishes overflow', async kind => {
    const h = harness(kind, 100)
    try {
      await h.run()
      expect(h.job.status).toBe('failed'); expect(h.job.error).toContain('大小限制')
      expect(h.publish).not.toHaveBeenCalled()
      await expect(new CandidateExportService(provider(), new InMemoryExportAuditSink(), { maxBytes: 100 }).stream(PRINCIPAL, h.state,
        { format: kind, template: 'summary' }, async () => {})).rejects.toMatchObject({ code: 'EXPORT_LIMIT_EXCEEDED' })
      const sink = response()
      await expect(h.host.content(h.job, sink as unknown as ServerResponse)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
      expect(sink.writeHead).not.toHaveBeenCalled()
    } finally { await h.host.close() }
  })
  it.each(['version', 'grant', 'hash', 'bytes'] as const)('refuses saved workbook on changed %s before response headers or bytes', async change => {
    const h = harness('xlsx')
    try {
      await h.run()
      if (change === 'version') h.revise()
      if (change === 'grant') h.source.status.mockResolvedValue({ providerId: 'provider-v1', ready: true, readOnly: true, snapshotValid: false, warnings: [] })
      if (change === 'hash') h.parts[0] = Buffer.from('corrupt')
      if (change === 'bytes') h.job.byte_count++
      const sink = response()
      await expect(h.host.content(h.job, sink as unknown as ServerResponse)).rejects.toBeDefined()
      expect(sink.writeHead).not.toHaveBeenCalled(); expect(sink.write).not.toHaveBeenCalled()
    } finally { await h.host.close() }
  })
})
