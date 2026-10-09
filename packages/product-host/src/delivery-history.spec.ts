import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleDeliveryHistory } from './delivery-history.js'

const read = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', () => ({ readFile: read }))

describe('original deliveries', () => {
  it('returns unchanged original bytes and revision without creating a task', async () => {
    const bytes = Buffer.from('original workbook bytes')
    const manifest = { entries: [{ id: 'task-one', query: '<script>', model: 'Qwen', source_provider: 'local-dataset-v1', result_revision: 'original-revision', positive_count: 7, files: [{ kind: 'xlsx', format: 'xlsx', path: 'source/original.xlsx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }] }
    read.mockImplementation(async (path: string) => path.endsWith('manifest.json') ? JSON.stringify(manifest) : bytes)
    const setHeader = vi.fn(); const end = vi.fn(); const writeHead = vi.fn()
    const response = { setHeader, end, writeHead } as unknown as ServerResponse
    await handleDeliveryHistory('/deliveries', { method: 'GET', url: '/api/retrieval-agent/deliveries/task-one/xlsx' } as IncomingMessage, response)
    expect(end).toHaveBeenCalledWith(bytes)
    expect(setHeader).toHaveBeenCalledWith('x-result-revision', 'original-revision')
    await handleDeliveryHistory('/deliveries', { method: 'GET', url: '/retrieval/deliveries' } as IncomingMessage, response)
    expect(end.mock.lastCall?.[0]).toContain('&lt;script&gt;')
    expect(end.mock.lastCall?.[0]).toContain('不可续跑')
    await handleDeliveryHistory('/deliveries', { method: 'POST', url: '/api/retrieval-agent/deliveries/task-one/xlsx' } as IncomingMessage, response)
    expect(writeHead).toHaveBeenLastCalledWith(405, { allow: 'GET' })
  })

  it('refuses a changed file instead of serving a false original', async () => {
    read.mockImplementation(async (path: string) => path.endsWith('manifest.json') ? JSON.stringify({ entries: [{ id: 'one', files: [{ kind: 'report', path: 'report.json', sha256: 'wrong', bytes: 1 }] }] }) : Buffer.from('changed'))
    const writeHead = vi.fn(); const response = { setHeader: vi.fn(), end: vi.fn(), writeHead } as unknown as ServerResponse
    await handleDeliveryHistory('/deliveries', { method: 'GET', url: '/api/retrieval-agent/deliveries/one/report' } as IncomingMessage, response)
    expect(writeHead).toHaveBeenCalledWith(503)
  })
})
