import {
  RetrievalStateId,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { createRetrievalStatePatch } from '@retrieval-agent/retrieval-replay'
import type { RetrievalEventJournal } from './journal.js'

type Clock = () => Date
type IdFactory = () => string

export function retrievalStateId(retrievalId: string, revision: number, uniqueId: string): ReturnType<typeof RetrievalStateId> {
  return RetrievalStateId(`state_${retrievalId}_${revision}_${uniqueId}`)
}

export function advanceRetrievalState(
  state: RetrievalState,
  patch: Partial<RetrievalState>,
  now: Clock,
  id: IdFactory,
): RetrievalState {
  const revision = state.revision + 1
  const next: RetrievalState = {
    ...state,
    ...patch,
    stateId: retrievalStateId(state.retrievalId, revision, id()),
    previousStateId: state.stateId,
    revision,
    updatedAt: now().toISOString(),
  }
  if (next.lastAssessment !== undefined) return next
  const { lastAssessment: _lastAssessment, ...serializable } = next
  return serializable
}

export function recordRetrievalState(
  journal: RetrievalEventJournal,
  state: RetrievalState,
  previous?: RetrievalState,
): void {
  if (previous === undefined) {
    journal.append(state.retrievalId, 'retrieval/state-recorded', { state })
    return
  }
  journal.append(state.retrievalId, 'retrieval/state-patched', {
    patch: createRetrievalStatePatch(previous, state),
  })
}

export function recordMeasuredBudget(
  journal: RetrievalEventJournal,
  state: RetrievalState,
  eventId: string,
  budget: RetrievalState['budget'],
  now: Clock,
  id: IdFactory,
): RetrievalState {
  const next = advanceRetrievalState(
    state,
    { budget, provenance: { ...state.provenance, sourceEventIds: [eventId] } },
    now,
    id,
  )
  recordRetrievalState(journal, next, state)
  return next
}
