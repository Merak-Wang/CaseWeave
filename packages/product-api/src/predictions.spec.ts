import { describe, expect, it } from 'vitest'
import { CandidateExportService, InMemoryExportAuditSink } from './service.js'
import { candidateWindow } from './window.js'
import { predictionRows } from './predictions.js'
import { confirmedCount } from '@retrieval-agent/domain/result'
import { predictionFixture, predictionProvider } from '../../../tests/prediction-fixture.js'
import { PRINCIPAL } from '../../../tests/export-fixture.js'
import { xlsxRows } from '../../../tests/xlsx-assertions.js'

it('shows positive/default and complete predicted classes without promoting confirmations', () => {
  const state = predictionFixture()
  expect(confirmedCount(state)).toBe(0)
  expect(candidateWindow(state, 'confirmed').total).toBe(0)
  expect(candidateWindow(state, 'predictions').items.map(c => c.displayId)).toEqual(['INC-1'])
  const first = candidateWindow(state, 'predictions_all', undefined, 1), second = candidateWindow(state, 'predictions_all', first.nextCursor, 1)
  expect(first.total).toBe(3); expect(second.items[0]!.displayId).toBe('SYNTHETIC-exclude')
  expect(first.judgments[0]).toMatchObject({ verdict: 'undetermined', basis: 'unresolved', operatorInference: { proposed_label: 'accept', quality: 'unmeasured' } })
  expect(() => candidateWindow({ ...state, inputGeneration: 2 }, 'predictions_all', first.nextCursor)).toThrow('更新')
  expect(predictionRows({ ...state, accessValidation: 'required' })).toEqual([])
  expect(() => predictionRows({ ...state, candidates: state.candidates.map(c => ({ ...c, sourceVersion: 'changed' })) })).toThrow('身份')
})

describe('unconfirmed candidate exports', () => {
  it('refuses unconfirmed exports by default before producing any bytes', async () => {
    const state = predictionFixture(), parts: Uint8Array[] = [], audit = new InMemoryExportAuditSink()
    await expect(new CandidateExportService(predictionProvider(state), audit).stream(PRINCIPAL, state,
      { format: 'xlsx', template: 'summary', collection: 'predictions' }, async part => { parts.push(part) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(parts).toEqual([]); expect(audit.records).toEqual([])
  })
  it('keeps default confirmed refusal and exports exact candidate identity/status metadata to real XLSX', async () => {
    const state = predictionFixture(), audit = new InMemoryExportAuditSink(), service = new CandidateExportService(predictionProvider(state), audit, { allowPredictionExport: true, exportBinding: {
      taskId: state.retrievalId, inputRevision: 2, semanticGeneration: state.inputGeneration ?? 0, resultRevision: state.stateId } })
    await expect(service.exportXlsx(PRINCIPAL, state)).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
    const file = await service.exportXlsx(PRINCIPAL, state, undefined, undefined, { collection: 'predictions' })
    const [headers, ...rows] = xlsxRows(Buffer.from(file.content)), row = rows[0]!
    expect(rows).toHaveLength(1); expect(file.fileName).toContain('predictions-accept')
    expect(row[headers!.indexOf('judgment')]).toBe('candidate_unmeasured')
    expect(row[headers!.indexOf('prediction_label')]).toBe('accept')
    expect(row[headers!.indexOf('prediction_quality')]).toBe('unmeasured')
    expect(row[headers!.indexOf('prediction_method')]).toBe('name_gmm')
    expect(row[headers!.indexOf('prediction_record_identity')]).toBe(state.judgments![0]!.operatorInference!.record_identity)
    expect(confirmedCount(state)).toBe(0)
    const parts: string[] = []
    await service.stream(PRINCIPAL, state, { format: 'jsonl', template: 'summary', collection: 'predictions', predictionSelection: 'all' }, async part => { parts.push(part) })
    const jsonl = parts.join('').trim().split('\n').map(line => JSON.parse(line))
    expect(jsonl.map(row => row.judgment.proposedLabel)).toEqual(['accept', 'exclude', 'undetermined'])
    expect(jsonl.every(row => row.judgment.verdict === 'undetermined' && row.scope.collection === 'predictions')).toBe(true)
    await expect(service.exportXlsx(PRINCIPAL, state, [state.candidates[1]!.ref], undefined, { collection: 'predictions' })).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
  })
  it('rejects source drift and revoked authority before emitting any candidate bytes', async () => {
    const state = predictionFixture(), source = predictionProvider(state), parts: Uint8Array[] = []
    source.status.mockResolvedValue({ providerId: source.providerId, ready: true, readOnly: true, snapshotValid: false, warnings: [] })
    await expect(new CandidateExportService(source, new InMemoryExportAuditSink(), { allowPredictionExport: true, exportBinding: {
      taskId: state.retrievalId, inputRevision: 2, semanticGeneration: state.inputGeneration ?? 0, resultRevision: state.stateId } }).stream(PRINCIPAL, state,
      { format: 'xlsx', template: 'summary', collection: 'predictions' }, async part => { parts.push(part) })).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
    expect(parts).toEqual([])
    expect(() => predictionRows({ ...state, candidates: state.candidates.map(c => ({ ...c, contentHash: 'changed' })) })).toThrow('身份')
  })
})
