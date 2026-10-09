import { describe, expect, it, vi } from 'vitest'
import { type CandidateExportBinding, type RetrievalState, RetrievalStateId } from '@retrieval-agent/contracts'
import { type MySqlTaskStore, type TaskRecord } from '@retrieval-agent/agent-plugin'
import { predictionFixture } from '../../../tests/prediction-fixture.js'
import { trustedExportBinding, assertMatchingExportBinding } from './export-binding.js'

function task(state: RetrievalState, inputRevision = 1): TaskRecord {
  return { id: state.retrievalId, session_id: 'synthetic-session', owner_hash: 'synthetic-owner',
    original_query: state.query.original, event_seq: 1, input_revision: inputRevision, semantic_revision: 1,
    query_revision: 1, state_json: state, failure: null, created_at: new Date('2026-10-08T00:00:00Z') }
}
describe('authoritative export binding', () => {
  it('reads task revision independently of semantic generation', async () => {
    const base = predictionFixture(), state = { ...base, inputGeneration: 0 }, row = task(state)
    const read = vi.fn(async (): Promise<TaskRecord | undefined> => row)
    const store: Pick<MySqlTaskStore, 'read'> = { read }
    const value = await trustedExportBinding(store, state, state.stateId)
    expect(value).toEqual({ taskId: state.retrievalId, inputRevision: 1, semanticGeneration: 0, resultRevision: state.stateId })
    expect(read).toHaveBeenCalledWith(state.retrievalId)
  })
  it.each(['inputRevision', 'semanticGeneration', 'resultRevision'] as const)('rejects %s drift on the next authoritative check', async key => {
    const state = predictionFixture()
    let row = task(state)
    const store: Pick<MySqlTaskStore, 'read'> = { read: vi.fn(async () => row) }
    const original = await trustedExportBinding(store, state, state.stateId)
    if (key === 'inputRevision') row = { ...row, input_revision: row.input_revision + 1 }
    else if (key === 'semanticGeneration') row = { ...row, state_json: { ...state, inputGeneration: 2 } }
    else row = { ...row, state_json: { ...state, stateId: RetrievalStateId('changed-result') } }
    await expect(trustedExportBinding(store, state, state.stateId, original)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })
  it('rejects saved legacy bytes or mismatched task binding instead of blessing them with the current revision', () => {
    const state = predictionFixture()
    const current: CandidateExportBinding = { taskId: state.retrievalId, inputRevision: 2,
      semanticGeneration: 1, resultRevision: state.stateId }
    expect(() => assertMatchingExportBinding(current, undefined)).toThrow('缺少')
    expect(() => assertMatchingExportBinding(current, { ...current, inputRevision: 1 })).toThrow('不一致')
    expect(() => assertMatchingExportBinding(current, { ...current, inputRevision: '2' })).toThrow('不一致')
    expect(() => assertMatchingExportBinding(current, current)).not.toThrow()
  })
})
