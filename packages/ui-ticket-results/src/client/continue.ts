import { ProductApiClientError, isRecord, postProductApi } from '@retrieval-agent/product-api/http-client'
import type { RetrievalId } from '@retrieval-agent/contracts'
import {
  CONTINUE_RETRIEVAL_ENDPOINT,
  type ContinueRetrievalResponse,
} from '@retrieval-agent/product-api/protocol'

export class ContinueRetrievalClientError extends ProductApiClientError {}

function isContinueResponse(value: unknown): value is ContinueRetrievalResponse {
  return isRecord(value)
    && typeof value.retrievalId === 'string'
    && Number.isInteger(value.candidateCount)
    && typeof value.nextPageAvailable === 'boolean'
}

export async function continueRetrieval(
  sessionId: string,
  retrievalId: RetrievalId,
): Promise<ContinueRetrievalResponse> {
  const { payload, status } = await postProductApi<ContinueRetrievalResponse>(
    CONTINUE_RETRIEVAL_ENDPOINT, { sessionId, retrievalId }, '继续检索', ContinueRetrievalClientError,
  )
  if (!isContinueResponse(payload) || payload.retrievalId !== retrievalId) {
    throw new ContinueRetrievalClientError('INVALID_RESPONSE', '继续检索服务返回的数据格式无效。', false, status)
  }
  return payload
}

export function continueFailureMessage(error: unknown): string {
  if (!(error instanceof ContinueRetrievalClientError)) return '继续检索失败，请稍后重试。'
  switch (error.code) {
    case 'SESSION_NOT_ACTIVE': return '会话当前不可用，请重新打开该会话后重试。'
    case 'SNAPSHOT_INVALID':
    case 'SNAPSHOT_NOT_FOUND': return '授权快照已失效，请重新执行检索。'
    case 'INVALID_TRANSITION': return '当前检索已不能继续，请查看最新结果。'
    case 'NETWORK_UNAVAILABLE': return '无法连接检索服务，请确认应用仍在运行。'
    default: return error.message
  }
}
