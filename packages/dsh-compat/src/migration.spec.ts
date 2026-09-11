import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { makeRetrievalEvent, RetrievalId } from '@retrieval-agent/contracts'
import { migrateRetrievalSession } from './migration.js'

const header = { type: 'session', version: 0, id: 'caseweave-v0', createdAt: 1, delegationDepth: 0 }
const event = makeRetrievalEvent({ eventId: 'stable-event', retrievalId: RetrievalId('task-1'), sequence: 0,
  occurredAt: '2026-09-10T00:00:00.000Z', type: 'retrieval/stopped',
  data: { reason: 'permission_blocked', remainingGapKinds: ['coverage'] } })
const row = { type: event.type, seq: 0, time: 2, data: { event } }

describe('released CaseWeave Session migration', () => {
  it('preserves retrieval identities through the official V0 refusal and V3 restoration', () => {
    const official = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    expect(() => { official.decodeRow(row); official.finish() }).toThrow(/unknown historical event/)
    const source = structuredClone([header, row])
    const result = migrateRetrievalSession(source)
    expect(result.header.version).toBe(3)
    expect(result.events).toEqual([row])
    expect(source).toEqual([header, row])
  })

  it('keeps native feedback distinct from migration transport records', () => {
    const feedback = { type: 'feedback/record', seq: 1, time: 3, data: { text: '用户原反馈' } }
    expect(migrateRetrievalSession([header, row, feedback]).events).toEqual([row, feedback])
  })

  it('refuses unrecognized extensions, altered identities and surface operations', () => {
    expect(() => migrateRetrievalSession([header, { ...row, type: 'retrieval/unknown' }])).toThrow()
    expect(() => migrateRetrievalSession([header, { ...row, data: { event: { ...event, type: 'retrieval/exported' } } }])).toThrow()
    expect(() => migrateRetrievalSession([header, { ...row, surfaceOp: 'append' }])).toThrow()
    expect(() => migrateRetrievalSession([header, { ...row, type: 'other/plugin' }])).toThrow()
  })

  it('continues to reject corrupt native events and source coordinates', () => {
    expect(() => migrateRetrievalSession([header, { type: 'user/message', seq: 0, time: 1, data: {} }, { ...row, seq: 1 }])).toThrow()
    expect(() => migrateRetrievalSession([header, { ...row, seq: 2 }])).toThrow()
  })
})
