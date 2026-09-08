import {
  SUPPORTED_RETRIEVAL_EVENT_SCHEMA_VERSIONS,
  RetrievalError,
  type RetrievalDomainEvent,
  type RetrievalId,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { applyRetrievalStatePatch } from './patch.js'
import { migrateLegacyRetrievalState, migrateProjectionState } from './migrate.js'
export { applyRetrievalStatePatch, createRetrievalStatePatch } from './patch.js'
export { migrateProjectionState } from './migrate.js'

function validateState(state: RetrievalState, event: RetrievalDomainEvent, previous: RetrievalState | undefined): void {
  if (state.retrievalId !== event.retrievalId) throw new RetrievalError('PROTOCOL_MISMATCH', '状态与事件的检索身份不一致。')
  if (previous === undefined) {
    if (state.revision !== 0 || state.previousStateId !== undefined) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '首个检索状态必须从 revision 0 开始。')
    }
  } else if (state.previousStateId !== previous.stateId || state.revision !== previous.revision + 1) {
    throw new RetrievalError('PROTOCOL_MISMATCH', '检索状态链不连续。')
  }
}

/** Replay legacy cumulative checkpoints and v9/v10 incremental state patches. */
export function foldRetrievalEvents(events: readonly RetrievalDomainEvent[], expectedRetrievalId?: RetrievalId): RetrievalState | undefined {
  let state: RetrievalState | undefined
  let stateSchemaVersion: number | undefined
  let expectedSequence = 0
  const eventIds = new Set<string>()
  for (const event of events) {
    if (!SUPPORTED_RETRIEVAL_EVENT_SCHEMA_VERSIONS.includes(event.schemaVersion)) {
      throw new RetrievalError('PROTOCOL_MISMATCH', `不支持检索事件版本 ${String(event.schemaVersion)}。`)
    }
    if (event.sequence !== expectedSequence) throw new RetrievalError('PROTOCOL_MISMATCH', '检索事件序列不连续。')
    expectedSequence += 1
    if (expectedRetrievalId !== undefined && event.retrievalId !== expectedRetrievalId) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '检索事件属于不同的检索任务。')
    }
    if (eventIds.has(event.eventId)) throw new RetrievalError('PROTOCOL_MISMATCH', '检索事件身份重复。')
    eventIds.add(event.eventId)
    if (event.type === 'retrieval/state-recorded') {
      const next = event.data.state
      validateState(next, event, state)
      if (event.schemaVersion === 9 && next.revision !== 0) {
        throw new RetrievalError('PROTOCOL_MISMATCH', 'v9 只允许为 revision 0 写完整状态。')
      }
      state = next
      stateSchemaVersion = event.schemaVersion
    } else if (event.type === 'retrieval/state-patched') {
      if (![9, 10, 11, 12, 13].includes(event.schemaVersion) || state === undefined) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '状态增量缺少 v9/v10 基线状态。')
      }
      if (event.schemaVersion >= 12 && (stateSchemaVersion ?? 0) < 12) state = migrateLegacyRetrievalState(state)
      if (event.schemaVersion === 13 && stateSchemaVersion !== 13) state = migrateProjectionState(state)
      state = applyRetrievalStatePatch(state, event.data.patch)
      stateSchemaVersion = event.schemaVersion
      if (state.retrievalId !== event.retrievalId) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '状态增量改变了检索身份。')
      }
    }
  }
  if (state === undefined) return undefined
  if ((stateSchemaVersion ?? 0) < 12) state = migrateLegacyRetrievalState(state)
  return stateSchemaVersion === 13 ? state : migrateProjectionState(state)
}
