import {
  RETRIEVAL_EVENT_SCHEMA_VERSION,
  RetrievalError,
  type RetrievalDomainEvent,
  type RetrievalId,
  type RetrievalState,
} from '@retrieval-agent/contracts'

/** Replay and validate contiguous state snapshots from one retrieval event stream. */
export function foldRetrievalEvents(events: readonly RetrievalDomainEvent[], expectedRetrievalId?: RetrievalId): RetrievalState | undefined {
  let state: RetrievalState | undefined
  let expectedSequence = 0
  const eventIds = new Set<string>()
  for (const event of events) {
    if (event.schemaVersion !== RETRIEVAL_EVENT_SCHEMA_VERSION) {
      throw new RetrievalError('PROTOCOL_MISMATCH', `不支持检索事件版本 ${String(event.schemaVersion)}。`)
    }
    if (event.sequence !== expectedSequence) throw new RetrievalError('PROTOCOL_MISMATCH', '检索事件序列不连续。')
    expectedSequence += 1
    if (expectedRetrievalId !== undefined && event.retrievalId !== expectedRetrievalId) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '检索事件属于不同的检索任务。')
    }
    if (eventIds.has(event.eventId)) throw new RetrievalError('PROTOCOL_MISMATCH', '检索事件身份重复。')
    eventIds.add(event.eventId)
    if (event.type !== 'retrieval/state-recorded') continue
    const next = event.data.state
    if (next.retrievalId !== event.retrievalId) throw new RetrievalError('PROTOCOL_MISMATCH', '状态与事件的检索身份不一致。')
    if (state === undefined) {
      if (next.revision !== 0 || next.previousStateId !== undefined) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '首个检索状态必须从 revision 0 开始。')
      }
    } else if (next.previousStateId !== state.stateId || next.revision !== state.revision + 1) {
      throw new RetrievalError('PROTOCOL_MISMATCH', '检索状态链不连续。')
    }
    state = next
  }
  return state
}
