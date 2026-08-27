import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import { REQUIRED_RETRIEVAL_EVENT_TYPES, RetrievalId, makeRetrievalEvent } from '@retrieval-agent/contracts'
import {
  PINNED_DSH_SESSION_VERSION,
  appendRetrievalSessionEvent,
  assertCompatibleDshVersion,
  installDshSessionCompatibility,
  readRetrievalSessionEvents,
} from './session-events.js'

describe('DSH Session compatibility boundary', () => {
  it('fails closed for an unreviewed DSH version', () => {
    expect(() => { assertCompatibleDshVersion('0.1.2') }).toThrow(/expected 0\.1\.1-rc\.2/u)
  })

  it('registers every required retrieval event idempotently', () => {
    const first = installDshSessionCompatibility()
    const second = installDshSessionCompatibility()

    expect(first.packageVersion).toBe(PINNED_DSH_SESSION_VERSION)
    expect(second.newlyRegisteredEventTypes).toEqual([])
    expect(REQUIRED_RETRIEVAL_EVENT_TYPES.every(type => KNOWN_SESSION_EVENT_TYPES.has(type))).toBe(true)
  })

  it('round-trips the complete typed domain envelope through a detached Session', () => {
    installDshSessionCompatibility()
    const session = Session.create(SessionId('retrieval-test-session'))
    const event = makeRetrievalEvent({
      eventId: 'event-1',
      retrievalId: RetrievalId('retrieval-1'),
      sequence: 0,
      occurredAt: '2026-08-27T00:00:00.000Z',
      type: 'retrieval/stopped',
      data: { reason: 'permission_blocked', remainingGapKinds: ['coverage'] },
    })

    appendRetrievalSessionEvent(session, event)

    expect(readRetrievalSessionEvents(session)).toEqual([event])
    expect(session.events[0]).toMatchObject({ type: 'retrieval/stopped', data: { event } })
    expect(Object.isFrozen(session.events[0]?.data)).toBe(true)
  })
})
