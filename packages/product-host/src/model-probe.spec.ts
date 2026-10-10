import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createServer, type RequestListener } from 'node:http'
import { WorkbenchModels, installWorkbenchModels } from './models.js'

function harness(stream: (...args: any[]) => AsyncGenerator<any>) {
  let selected = { provider: 'production-qwen', model: 'Qwen3.5-27b' }
  const save = vi.fn(async (next: typeof selected) => { selected = next })
  const call = vi.fn(stream)
  const ctx = {
    settings: { describe: () => [{ ns: 'retrieval-llm-pi-ai', revision: 1, value: { providers: {
      'production-qwen': { models: [{ id: 'Qwen3.5-27b' }] },
      'production-flash': { models: [{ id: 'deepseek-v4.1-flash' }] },
    } } }] },
    credentials: { describe: async () => ({ configured: true }) },
    agentDefaultModel: { currentSelection: () => selected, saveSelection: save },
    llm: { stream: call, listModels: async (p: string) => [{ id: p === 'production-qwen' ? 'Qwen3.5-27b' : 'deepseek-v4.1-flash' }],
      resolveModelInfo: async () => ({}), listConfigurableProviders: () => [] },
  } as unknown as Context
  return { models: new WorkbenchModels(ctx), save, call }
}
const select = { action: 'select', provider: 'production-flash', model: 'deepseek-v4.1-flash' }
it('lists without inference and persists only after one normal short inference receipt', async () => {
  const h = harness(async function* () { yield { type: 'finish', reason: { kind: 'max-tokens' } } })
  await h.models.view(); expect(h.call).not.toHaveBeenCalled()
  const result = await h.models.update(select)
  expect(h.call).toHaveBeenCalledTimes(1)
  expect(h.call.mock.calls[0]![0]).toMatchObject({ maxTokens: 16, temperature: 0, system: 'Reply only OK.' })
  expect(h.call.mock.calls[0]![0].sessionId).toMatch(/^model-probe-/)
  expect(h.save).toHaveBeenCalledTimes(1)
  expect(('probe' in result ? result.probe : undefined)?.finish).toBe('max-tokens')
})
it('preserves previous selection and reports safe native auth code/status', async () => {
  const h = harness(async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', status: 401, message: 'secret upstream details' } } } })
  await expect(h.models.update(select)).rejects.toThrow(/INVALID_CREDENTIAL.*401/)
  expect(h.save).not.toHaveBeenCalled()
  expect((await h.models.view()).selected?.provider).toBe('production-qwen')
})
it('passes cancellation to the active inference without changing selection', async () => {
  const h = harness(async function* (request) {
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
    request.signal.throwIfAborted()
  })
  const cancel = new AbortController()
  const pending = h.models.update(select, undefined, cancel.signal)
  await vi.waitFor(() => expect(h.call).toHaveBeenCalledTimes(1))
  cancel.abort()
  await expect(pending).rejects.toThrow(/CANCELLED/)
  expect(h.save).not.toHaveBeenCalled()
})
it('reports timeout separately and leaves the previous selection', async () => {
  const timeout = new AbortController()
  const factory = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
  const h = harness(async function* (request) {
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
    request.signal.throwIfAborted()
  })
  try {
    const pending = h.models.update(select)
    await vi.waitFor(() => expect(h.call).toHaveBeenCalledTimes(1))
    timeout.abort()
    await expect(pending).rejects.toThrow(/TIMEOUT/)
    expect(h.save).not.toHaveBeenCalled()
  } finally { factory.mockRestore() }
})
it('does not accept an unexpected tool finish as a successful connection receipt', async () => {
  const h = harness(async function* () { yield { type: 'finish', reason: { kind: 'tool-calls' } } })
  await expect(h.models.update(select)).rejects.toThrow(/UNEXPECTED_FINISH/)
  expect(h.save).not.toHaveBeenCalled()
})

it('public HTTP cancellation aborts the inference after the complete POST body', async () => {
  const h = harness(async function* (request) {
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
    request.signal.throwIfAborted()
  })
  let handler: RequestListener | undefined
  installWorkbenchModels({ effect: (effect: () => void) => effect(), webServer: { register: (route: { handler: RequestListener }) => { handler = route.handler } } } as unknown as Context, h.models, async () => { throw new Error('no task') })
  const server = createServer((req, res) => { void handler!(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const cancel = new AbortController()
  try {
    const pending = fetch(`http://127.0.0.1:${address.port}/api/retrieval-agent/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(select), signal: cancel.signal })
    await vi.waitFor(() => expect(h.call).toHaveBeenCalledTimes(1))
    expect(h.call.mock.calls[0]![0].signal.aborted).toBe(false)
    cancel.abort()
    await expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(h.call.mock.calls[0]![0].signal.aborted).toBe(true))
    expect(h.save).not.toHaveBeenCalled()
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
