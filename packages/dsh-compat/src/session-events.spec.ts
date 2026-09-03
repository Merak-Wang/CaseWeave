import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  REQUIRED_RETRIEVAL_EVENT_TYPES,
  RETRIEVAL_PRESENTATION_EVENT_TYPE,
  RetrievalId,
  makeRetrievalEvent,
} from '@retrieval-agent/contracts'
import {
  PINNED_DSH_SESSION_VERSION,
  appendRetrievalPresentationAnchor,
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
    expect(KNOWN_SESSION_EVENT_TYPES.has(RETRIEVAL_PRESENTATION_EVENT_TYPE)).toBe(true)
  })

  it('registers the separate physical Session package used by the DSH runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retrieval-agent-dsh-host-'))
    try {
      const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh-session')
      const entrypoint = join(root, 'bin.cjs')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(entrypoint, '', 'utf8')
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-session',
        version: PINNED_DSH_SESSION_VERSION,
        main: 'index.cjs',
        exports: { '.': './index.cjs', './package.json': './package.json' },
      }), 'utf8')
      await writeFile(join(packageRoot, 'index.cjs'),
        'module.exports = { KNOWN_SESSION_EVENT_TYPES: new Set() }\n', 'utf8')

      const report = installDshSessionCompatibility({ runtimeEntrypoint: entrypoint })
      const runtimeRequire = createRequire(entrypoint)
      const runtime = runtimeRequire('@deepseek-ai/dsh-session') as { KNOWN_SESSION_EVENT_TYPES: Set<string> }

      expect(report.registeredRegistryCount).toBe(2)
      expect(REQUIRED_RETRIEVAL_EVENT_TYPES.every(type => runtime.KNOWN_SESSION_EVENT_TYPES.has(type))).toBe(true)
      expect(runtime.KNOWN_SESSION_EVENT_TYPES.has(RETRIEVAL_PRESENTATION_EVENT_TYPE)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  it('records each presentation phase once without polluting domain replay', () => {
    installDshSessionCompatibility()
    const session = Session.create(SessionId('retrieval-presentation-session'))
    const retrievalId = RetrievalId('retrieval-presentation')
    appendRetrievalPresentationAnchor(session, { retrievalId, phase: 'candidates', turn: 1, step: 1 })
    appendRetrievalPresentationAnchor(session, { retrievalId, phase: 'candidates', turn: 1, step: 2 })
    appendRetrievalPresentationAnchor(session, { retrievalId, phase: 'result', turn: 1 })

    expect(session.events.map(event => event.type)).toEqual([
      RETRIEVAL_PRESENTATION_EVENT_TYPE,
      RETRIEVAL_PRESENTATION_EVENT_TYPE,
    ])
    expect(session.events.map(event => event.data)).toEqual([
      { retrievalId, phase: 'candidates', turn: 1, step: 1 },
      { retrievalId, phase: 'result', turn: 1 },
    ])
    expect(readRetrievalSessionEvents(session)).toEqual([])
  })
})
