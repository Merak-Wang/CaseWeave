import type { TicketCandidateRef, TicketDetail, TicketEvidenceField } from '@retrieval-agent/contracts'
import {
  READ_TICKET_DETAIL_ENDPOINT,
  type ReadTicketDetailErrorResponse,
  type ReadTicketDetailResponse,
} from '@retrieval-agent/product-api/protocol'

export class TicketDetailClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TicketDetailClientError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isErrorResponse(value: unknown): value is ReadTicketDetailErrorResponse {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && typeof value.retryable === 'boolean'
}

function isDetailResponse(value: unknown): value is ReadTicketDetailResponse {
  return isRecord(value)
    && Array.isArray(value.details)
    && Array.isArray(value.rejectedCandidateRefs)
    && Array.isArray(value.warnings)
    && isRecord(value.receipt)
}

export async function readTicketDetail(
  sessionId: string,
  retrievalId: string,
  candidateRef: TicketCandidateRef,
  fields: readonly TicketEvidenceField[],
): Promise<TicketDetail> {
  let response: Response
  try {
    response = await fetch(READ_TICKET_DETAIL_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, retrievalId, candidateRefs: [candidateRef], fields }),
    })
  } catch (cause) {
    throw new TicketDetailClientError('NETWORK_UNAVAILABLE', '无法连接工单详情服务。', true, undefined, { cause })
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new TicketDetailClientError(
      'INVALID_RESPONSE',
      `工单详情服务返回了无法解析的响应（HTTP ${response.status}）。`,
      response.status >= 500,
      response.status,
      { cause },
    )
  }
  if (!response.ok) {
    if (isErrorResponse(payload)) {
      throw new TicketDetailClientError(payload.code, payload.message, payload.retryable, response.status)
    }
    throw new TicketDetailClientError(
      `HTTP_${response.status}`,
      `工单详情请求失败（HTTP ${response.status}）。`,
      response.status >= 500,
      response.status,
    )
  }
  if (!isDetailResponse(payload)) {
    throw new TicketDetailClientError('INVALID_RESPONSE', '工单详情服务返回的数据格式无效。', false, response.status)
  }
  const detail = payload.details.find(item => item.candidateRef === candidateRef)
  if (detail === undefined || payload.rejectedCandidateRefs.length > 0) {
    throw new TicketDetailClientError('UNAUTHORIZED', '当前工单详情不可访问，请重新检索。', false, response.status)
  }
  return detail
}

export function detailFailureMessage(error: unknown): string {
  if (!(error instanceof TicketDetailClientError)) return '工单详情读取失败，请稍后重试。'
  switch (error.code) {
    case 'SESSION_NOT_ACTIVE': return '会话当前不可用，请重新打开该会话后重试。'
    case 'SNAPSHOT_INVALID':
    case 'SNAPSHOT_NOT_FOUND': return '授权快照已失效，请重新执行检索。'
    case 'UNAUTHORIZED': return '当前身份不再有权读取这条工单。'
    case 'NETWORK_UNAVAILABLE': return '无法连接详情服务，请确认应用仍在运行。'
    default: return error.message
  }
}
