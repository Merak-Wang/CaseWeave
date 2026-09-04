import type { TicketCandidateNode } from '@retrieval-agent/contracts'
import { READ_RETRIEVAL_ENDPOINT } from '@retrieval-agent/product-api/protocol'

/** Fetch current access from the live Host; persisted Session data is never a grant. */
export async function readRetrievalPresentation(
  sessionId: string,
  retrievalId: string,
  signal?: AbortSignal,
): Promise<TicketCandidateNode> {
  const response = await fetch(READ_RETRIEVAL_ENDPOINT, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, retrievalId }),
    ...(signal === undefined ? {} : { signal }),
  })
  const payload = await response.json() as { readonly node?: TicketCandidateNode; readonly message?: string }
  if (!response.ok) throw new Error(payload.message ?? `工单重新授权失败（HTTP ${response.status}）。`)
  if (payload.node?.retrievalId !== retrievalId || !Array.isArray(payload.node.candidates)
    || !Array.isArray(payload.node.alreadyReadEvidence)) {
    throw new Error('工单服务返回了不属于当前检索的结果。')
  }
  return payload.node
}
