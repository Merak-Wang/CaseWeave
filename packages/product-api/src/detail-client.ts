import { ProductApiClientError, isRecord, postProductApi } from './http-client.js'
import type { TicketCandidateRef, TicketDetail, TicketEvidenceField } from '@retrieval-agent/contracts'
import {
  READ_TICKET_DETAIL_ENDPOINT,
  type ReadTicketDetailResponse,
} from './protocol.js'

export class TicketDetailClientError extends ProductApiClientError {}

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
  const { payload, status } = await postProductApi<ReadTicketDetailResponse>(
    READ_TICKET_DETAIL_ENDPOINT, { sessionId, retrievalId, candidateRefs: [candidateRef], fields }, '工单详情', TicketDetailClientError,
  )
  if (!isDetailResponse(payload)) {
    throw new TicketDetailClientError('INVALID_RESPONSE', '工单详情服务返回的数据格式无效。', false, status)
  }
  const detail = payload.details.find(item => item.candidateRef === candidateRef)
  if (detail === undefined || payload.rejectedCandidateRefs.length > 0) {
    throw new TicketDetailClientError('UNAUTHORIZED', '当前工单详情不可访问，请重新检索。', false, status)
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
