import type { RetrievalId } from '@retrieval-agent/contracts'
import {
  CONTINUE_RETRIEVAL_ENDPOINT,
  type ContinueRetrievalErrorResponse,
  type ContinueRetrievalResponse,
} from '@retrieval-agent/product-api/protocol'

export class ContinueRetrievalClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ContinueRetrievalClientError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isErrorResponse(value: unknown): value is ContinueRetrievalErrorResponse {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && typeof value.retryable === 'boolean'
}

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
  let response: Response
  try {
    response = await fetch(CONTINUE_RETRIEVAL_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, retrievalId }),
    })
  } catch (cause) {
    throw new ContinueRetrievalClientError('NETWORK_UNAVAILABLE', '无法连接继续检索服务。', true, undefined, { cause })
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new ContinueRetrievalClientError(
      'INVALID_RESPONSE', `继续检索服务返回了无法解析的响应（HTTP ${response.status}）。`,
      response.status >= 500, response.status, { cause },
    )
  }
  if (!response.ok) {
    if (isErrorResponse(payload)) {
      throw new ContinueRetrievalClientError(payload.code, payload.message, payload.retryable, response.status)
    }
    throw new ContinueRetrievalClientError(
      `HTTP_${response.status}`, `继续检索请求失败（HTTP ${response.status}）。`, response.status >= 500, response.status,
    )
  }
  if (!isContinueResponse(payload) || payload.retrievalId !== retrievalId) {
    throw new ContinueRetrievalClientError('INVALID_RESPONSE', '继续检索服务返回的数据格式无效。', false, response.status)
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
