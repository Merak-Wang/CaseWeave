import type { SemanticExecutionOptions, TicketRetrievalRequest } from '@retrieval-agent/contracts'

export const DEFAULT_SEMANTIC_EXECUTION: SemanticExecutionOptions = {
  onlineLearning: true, semanticMethod: 'auto', orchestration: 'fixed',
  onlineFusion: 'selective', onlineModels: ['dense_lr', 'dense_svm', 'dense_mlp', 'dense_hgb', 'feedback_margin', 'relation_logistic', 'dense_ridge', 'dense_rbf_svm', 'dense_extra_trees', 'dense_gaussian_nb', 'dense_knn'],
}

/** 规划和向量搜索都接收用户原句；仅内部比较视图折叠空白。 */
export function buildSemanticTicketRequest(query: string, execution?: SemanticExecutionOptions): TicketRetrievalRequest {
  if (!query.trim() || query.length > 4000) throw new TypeError('query must contain 1-4000 characters')
  const fastQuery = { schemaVersion: 2 as const, source: 'direct_user' as const, rewriteApplied: false as const, vector: { text: query } }
  return { target: 'ranked_cases', query, countPolicy: 'adaptive', fastQuery, queryContract: {
    semanticExecution: execution ?? DEFAULT_SEMANTIC_EXECUTION,
    schemaVersion: 10, original: query, normalized: query.normalize('NFKC').trim().replace(/\s+/gu, ' '), task: 'ranked_cases',
    resultPolicy: 'adaptive_top_k', domain: 'general_ticket', language: 'und', entities: [], constraints: [],
    userRequirements: [], ambiguities: [], compilerVersion: 'python-semantic-plan-v1', fastQuery,
  } }
}
