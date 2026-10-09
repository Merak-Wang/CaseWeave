import { createHash } from 'node:crypto'
import { XlsxWriter } from './xlsx.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeExportCandidatesFailure,
  exportCandidates,
  ExportCandidatesClientError,
} from './download-client.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('candidate export client failures', () => {
  it.each(['result', 'hash'] as const)('requests the complete result and rejects a mismatched %s before saving a file', async mismatch => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      fileName: 'confirmed.csv', mediaType: 'text/csv; charset=utf-8', contentUtf8: 'ticket\r\nINC-1\r\n',
      receipt: { retrievalId: 'retrieval-1', resultRevision: mismatch === 'result' ? 'old-result' : 'result-1',
        rowCount: 1, contentSha256: '0'.repeat(64) },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(exportCandidates('session-1', 'retrieval-1', 'result-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetch).toHaveBeenCalledWith('/api/retrieval-agent/export', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'session-1', retrievalId: 'retrieval-1', resultRevision: 'result-1' }),
    }))
  })

  it('preserves the BFF code, message, retryability, and HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'SNAPSHOT_INVALID',
      message: '检索快照已失效，请重新检索后导出。',
      retryable: false,
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(exportCandidates('session-1', 'retrieval-1', 'result-1'))
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

describe('synchronous XLSX client', () => {
  it('decodes binary bytes, verifies hash/version and saves the requested workbook', async () => {
    vi.useFakeTimers()
    const parts: Uint8Array[] = []
    const writer = await XlsxWriter.create(['ticket'], async part => { parts.push(part) })
    await writer.addRow(['0012345678901234567890']); await writer.finish()
    const bytes = Buffer.concat(parts), sha = createHash('sha256').update(bytes).digest('hex')
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ fileName: 'confirmed.xlsx',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: bytes.toString('base64'),
      receipt: { retrievalId: 'retrieval-1', resultRevision: 'result-1', rowCount: 1, contentSha256: sha } }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const anchor = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } })
    let downloaded: Blob | undefined
    const createObjectURL = vi.fn((blob: Blob) => { downloaded = blob; return 'blob:synthetic-xlsx' })
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    await expect(exportCandidates('session-1', 'retrieval-1', 'result-1', 'xlsx')).resolves.toMatchObject({ rowCount: 1, contentSha256: sha })
    expect(fetch).toHaveBeenCalledWith('/api/retrieval-agent/export', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'session-1', retrievalId: 'retrieval-1', resultRevision: 'result-1', format: 'xlsx' }) }))
    expect(Buffer.from(await downloaded!.arrayBuffer())).toEqual(bytes)
    expect(downloaded!.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(anchor.download).toBe('confirmed.xlsx'); expect(anchor.click).toHaveBeenCalledTimes(1)
    vi.runAllTimers()
  })
  it.each(['base64', 'magic', 'format'] as const)('refuses wrong %s before saving', async mismatch => {
    const payload = mismatch === 'format' ? { mediaType: 'text/csv; charset=utf-8', contentUtf8: 'x' }
      : { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: mismatch === 'base64' ? '@bad' : Buffer.from('not a workbook').toString('base64') }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ fileName: 'confirmed.xlsx', ...payload,
      receipt: { retrievalId: 'retrieval-1', resultRevision: 'result-1', rowCount: 1, contentSha256: '0'.repeat(64) } }), { status: 200 })))
    await expect(exportCandidates('session-1', 'retrieval-1', 'result-1', 'xlsx')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
