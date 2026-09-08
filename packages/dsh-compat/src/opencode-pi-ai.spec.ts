import { createServer, type IncomingHttpHeaders } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import * as compatibility from './opencode-pi-ai.js'

const first = '54bf3cc0-5dd1-48b5-8f85-31cfb4d5f5ad'
const second = 'b7f2f700-0223-4dc5-920b-30ab0decc9d0'
const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })]
async function drain(stream: AsyncIterable<StreamChunk>) { const chunks = []; for await (const c of stream) chunks.push(c); return chunks }

describe('pinned pi-ai OpenCode session routing', () => {
  it('recognizes aliases by exact host and maps non-UUID session identities deterministically', async () => {
    expect(compatibility.isOpenCodeRoute('custom-go', 'https://opencode.ai/zen/go/v1')).toBe(true)
    expect(compatibility.isOpenCodeRoute('custom', 'https://opencode.ai.invalid/v1')).toBe(false)
    expect(compatibility.isOpenCodeRoute('custom', 'not-a-url')).toBe(false)
    const id = compatibility.openCodeSessionId('legacy conversation')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(compatibility.openCodeSessionId('legacy conversation')).toBe(id)
    expect(compatibility.openCodeSessionId('legacy conversation child')).not.toBe(id)
  })
  it('sends distinct stable conversation UUIDs on the actual HTTP wire, including prepared calls and compaction', async () => {
    const headers: IncomingHttpHeaders[] = []
    const server = createServer((req, res) => {
      req.resume(); req.once('end', () => {
        headers.push(req.headers)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(['{"choices":[{"delta":{"role":"assistant","content":"ok"},"index":0,"finish_reason":null}]}',
          '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}', '[DONE]'].map(e => `data: ${e}\n\n`).join(''))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    vi.stubEnv('OPENCODE_HEADER_TEST_KEY', 'fixture-key')
    const mount = async () => {
      const ctx = new Context(); await ctx.plugin(LlmRuntime)
      await ctx.plugin(compatibility, { providers: {
        'opencode-fixture': { api: 'openai-completions', baseURL, apiKeyEnv: 'OPENCODE_HEADER_TEST_KEY',
          headers: { 'X-OpenCode-Session': 'shared-invalid-id', 'x-deployment': 'kept' },
          models: [{ id: 'fixture', contextWindow: 4096, maxTokens: 64 }] },
        'unrelated-fixture': { api: 'openai-completions', baseURL, apiKeyEnv: 'OPENCODE_HEADER_TEST_KEY',
          models: [{ id: 'fixture', contextWindow: 4096, maxTokens: 64 }] },
      } })
      return ctx
    }
    let ctx: Context | undefined
    try {
      ctx = await mount()
      const request = (id: string): GenerateOptions => ({ provider: 'opencode-fixture', model: 'fixture', sessionId: SessionId(id), messages })
      await Promise.all([drain(ctx.llm.stream(request(`session-${first}`))), drain(ctx.llm.stream(request(second)))])
      expect(new Set(headers.slice(0, 2).map(h => h['x-opencode-session']))).toEqual(new Set([first, second]))
      const prepared = await ctx.llm.prepareCall({ provider: 'opencode-fixture', model: 'fixture' })
      await drain(prepared.stream({ ...request(`session-${first}`), ...prepared.config, purpose: 'compaction' }))
      expect(headers.at(-1)?.['x-opencode-session']).toBe(first)
      const sent = headers.length
      expect(await drain(ctx.llm.stream({ provider: 'opencode-fixture', model: 'fixture', messages }))).toContainEqual({
        type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'OpenCode inference requires a conversation sessionId.' } },
      })
      expect(headers).toHaveLength(sent)
      await drain(ctx.llm.stream({ ...request(second), provider: 'unrelated-fixture' }))
      expect(headers.at(-1)?.['x-opencode-session']).toBeUndefined()
      await ctx.fiber.dispose(); ctx = await mount()
      await drain(ctx.llm.stream(request(`session-${first}`)))
      expect(headers.at(-1)?.['x-opencode-session']).toBe(first)
      expect(headers.at(-1)?.['x-deployment']).toBe('kept')
      expect(headers.at(-1)?.['authorization']).toBe('Bearer fixture-key')
    } finally {
      await ctx?.fiber.dispose(); vi.unstubAllEnvs(); server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
    }
  })
})
