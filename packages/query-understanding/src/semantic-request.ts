import type { TicketRetrievalRequest } from '@retrieval-agent/contracts'

/** Persist the unmodified user input before the parallel Python plan and vector search. */
export function buildSemanticTicketRequest(query: string): TicketRetrievalRequest {
  if (!query.trim() || query.length > 4000) throw new TypeError('query must contain 1-4000 characters')
  const fastQuery = { schemaVersion: 2 as const, source: 'direct_user' as const, rewriteApplied: false as const, vector: { text: query } }
  return { target: 'ranked_cases', query, countPolicy: 'adaptive', fastQuery, queryContract: {
    schemaVersion: 10, original: query, normalized: query.normalize('NFKC').trim(), task: 'ranked_cases',
    resultPolicy: 'adaptive_top_k', domain: 'general_ticket', language: 'und', entities: [], constraints: [],
    userRequirements: [], ambiguities: [], compilerVersion: 'python-semantic-plan-v1', fastQuery,
  } }
}
