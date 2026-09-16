import { ProductApiClientError, isRecord, postProductApi } from '@retrieval-agent/product-api/http-client'
import type { TicketCandidateNode } from '@retrieval-agent/contracts'
import {
  READ_RETRIEVAL_ENDPOINT,
  type ReadRetrievalResponse,
} from '@retrieval-agent/product-api/protocol'

/** Keeps the Host's error identity so the UI can distinguish deterministic failures from transient ones. */
export class RetrievalPresentationClientError extends ProductApiClientError {}

/** Snapshot invalidation is deterministic; re-requesting the same presentation can never succeed. */
export function snapshotInvalidated(error: unknown): boolean {
  return error instanceof RetrievalPresentationClientError
    && (error.code === 'SNAPSHOT_INVALID' || error.code === 'SNAPSHOT_NOT_FOUND')
}

/** Fetch current access from the live Host; persisted Session data is never a grant. */
export async function readRetrievalPresentation(
  sessionId: string,
  retrievalId: string,
  signal?: AbortSignal,
): Promise<TicketCandidateNode> {
  const { payload, status } = await postProductApi<ReadRetrievalResponse>(
    READ_RETRIEVAL_ENDPOINT, { sessionId, retrievalId }, '工单', RetrievalPresentationClientError, signal,
  )
  const node = isRecord(payload) ? (payload as unknown as ReadRetrievalResponse).node : undefined
  if (node?.retrievalId !== retrievalId || !Array.isArray(node.candidates)
    || !Array.isArray(node.alreadyReadEvidence)
    || (node.result !== undefined && (node.result.schemaVersion !== 2
      || typeof node.result.resultRevision !== 'string' || !Array.isArray(node.result.judgments)
      || !Array.isArray(node.result.tickets) || !Array.isArray(node.result.evidence)))) {
    throw new RetrievalPresentationClientError('INVALID_RESPONSE', '工单服务返回了不属于当前检索的结果。', false, status)
  }
  return node
}
