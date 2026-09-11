import { randomUUID } from 'node:crypto'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { RELEASED_V2_EVENT_TYPES, releasedV2SessionFormatCodec, sessionFormatV1ToV2, assertReleasedV2Header, restoreReleasedV2Artifact } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { REQUIRED_RETRIEVAL_EVENT_TYPES, RETRIEVAL_PRESENTATION_EVENT_TYPE, SUPPORTED_RETRIEVAL_EVENT_SCHEMA_VERSIONS } from '@retrieval-agent/contracts'
import { installDshSessionCompatibility } from './session-events.js'
import { prepareInitialStep } from './migration-step.js'

const restoreV2 = (artifact: SessionFormatArtifact) => restoreReleasedV2Artifact(artifact, new Set(RELEASED_V2_EVENT_TYPES))
const releasedV2 = createSessionFormatCatalog({ currentVersion: 2,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec],
  currentEncoder: releasedV2SessionFormatCodec, migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2],
  restoreCurrent: restoreV2, restoreTransformedCurrent: restoreV2,
  restoreCurrentHeader: header => { assertReleasedV2Header(header); return header },
})

const known = new Set<string>([...REQUIRED_RETRIEVAL_EVENT_TYPES, RETRIEVAL_PRESENTATION_EVENT_TYPE])
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid historical Session record')
  return value as Record<string, unknown>
}

/** Extension payloads contain product identities, never DSH event-sequence coordinates. */
function validateRetrievalRow(row: Record<string, unknown>): void {
  if (!known.has(String(row.type)) || Object.keys(row).some(key => !['type', 'seq', 'time', 'data'].includes(key))) {
    throw new Error(`Unsupported historical retrieval event envelope: ${String(row.type)}`)
  }
  const data = record(row.data)
  if (row.type === RETRIEVAL_PRESENTATION_EVENT_TYPE) {
    if (Object.keys(data).some(key => !['retrievalId', 'phase', 'turn', 'step'].includes(key))
      || typeof data.retrievalId !== 'string' || !data.retrievalId.trim()
      || !['candidates', 'result'].includes(String(data.phase))
      || !Number.isSafeInteger(data.turn) || Number(data.turn) < 0
      || (data.step !== undefined && (!Number.isSafeInteger(data.step) || Number(data.step) < 0))) {
      throw new Error('Invalid historical retrieval presentation anchor')
    }
    return
  }
  const event = record(data.event)
  if (Object.keys(data).some(key => key !== 'event') || event.type !== row.type
    || !SUPPORTED_RETRIEVAL_EVENT_SCHEMA_VERSIONS.some(version => version === event.schemaVersion)
    || typeof event.eventId !== 'string' || !event.eventId.trim()
    || typeof event.retrievalId !== 'string' || !event.retrievalId.trim()
    || !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0
    || typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new Error('Invalid historical retrieval event identity')
  }
  record(event.data)
}

/**
 * Convert released V0 logs without widening the upstream frozen event inventory.
 * Known log-only extensions travel through the pure converter as unique feedback
 * records so upstream sequence/provenance remapping still sees every position.
 * Those transport records are never published or presented: restore the exact
 * extension payloads, then validate the entire native V3 artifact again.
 */
export function migrateRetrievalSession(rows: readonly unknown[]): SessionFormatArtifact {
  installDshSessionCompatibility()
  const header = record(rows[0])
  if (header.version !== 0) throw new Error('CaseWeave migration requires a released V0 Session')
  const nonce = `caseweave-migration:${randomUUID()}:`
  const extensions = new Map<string, SessionFormatEvent>()
  const restore = releasedV2.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const value of rows.slice(1)) {
    const row = record(value)
    if (typeof row.type === 'string' && row.type.startsWith('retrieval/')) {
      validateRetrievalRow(row)
      const key = `${nonce}${extensions.size}`
      extensions.set(key, structuredClone(row) as SessionFormatEvent)
      restore.decodeRow({ ...row, type: 'feedback/record', data: { text: key } })
    } else restore.decodeRow(row)
  }
  const v2 = prepareInitialStep(restore.finish())
  const latest = sessionFormatCatalog.createRestore(releasedV2.encodeCurrentHeader(v2.header, v2.inheritedEventCount), { recovery: 'strict', validation: 'current' })
  for (const event of v2.events) latest.decodeRow(releasedV2.encodeCurrentEvent(event))
  const migrated = latest.finish()
  let recovered = 0
  const events = migrated.events.map(event => {
    if (event.type !== 'feedback/record') return event
    const original = extensions.get(String(record(event.data).text))
    if (!original) return event
    recovered++
    return { ...original, seq: event.seq }
  })
  if (recovered !== extensions.size) throw new Error('Historical retrieval events were lost during migration')
  const current = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(migrated.header, migrated.inheritedEventCount),
    { recovery: 'strict', validation: 'current' })
  for (const event of events) current.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  return current.finish()
}

/** Produce canonical V3 JSONL, validated before any file is published. */
export function encodeMigratedSession(artifact: SessionFormatArtifact): string {
  const rows: SessionFormatJsonObject[] = [sessionFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount),
    ...artifact.events.map(event => sessionFormatCatalog.encodeCurrentEvent(event))]
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}
