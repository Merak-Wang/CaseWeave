import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RetrievalId } from '@retrieval-agent/contracts'
import { installDshSessionCompatibility } from '@retrieval-agent/dsh-compat'
import { SessionRetrievalEventJournal } from './session-journal.js'

describe('SessionRetrievalEventJournal', () => {
  it('continues per-retrieval event sequence after a Session replay seed', () => {
    installDshSessionCompatibility()
    const retrievalId = RetrievalId('retrieval-session-1')
    const source = Session.create(SessionId('source-session'))
    const first = new SessionRetrievalEventJournal(source, {
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      eventId: () => 'event-0',
    })
    first.append(retrievalId, 'retrieval/stopped', { reason: 'cancelled', remainingGapKinds: ['coverage'] })

    const replayed = Session.create(SessionId('replayed-session'), source.events)
    const second = new SessionRetrievalEventJournal(replayed, {
      now: () => new Date('2026-08-27T00:00:01.000Z'),
      eventId: () => 'event-1',
    })
    const appended = second.append(retrievalId, 'retrieval/stopped', { reason: 'backend_error', remainingGapKinds: ['depth'] })

    expect(appended.sequence).toBe(1)
    expect(second.read(retrievalId).map(event => event.eventId)).toEqual(['event-0', 'event-1'])
    expect(second.all()).toHaveLength(2)
  })
})
