import type { TicketCandidateRef } from '@retrieval-agent/contracts'
import {
  EXPORT_CANDIDATES_ENDPOINT,
  type ExportCandidatesErrorResponse,
  type ExportCandidatesResponse,
} from '@retrieval-agent/product-api/protocol'

export class ExportCandidatesClientError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    status?: number,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ExportCandidatesClientError'
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

export interface ExportCandidatesFailure {
  readonly code: string
  readonly message: string
  readonly action: string
  readonly retryable: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isExportError(value: unknown): value is ExportCandidatesErrorResponse {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && typeof value.retryable === 'boolean'
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
  refs: readonly TicketCandidateRef[],
): Promise<void> {
  let response: Response
  try {
    response = await fetch(EXPORT_CANDIDATES_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, retrievalId, candidateRefs: refs }),
    })
  } catch (cause) {
    throw new ExportCandidatesClientError(
      'NETWORK_UNAVAILABLE',
      '无法连接导出服务。',
      true,
      undefined,
      { cause },
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new ExportCandidatesClientError(
      'INVALID_RESPONSE',
      `导出服务返回了无法解析的响应（HTTP ${response.status}）。`,
      response.status >= 500,
      response.status,
      { cause },
    )
  }
  if (!response.ok) {
    if (isExportError(payload)) {
      throw new ExportCandidatesClientError(payload.code, payload.message, payload.retryable, response.status)
    }
    throw new ExportCandidatesClientError(
      `HTTP_${response.status}`,
      `导出请求失败（HTTP ${response.status}）。`,
      response.status >= 500,
      response.status,
    )
  }
  if (!isExportResponse(payload)) {
    throw new ExportCandidatesClientError(
      'INVALID_RESPONSE',
      '导出服务返回的数据格式无效。',
      false,
      response.status,
    )
  }
  const blob = new Blob([payload.contentUtf8], { type: payload.mediaType })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = payload.fileName
    anchor.rel = 'noopener'
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
