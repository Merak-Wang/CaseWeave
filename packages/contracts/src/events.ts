import type { RetrievalId, TicketCandidateRef, TicketEvidenceId } from './brand.js'
import type {
  TicketEvidenceSegment,
  TicketQueryContract,
  TicketRetrievalSpec,
  TicketSearchPage,
  TicketSnapshot,
} from './types.js'
import type {
  CandidateDetailReadReceipt,
  CandidateExportReceipt,
  EvidenceContextSelection,
  FrozenEvidencePack,
  RetrievalKnowledgeAssessment,
  RetrievalState,
  RetrievalTaskContract,
  RetrievalTermination,
} from './retrieval-state.js'
import type { TicketSearchStage } from './ranking.js'

export const RETRIEVAL_EVENT_SCHEMA_VERSION = 6 as const
export const SUPPORTED_RETRIEVAL_EVENT_SCHEMA_VERSIONS = Object.freeze([5, 6] as const)

/**
 * Durable UI placement is deliberately separate from retrieval-domain state.
 * Pre-step search can execute before DSH persists the visible user message,
 * while the product result must render at the conversational boundary that
 * users perceive. This event records that boundary without changing evidence.
 */
export const RETRIEVAL_PRESENTATION_EVENT_TYPE = 'retrieval/presentation-anchored' as const
export type RetrievalPresentationPhase = 'candidates' | 'result'

export interface RetrievalPresentationAnchor {
  readonly retrievalId: RetrievalId
  readonly phase: RetrievalPresentationPhase
  readonly turn: number
  readonly step?: number
}

export interface RetrievalEventDataMap {
  'retrieval/query-contracted': {
    readonly contract: RetrievalTaskContract
    readonly queryContract: TicketQueryContract
    readonly spec: TicketRetrievalSpec
  }
  'retrieval/snapshot-opened': { readonly snapshot: TicketSnapshot }
  'retrieval/search-completed': { readonly stage: TicketSearchStage; readonly spec: TicketRetrievalSpec; readonly page: TicketSearchPage }
  'retrieval/knowledge-assessed': { readonly assessment: RetrievalKnowledgeAssessment }
  'retrieval/state-recorded': { readonly state: RetrievalState }
  'retrieval/evidence-promoted': { readonly evidence: readonly TicketEvidenceSegment[]; readonly tokensUsed: number }
  'retrieval/clarification-requested': { readonly facet: string; readonly question: string; readonly candidateRefs: readonly TicketCandidateRef[] }
  'retrieval/clarification-answered': { readonly facet: string; readonly accepted: boolean; readonly answer?: string }
  'retrieval/context-projected': { readonly selection: EvidenceContextSelection }
  'retrieval/model-request-measured': {
    readonly estimatedInputTokens: number
    readonly serializationBytes: number
    readonly wallClockElapsedMs: number
    readonly accepted: boolean
  }
  'retrieval/model-response-measured': { readonly modelLatencyMs: number; readonly outputTokens: number }
  'retrieval/tool-call-measured': { readonly success: boolean; readonly serializationBytes: number }
  'retrieval/evidence-frozen': { readonly pack: FrozenEvidencePack }
  'retrieval/stopped': { readonly reason: RetrievalTermination; readonly remainingGapKinds: readonly string[] }
  'retrieval/detail-read': { readonly receipt: CandidateDetailReadReceipt }
  'retrieval/exported': { readonly receipt: CandidateExportReceipt }
}
export type RetrievalEventType = keyof RetrievalEventDataMap

export type RetrievalDomainEvent<T extends RetrievalEventType = RetrievalEventType> = {
  [K in RetrievalEventType]: {
    readonly eventId: string
    readonly schemaVersion: (typeof SUPPORTED_RETRIEVAL_EVENT_SCHEMA_VERSIONS)[number]
    readonly retrievalId: RetrievalId
    readonly sequence: number
    readonly occurredAt: string
    readonly type: K
    readonly data: RetrievalEventDataMap[K]
  }
}[T]

export const REQUIRED_RETRIEVAL_EVENT_TYPES = Object.freeze([
  'retrieval/query-contracted',
  'retrieval/snapshot-opened',
  'retrieval/search-completed',
  'retrieval/knowledge-assessed',
  'retrieval/state-recorded',
  'retrieval/evidence-promoted',
  'retrieval/clarification-requested',
  'retrieval/clarification-answered',
  'retrieval/context-projected',
  'retrieval/model-request-measured',
  'retrieval/model-response-measured',
  'retrieval/tool-call-measured',
  'retrieval/evidence-frozen',
  'retrieval/stopped',
  'retrieval/detail-read',
  'retrieval/exported',
] as const satisfies readonly RetrievalEventType[])

export function makeRetrievalEvent<T extends RetrievalEventType>(input: {
  readonly eventId: string
  readonly retrievalId: RetrievalId
  readonly sequence: number
  readonly occurredAt: string
  readonly type: T
  readonly data: RetrievalEventDataMap[T]
}): RetrievalDomainEvent<T> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new TypeError('event sequence must be a non-negative safe integer')
  if (input.eventId.trim().length === 0) throw new TypeError('eventId must be non-empty')
  if (Number.isNaN(Date.parse(input.occurredAt))) throw new TypeError('occurredAt must be an ISO-compatible timestamp')
  return {
    eventId: input.eventId,
    schemaVersion: RETRIEVAL_EVENT_SCHEMA_VERSION,
    retrievalId: input.retrievalId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    type: input.type,
    data: input.data,
  } as RetrievalDomainEvent<T>
}

export function evidenceIdentitySet(events: readonly RetrievalDomainEvent[]): ReadonlySet<TicketEvidenceId> {
  const result = new Set<TicketEvidenceId>()
  for (const event of events) {
    if (event.type !== 'retrieval/evidence-promoted') continue
    for (const evidence of event.data.evidence) result.add(evidence.evidenceId)
  }
  return result
}
