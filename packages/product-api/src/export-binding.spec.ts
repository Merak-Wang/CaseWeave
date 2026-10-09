import { describe, expect, it } from 'vitest'
import { type CandidateExportBinding, type RetrievalState } from '@retrieval-agent/contracts'
import { CandidateExportService, InMemoryExportAuditSink } from './service.js'
import { predictionFixture, predictionProvider } from '../../../tests/prediction-fixture.js'
import { PRINCIPAL } from '../../../tests/export-fixture.js'
import { xlsxRows } from '../../../tests/xlsx-assertions.js'

function generationZero(): RetrievalState {
  const base = predictionFixture()
  return { ...base, inputGeneration: 0, judgments: base.judgments!.map(j => ({ ...j,
    operatorInference: { ...j.operatorInference!, input_revision: 0 } })) }
}
function binding(state: RetrievalState, inputRevision = 1): CandidateExportBinding {
  return { taskId: state.retrievalId, inputRevision, semanticGeneration: state.inputGeneration ?? 0,
    resultRevision: state.frozenEvidence?.packId ?? state.stateId }
}

describe('durable prediction export binding', () => {
  it('exports task revision 1 and semantic generation 0 separately to XLSX and JSONL', async () => {
    const state = generationZero(), exportBinding = binding(state), audit = new InMemoryExportAuditSink()
    const service = new CandidateExportService(predictionProvider(state), audit, { allowPredictionExport: true, exportBinding })
    const file = await service.exportXlsx(PRINCIPAL, state, undefined, undefined,
      { collection: 'predictions', predictionSelection: 'all' })
    const [headers, ...rows] = xlsxRows(Buffer.from(file.content))
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row[headers!.indexOf('prediction_input_revision')] === '1')).toBe(true)
    expect(rows.every(row => row[headers!.indexOf('prediction_semantic_generation')] === '0')).toBe(true)
    expect(file.receipt.exportBinding).toEqual(exportBinding)
    expect(audit.records[0]!.exportBinding).toEqual(exportBinding)
    const parts: string[] = []
    const jsonl = await service.stream(PRINCIPAL, state, { format: 'jsonl', template: 'summary',
      collection: 'predictions', predictionSelection: 'all' }, async part => { parts.push(part) })
    expect(jsonl.receipt.exportBinding).toEqual(exportBinding)
    const records = parts.join('').trim().split('\n').map(line => JSON.parse(line) as {
      scope: { exportBinding: CandidateExportBinding }; judgment: { inference: { input_revision: number } } })
    expect(records.every(record => record.scope.exportBinding.inputRevision === 1
      && record.scope.exportBinding.semanticGeneration === 0 && record.judgment.inference.input_revision === 0)).toBe(true)
  })
  it.each(['taskId', 'semanticGeneration', 'resultRevision'] as const)('refuses an inconsistent %s before bytes', async key => {
    const state = generationZero(), good = binding(state), parts: Uint8Array[] = []
    const bad: CandidateExportBinding = key === 'semanticGeneration' ? { ...good, semanticGeneration: 1 }
      : key === 'taskId' ? { ...good, taskId: 'different-task' } : { ...good, resultRevision: 'different-result' }
    await expect(new CandidateExportService(predictionProvider(state), new InMemoryExportAuditSink(),
      { allowPredictionExport: true, exportBinding: bad }).stream(PRINCIPAL, state, { format: 'xlsx', template: 'summary', collection: 'predictions' },
      async part => { parts.push(part) })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    expect(parts).toEqual([])
  })
  it('refuses a prediction export without a trusted task revision and retains source identity gates', async () => {
    const state = generationZero(), parts: Uint8Array[] = []
    await expect(new CandidateExportService(predictionProvider(state), new InMemoryExportAuditSink(), { allowPredictionExport: true }).stream(PRINCIPAL, state,
      { format: 'xlsx', template: 'summary', collection: 'predictions' }, async part => { parts.push(part) }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    const changed = { ...state, candidates: state.candidates.map(c => ({ ...c, contentHash: 'changed' })) }
    await expect(new CandidateExportService(predictionProvider(changed), new InMemoryExportAuditSink(),
      { allowPredictionExport: true, exportBinding: binding(changed) }).exportXlsx(PRINCIPAL, changed, undefined, undefined, { collection: 'predictions' }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
    expect(parts).toEqual([])
  })
})
