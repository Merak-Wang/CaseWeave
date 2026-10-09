import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { readLabelLogprobs } from './label-logprobs.js'

afterEach(() => vi.unstubAllGlobals())
const context = { get(name: string) { return name === 'settings'
  ? { describe: () => [{ ns: 'retrieval-llm-pi-ai', value: { providers: { fixture: { baseURL: 'https://synthetic.invalid/v1', api: 'openai-completions', apiKeyEnv: 'FIXTURE' } } } }] }
  : { resolve: async () => ({ value: 'synthetic-secret' }) } } } as unknown as Context

it('reads provider-owned label distribution and keeps credentials outside the returned receipt', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    expect(init.headers.Authorization).toBe('Bearer synthetic-secret')
    expect(JSON.parse(init.body).max_tokens).toBe(1)
    return new Response(JSON.stringify({ model: 'fixture-model', usage: { prompt_tokens: 5, completion_tokens: 1 }, choices: [{
      message: { content: 'Y' }, logprobs: { content: [{ token: 'Y', logprob: -.2,
        top_logprobs: [{ token: 'Y', logprob: -.2 }, { token: 'N', logprob: -2.2 }, { token: 'irrelevant', logprob: -9999 }] }] } }] }))
  }))
  const result = await readLabelLogprobs(context, 'fixture', 'fixture-model', [{ role: 'user', content: 'synthetic' }], 'fixture-id')
  expect(result.payload.available).toBe(true)
  expect(result.payload.p_first).toBeCloseTo(1/(1+Math.exp(-2)))
  expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  expect(result.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 1 })
})

it('keeps missing capabilities explicit and never invents confidence', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ model: 'fixture-model', choices: [{ message: { content: 'Y' } }] }))))
  const result = await readLabelLogprobs(context, 'fixture', 'fixture-model', [], 'fixture-id')
  expect(result.payload).toMatchObject({ available: false, p_first: null, unavailable_reason: 'answer_logprobs_unavailable' })
})
