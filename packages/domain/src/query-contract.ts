import type { TicketQueryContract, TicketRetrievalSpec } from '@retrieval-agent/contracts'

/** Build an explicit low-confidence contract for non-compiler callers. */
export function fallbackQueryContract(spec: TicketRetrievalSpec): TicketQueryContract {
  const containsHan = /\p{Script=Han}/u.test(spec.normalizedQuery)
  return {
    schemaVersion: 8,
    original: spec.originalQuery,
    normalized: spec.normalizedQuery,
    task: spec.target,
    resultPolicy: spec.countPolicy === 'exhaustive'
      ? 'exhaustive_current_snapshot'
      : spec.countPolicy === 'explicit' ? 'explicit_top_k' : 'adaptive_top_k',
    ...(spec.requestedCount === undefined ? {} : { resultLimit: spec.requestedCount }),
    domain: containsHan ? 'telecom_ticket' : 'general_ticket',
    language: containsHan ? 'zh' : /[A-Za-z]/u.test(spec.normalizedQuery) ? 'en' : 'und',
    entities: [],
    constraints: spec.filters,
    userRequirements: [
      ...spec.filters.map(filter => ({ text: spec.originalQuery, status: 'compiled' as const, filters: [filter] })),
      ...spec.ambiguities.filter(ambiguity => ambiguity.kind !== 'quantity').map(ambiguity => ({
        text: ambiguity.text, status: 'unresolved' as const, filters: [], reason: '尚未编译为可执行条件',
      })),
    ],
    ...(spec.requiredConcepts === undefined || spec.requiredConcepts.length === 0
      ? {}
      : { logic: { operator: 'and' as const, requiredConcepts: spec.requiredConcepts } }),
    ambiguities: spec.ambiguities,
    interpretationBasis: 'clarification_required',
    compilerVersion: spec.compilerVersion,
  }
}
