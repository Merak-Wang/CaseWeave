import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeExportCandidatesFailure,
  exportCandidates,
  ExportCandidatesClientError,
} from './export.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('candidate export client failures', () => {
  it('preserves the BFF code, message, retryability, and HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'SNAPSHOT_INVALID',
      message: '检索快照已失效，请重新检索后导出。',
      retryable: false,
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(exportCandidates('session-1', 'retrieval-1', []))
      .rejects.toMatchObject({
        name: 'ExportCandidatesClientError',
        code: 'SNAPSHOT_INVALID',
        message: '检索快照已失效，请重新检索后导出。',
        retryable: false,
        status: 409,
      })
  })

  it('turns structured backend failures into a concrete next action', () => {
    expect(describeExportCandidatesFailure(new ExportCandidatesClientError(
      'SESSION_NOT_ACTIVE',
      '会话当前不可用，请重新打开后重试。',
      true,
      409,
    ))).toEqual({
      code: 'SESSION_NOT_ACTIVE',
      message: '会话当前不可用，请重新打开后重试。',
      action: '重新打开该会话后再导出。',
      retryable: true,
    })
  })

  it('does not expose an arbitrary browser exception as user-facing detail', () => {
    expect(describeExportCandidatesFailure(new Error('sensitive browser detail'))).toEqual({
      code: 'CLIENT_UNKNOWN',
      message: '导出请求未完成。',
      action: '确认应用仍在运行，然后重试；若仍失败，请联系管理员。',
      retryable: true,
    })
  })
})
