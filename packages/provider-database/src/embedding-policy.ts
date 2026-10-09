import { EMBEDDING_INSTRUCTION } from '@retrieval-agent/model-service-client/ranking'
import type { EmbeddingIdentity } from './store.js'

/** Old publications use the pinned repository task, never a mutable service default. */
export function effectiveQueryInstruction(identity: EmbeddingIdentity): string {
  return identity.queryInstruction?.trim() ? identity.queryInstruction : EMBEDDING_INSTRUCTION
}
export function queryEmbeddingIdentity(identity: EmbeddingIdentity) {
  return { model: identity.model, revision: identity.revision, dimensions: identity.dimensions,
    normalization: identity.normalization, pooling: identity.pooling ?? 'last_token',
    projection: identity.documentProjection ?? 'ticket-search-projection-v1', chunkVersion: identity.chunkVersion,
    instruction: effectiveQueryInstruction(identity), inputType: 'query' }
}
