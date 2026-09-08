import type { TicketCandidateNode } from '@retrieval-agent/contracts'
import {
  READ_RETRIEVAL_ENDPOINT,
  type ReadRetrievalErrorResponse,
  type ReadRetrievalResponse,
} from '@retrieval-agent/product-api/protocol'

/** Keeps the Host's error identity so the UI can distinguish deterministic failures from transient ones. */
export class RetrievalPresentationClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RetrievalPresentationClientError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isErrorResponse(value: unknown): value is ReadRetrievalErrorResponse {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && typeof value.retryable === 'boolean'
}

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
  let response: Response
  try {
    response = await fetch(READ_RETRIEVAL_ENDPOINT, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, retrievalId }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (cause) {
    throw new RetrievalPresentationClientError('NETWORK_UNAVAILABLE', '无法连接工单服务。', true, undefined, { cause })
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new RetrievalPresentationClientError(
      'INVALID_RESPONSE',
      `工单重新授权失败（HTTP ${response.status}）。`,
      response.status >= 500,
      response.status,
      { cause },
    )
  }
  if (!response.ok) {
    if (isErrorResponse(payload)) {
      throw new RetrievalPresentationClientError(payload.code, payload.message, payload.retryable, response.status)
    }
    throw new RetrievalPresentationClientError(
      `HTTP_${response.status}`,
      `工单重新授权失败（HTTP ${response.status}）。`,
      response.status >= 500,
      response.status,
    )
  }
  const node = isRecord(payload) ? (payload as unknown as ReadRetrievalResponse).node : undefined
  if (node?.retrievalId !== retrievalId || !Array.isArray(node.candidates)
    || !Array.isArray(node.alreadyReadEvidence)
    || (node.result !== undefined && (node.result.schemaVersion !== 2
      || typeof node.result.resultRevision !== 'string' || !Array.isArray(node.result.judgments)
      || !Array.isArray(node.result.tickets) || !Array.isArray(node.result.evidence)))) {
    throw new RetrievalPresentationClientError('INVALID_RESPONSE', '工单服务返回了不属于当前检索的结果。', false, response.status)
  }
  return node
}
