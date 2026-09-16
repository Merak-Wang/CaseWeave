import type { TicketRetrievalRequest } from '@retrieval-agent/contracts'

/** 规划和向量搜索都接收用户原句；仅内部比较视图折叠空白。 */
export function buildSemanticTicketRequest(query: string): TicketRetrievalRequest {
  if (!query.trim() || query.length > 4000) throw new TypeError('query must contain 1-4000 characters')
  const fastQuery = { schemaVersion: 2 as const, source: 'direct_user' as const, rewriteApplied: false as const, vector: { text: query } }
  return { target: 'ranked_cases', query, countPolicy: 'adaptive', fastQuery, queryContract: {
    schemaVersion: 10, original: query, normalized: query.normalize('NFKC').trim().replace(/\s+/gu, ' '), task: 'ranked_cases',
    resultPolicy: 'adaptive_top_k', domain: 'general_ticket', language: 'und', entities: [], constraints: [],
    userRequirements: [], ambiguities: [], compilerVersion: 'python-semantic-plan-v1', fastQuery,
  } }
}
