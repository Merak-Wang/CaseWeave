import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  RetrievalDomainEvent,
  RetrievalPresentationAnchor,
  RetrievalInputAccepted,
} from '@retrieval-agent/contracts'
import {
  REQUIRED_RETRIEVAL_EVENT_TYPES,
  RETRIEVAL_PRESENTATION_EVENT_TYPE,
  RETRIEVAL_INPUT_ACCEPTED_EVENT_TYPE,
} from '@retrieval-agent/contracts'

const require = createRequire(import.meta.url)
const sessionPackage = require('@deepseek-ai/dsh-session/package.json') as { readonly version?: unknown }

export const PINNED_DSH_SESSION_VERSION = '0.1.5-rc.2' as const

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'retrieval/input-accepted': RetrievalInputAccepted
    'retrieval/query-contracted': { readonly event: RetrievalDomainEvent<'retrieval/query-contracted'> }
    'retrieval/snapshot-opened': { readonly event: RetrievalDomainEvent<'retrieval/snapshot-opened'> }
    'retrieval/search-completed': { readonly event: RetrievalDomainEvent<'retrieval/search-completed'> }
    'retrieval/knowledge-assessed': { readonly event: RetrievalDomainEvent<'retrieval/knowledge-assessed'> }
    'retrieval/decision-submitted': { readonly event: RetrievalDomainEvent<'retrieval/decision-submitted'> }
    'retrieval/state-recorded': { readonly event: RetrievalDomainEvent<'retrieval/state-recorded'> }
    'retrieval/state-patched': { readonly event: RetrievalDomainEvent<'retrieval/state-patched'> }
    'retrieval/evidence-promoted': { readonly event: RetrievalDomainEvent<'retrieval/evidence-promoted'> }
    'retrieval/clarification-requested': { readonly event: RetrievalDomainEvent<'retrieval/clarification-requested'> }
    'retrieval/clarification-answered': { readonly event: RetrievalDomainEvent<'retrieval/clarification-answered'> }
    'retrieval/user-feedback-received': { readonly event: RetrievalDomainEvent<'retrieval/user-feedback-received'> }
    'retrieval/context-projected': { readonly event: RetrievalDomainEvent<'retrieval/context-projected'> }
    'retrieval/model-request-measured': { readonly event: RetrievalDomainEvent<'retrieval/model-request-measured'> }
    'retrieval/model-response-measured': { readonly event: RetrievalDomainEvent<'retrieval/model-response-measured'> }
    'retrieval/tool-call-measured': { readonly event: RetrievalDomainEvent<'retrieval/tool-call-measured'> }
    'retrieval/evidence-frozen': { readonly event: RetrievalDomainEvent<'retrieval/evidence-frozen'> }
    'retrieval/stopped': { readonly event: RetrievalDomainEvent<'retrieval/stopped'> }
    'retrieval/detail-read': { readonly event: RetrievalDomainEvent<'retrieval/detail-read'> }
    'retrieval/l3-detail-read': { readonly event: RetrievalDomainEvent<'retrieval/l3-detail-read'> }
    'retrieval/l3-details-read': { readonly event: RetrievalDomainEvent<'retrieval/l3-details-read'> }
    'retrieval/exported': { readonly event: RetrievalDomainEvent<'retrieval/exported'> }
    'retrieval/presentation-anchored': RetrievalPresentationAnchor
  }
}

const REQUIRED_RETRIEVAL_SESSION_EVENT_TYPES = Object.freeze([
  ...REQUIRED_RETRIEVAL_EVENT_TYPES,
  RETRIEVAL_PRESENTATION_EVENT_TYPE,
  RETRIEVAL_INPUT_ACCEPTED_EVENT_TYPE,
] as const)

export interface DshSessionCompatibilityReport {
  readonly packageVersion: typeof PINNED_DSH_SESSION_VERSION
  readonly registeredRegistryCount: number
  readonly registeredEventTypes: readonly (typeof REQUIRED_RETRIEVAL_SESSION_EVENT_TYPES)[number][]
  readonly newlyRegisteredEventTypes: readonly (typeof REQUIRED_RETRIEVAL_SESSION_EVENT_TYPES)[number][]
}

export interface DshSessionCompatibilityOptions {
  /** DSH executable used to resolve the host's physical Session package instance. */
  readonly runtimeEntrypoint?: string
}

export function assertCompatibleDshVersion(actual: unknown): asserts actual is typeof PINNED_DSH_SESSION_VERSION {
  if (actual !== PINNED_DSH_SESSION_VERSION) {
    throw new Error(`Unsupported @deepseek-ai/dsh-session version ${String(actual)}; expected ${PINNED_DSH_SESSION_VERSION}`)
  }
}

function isModuleNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND')
}

/** Resolve the Session registry used by the DSH executable, not the plugin's peer-dependency copy. */
function resolveRuntimeSessionRegistry(entrypoint: string | undefined): Set<string> | undefined {
  if (entrypoint === undefined || entrypoint.length === 0) return undefined
  let runtimeRequire: NodeJS.Require
  try {
    runtimeRequire = createRequire(realpathSync(entrypoint))
  } catch (error) {
    if (isModuleNotFound(error) || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
      return undefined
    }
    throw error
  }
  let packagePath: string
  try {
    packagePath = runtimeRequire.resolve('@deepseek-ai/dsh-session/package.json')
  } catch (error) {
    if (isModuleNotFound(error)) return undefined
    throw error
  }
  const descriptor = runtimeRequire(packagePath) as { readonly version?: unknown }
  assertCompatibleDshVersion(descriptor.version)
  const runtimeModule = runtimeRequire('@deepseek-ai/dsh-session') as { readonly KNOWN_SESSION_EVENT_TYPES?: unknown }
  if (!(runtimeModule.KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('DSH runtime Session event registry is not mutable on the pinned runtime')
  }
  return runtimeModule.KNOWN_SESSION_EVENT_TYPES as Set<string>
}

/**
 * Install the one temporary out-of-tree event-vocabulary adaptation.
 *
 * DSH 0.1.5-rc.2 exposes the generated set but not a keyed downstream
 * registration API. This mutation is deliberately centralized and guarded by
 * an exact version handshake so it fails closed when DSH changes.
 */
export function installDshSessionCompatibility(
  options: DshSessionCompatibilityOptions = {},
): DshSessionCompatibilityReport {
  assertCompatibleDshVersion(sessionPackage.version)
  if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('DSH known Session event registry is not mutable on the pinned runtime')
  }
  // pnpm can load the DSH executable and an out-of-tree plugin from two physical copies of the same
  // package. Register both identities so persistence and product replay share one required vocabulary.
  const registries = new Set<Set<string>>([KNOWN_SESSION_EVENT_TYPES as Set<string>])
  const runtimeRegistry = resolveRuntimeSessionRegistry(options.runtimeEntrypoint ?? process.argv[1])
  if (runtimeRegistry !== undefined) registries.add(runtimeRegistry)
  const newlyRegisteredEventTypes: (typeof REQUIRED_RETRIEVAL_SESSION_EVENT_TYPES)[number][] = []
  for (const eventType of REQUIRED_RETRIEVAL_SESSION_EVENT_TYPES) {
    let newlyRegistered = false
    for (const registry of registries) {
      if (!registry.has(eventType)) newlyRegistered = true
      registry.add(eventType)
    }
    if (newlyRegistered) newlyRegisteredEventTypes.push(eventType)
  }
  return {
    packageVersion: PINNED_DSH_SESSION_VERSION,
    registeredRegistryCount: registries.size,
    registeredEventTypes: [...REQUIRED_RETRIEVAL_SESSION_EVENT_TYPES],
    newlyRegisteredEventTypes,
  }
}

/**
 * Append one idempotent presentation boundary for a retrieval. The boundary
 * is a persisted Session fact, but it is intentionally not a domain event and
 * therefore cannot alter replayed retrieval state or model-visible evidence.
 */
export function appendRetrievalPresentationAnchor(
  session: Session,
  anchor: RetrievalPresentationAnchor,
): void {
  const exists = session.snapshotEvents().some(event => event.type === RETRIEVAL_PRESENTATION_EVENT_TYPE
    && event.data.retrievalId === anchor.retrievalId
    && event.data.phase === anchor.phase)
  if (!exists) session.append(RETRIEVAL_PRESENTATION_EVENT_TYPE, anchor)
}

/** Append a typed retrieval event without leaking DSH casts into product packages. */
export function appendRetrievalSessionEvent(session: Session, event: RetrievalDomainEvent): void {
  switch (event.type) {
    case 'retrieval/query-contracted': session.append(event.type, { event }); return
    case 'retrieval/snapshot-opened': session.append(event.type, { event }); return
    case 'retrieval/search-completed': session.append(event.type, { event }); return
    case 'retrieval/knowledge-assessed': session.append(event.type, { event }); return
    case 'retrieval/decision-submitted': session.append(event.type, { event }); return
    case 'retrieval/state-recorded': session.append(event.type, { event }); return
    case 'retrieval/state-patched': session.append(event.type, { event }); return
    case 'retrieval/evidence-promoted': session.append(event.type, { event }); return
    case 'retrieval/clarification-requested': session.append(event.type, { event }); return
    case 'retrieval/clarification-answered': session.append(event.type, { event }); return
    case 'retrieval/user-feedback-received': session.append(event.type, { event }); return
    case 'retrieval/context-projected': session.append(event.type, { event }); return
    case 'retrieval/model-request-measured': session.append(event.type, { event }); return
    case 'retrieval/model-response-measured': session.append(event.type, { event }); return
    case 'retrieval/tool-call-measured': session.append(event.type, { event }); return
    case 'retrieval/evidence-frozen': session.append(event.type, { event }); return
    case 'retrieval/stopped': session.append(event.type, { event }); return
    case 'retrieval/detail-read': session.append(event.type, { event }); return
    case 'retrieval/l3-detail-read': session.append(event.type, { event }); return
    case 'retrieval/l3-details-read': session.append(event.type, { event }); return
    case 'retrieval/exported': session.append(event.type, { event }); return
    default: return event satisfies never
  }
}

/** Recover exact domain envelopes from a DSH Session log for deterministic replay. */
export function readRetrievalSessionEvents(session: Session): readonly RetrievalDomainEvent[] {
  const known = new Set<string>(REQUIRED_RETRIEVAL_EVENT_TYPES)
  const result: RetrievalDomainEvent[] = []
  for (const sessionEvent of session.snapshotEvents()) {
    if (!known.has(sessionEvent.type)) continue
    const data = sessionEvent.data as { readonly event?: unknown }
    const event = data.event
    if (event === null || typeof event !== 'object') throw new Error(`Malformed retrieval Session event at seq ${sessionEvent.seq}`)
    result.push(event as RetrievalDomainEvent)
  }
  return result
}
