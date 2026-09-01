import type { TicketQueryContract, TicketRetrievalSpec } from '@retrieval-agent/contracts'

/** Build an explicit low-confidence contract for non-compiler callers. */
export function fallbackQueryContract(spec: TicketRetrievalSpec): TicketQueryContract {
  const exhaustive = spec.target === 'constrained_list' || spec.target === 'cohort_collection'
  const containsHan = /\p{Script=Han}/u.test(spec.normalizedQuery)
  return {
    schemaVersion: 2,
    original: spec.originalQuery,
    normalized: spec.normalizedQuery,
    task: spec.target,
    resultPolicy: exhaustive
      ? 'exhaustive_current_snapshot'
      : spec.countPolicy === 'explicit' ? 'explicit_top_k' : 'adaptive_top_k',
    maxResults: spec.requestedCount,
    domain: containsHan ? 'telecom_ticket' : 'general_ticket',
    language: containsHan ? 'zh' : /[A-Za-z]/u.test(spec.normalizedQuery) ? 'en' : 'und',
    entities: [],
    constraints: spec.filters,
    ...(spec.requiredConcepts === undefined || spec.requiredConcepts.length === 0
      ? {}
      : { logic: { operator: 'and' as const, requiredConcepts: spec.requiredConcepts } }),
    ambiguities: spec.ambiguities,
    interpretationBasis: 'clarification_required',
    compilerVersion: spec.compilerVersion,
  }
}
