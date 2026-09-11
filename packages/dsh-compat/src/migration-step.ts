import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/**
 * V0 admitted input and fast-query facts before its first step/start. V3 needs
 * that existing step to install the protected system head before those inputs.
 * Move only this start marker within its own open turn. Original timestamps,
 * message order, request meaning, and product event identities are retained.
 */
export function prepareInitialStep(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const events = [...artifact.events]
  const firstSurface = events.findIndex(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type))
  const firstStep = events.findIndex(event => event.type === 'step/start')
  if (firstSurface < 0 || (firstStep >= 0 && firstStep < firstSurface)) return artifact
  const step = events[firstStep]
  const first = events[firstSurface]
  const openTurn = events.slice(0, firstSurface).findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (!step || !first || first.type !== 'user/message' || openTurn?.type !== 'turn/start'
    || (openTurn.data as SessionFormatJsonObject).turn !== (step.data as SessionFormatJsonObject).turn
    || events.slice(firstSurface, firstStep).some(event => ['turn/start', 'turn/end', 'step/end', 'session/end-seed', 'request/header'].includes(event.type))) {
    throw new Error('Historical pre-step input cannot be migrated without changing a turn or request')
  }
  events.splice(firstStep, 1)
  events.splice(firstSurface, 0, step)
  const mapping = new Map(events.map((event, seq) => [event.seq, seq]))
  const remapped = events.map((event, seq): SessionFormatEvent => {
    const one = (value: SessionFormatJsonValue | undefined): number => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value >= event.seq) throw new Error('Invalid historical event reference')
      const target = mapping.get(value)
      if (target === undefined || target >= seq) throw new Error('Initial step migration would create a forward reference')
      return target
    }
    const list = (value: SessionFormatJsonValue | undefined): number[] => {
      if (!Array.isArray(value)) throw new Error('Invalid historical event reference list')
      return value.map(one)
    }
    const range = (value: SessionFormatJsonValue | undefined): SessionFormatJsonObject => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid historical event range')
      const object = value as SessionFormatJsonObject
      return { ...object, start: one(object.start), end: one(object.end) }
    }
    let data = event.data as SessionFormatJsonObject
    if (event.type === 'command/done' && data.sourceEventSeq !== undefined) data = { ...data, sourceEventSeq: one(data.sourceEventSeq) }
    if (['session/title', 'session/title-llm-request'].includes(event.type)) data = { ...data, messageSeqs: list(data.messageSeqs) }
    if (['compaction/summary', 'compaction/prune'].includes(event.type)) data = { ...data, shadowedRange: range(data.shadowedRange), shadowedSeqs: list(data.shadowedSeqs) }
    return { ...event, seq, data,
      ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: list(event.sourceEventSeqs) }),
      ...(event.surfaceOp === undefined || event.surfaceOp === 'append' ? {} : { surfaceOp: range(event.surfaceOp) }) }
  })
  return { ...artifact, events: remapped }
}
