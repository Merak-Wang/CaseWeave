import { ProductApiClientError, isRecord, postProductApi } from './http-client.js'
import type { CandidateExportReceipt } from '@retrieval-agent/contracts'
import {
  EXPORT_CANDIDATES_ENDPOINT,
  type ExportCandidatesResponse,
} from './protocol.js'

export class ExportCandidatesClientError extends ProductApiClientError {}

export interface ExportCandidatesFailure {
  readonly code: string
  readonly message: string
  readonly action: string
  readonly retryable: boolean
}

function isExportResponse(value: unknown): value is ExportCandidatesResponse {
  return isRecord(value)
    && typeof value.fileName === 'string'
    && value.mediaType === 'text/csv; charset=utf-8'
    && typeof value.contentUtf8 === 'string'
    && isRecord(value.receipt)
}

function suggestedAction(code: string, retryable: boolean): string {
  switch (code) {
    case 'SESSION_NOT_ACTIVE': return '重新打开该会话后再导出。'
    case 'SNAPSHOT_INVALID':
    case 'SNAPSHOT_NOT_FOUND': return '重新执行检索，使用新快照中的候选再导出。'
    case 'INVALID_TRANSITION': return '确认结果已更新，请刷新结果后重新下载。'
    case 'CANDIDATE_NOT_FOUND': return '请等待 Agent 确认工单后再下载。'
    case 'UNAUTHORIZED': return '刷新会话权限；若仍失败，请联系数据管理员。'
    case 'EXPORT_LIMIT_EXCEEDED': return '减少本次候选数量后重试。'
    case 'ORIGIN_REJECTED': return '请只从当前 DSH 页面发起导出。'
    case 'PROVIDER_UNAVAILABLE': return '确认工单数据服务已就绪，重新打开会话后重试。'
    case 'TIMEOUT': return '服务响应超时，请稍后重试。'
    case 'NETWORK_UNAVAILABLE': return '确认应用仍在运行且网络可达，然后重试。'
    case 'INVALID_RESPONSE': return '请重启应用；若仍失败，请向开发人员提供该错误码。'
    default: return retryable ? '请稍后重试。' : '请向管理员提供错误码以便排查。'
  }
}

/** Convert a structured BFF failure into safe, visible, and actionable UI copy. */
export function describeExportCandidatesFailure(error: unknown): ExportCandidatesFailure {
  if (error instanceof ExportCandidatesClientError) {
    return {
      code: error.code,
      message: error.message,
      action: suggestedAction(error.code, error.retryable),
      retryable: error.retryable,
    }
  }
  return {
    code: 'CLIENT_UNKNOWN',
    message: '导出请求未完成。',
    action: '确认应用仍在运行，然后重试；若仍失败，请联系管理员。',
    retryable: true,
  }
}

export async function exportCandidates(
  sessionId: string,
  retrievalId: string,
  resultRevision: string,
): Promise<CandidateExportReceipt> {
  const { payload, status } = await postProductApi<ExportCandidatesResponse>(
    EXPORT_CANDIDATES_ENDPOINT, { sessionId, retrievalId, resultRevision }, '导出', ExportCandidatesClientError,
  )
  if (!isExportResponse(payload) || payload.receipt.retrievalId !== retrievalId
    || payload.receipt.resultRevision !== resultRevision || !Number.isSafeInteger(payload.receipt.rowCount)
    || payload.receipt.rowCount < 1 || !/^[a-f0-9]{64}$/u.test(payload.receipt.contentSha256)) {
    throw new ExportCandidatesClientError(
      'INVALID_RESPONSE',
      '导出服务返回的数据格式无效。',
      false,
      status,
    )
  }
  const bytes = new TextEncoder().encode(payload.contentUtf8)
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
  if (hash !== payload.receipt.contentSha256) {
    throw new ExportCandidatesClientError('INVALID_RESPONSE', '下载文件校验失败，请重试。', true)
  }
  const blob = new Blob([bytes], { type: payload.mediaType })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = payload.fileName
    anchor.rel = 'noopener'
    document.body.append(anchor); anchor.click(); anchor.remove()
  } finally {
    setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  }
  return payload.receipt
}
