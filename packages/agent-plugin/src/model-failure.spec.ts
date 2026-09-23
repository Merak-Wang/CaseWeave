import { expect, it } from 'vitest'
import { modelFailure } from './model-failure.js'

it.each(['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'OUTPUT_SCHEMA'])('retries transient %s only inside an operator request', code => {
  expect(modelFailure({ code }, true).retryable).toBe(true)
  expect(modelFailure({ code }).retryable).toBe(false)
})

it.each([
  { code: 'AUTH', status: 401 }, { code: 'MODEL_NOT_FOUND', status: 404 },
  { code: 'QUOTA_EXCEEDED', status: 429 }, { code: 'INVALID_REQUEST', status: 400 },
  { code: 'CONTEXT_WINDOW_EXCEEDED' }, { code: 'CANCELLED' }, { code: 'MODEL_FAILURE' },
])('does not retry permanent failure $code', failure => {
  expect(modelFailure(failure, true).retryable).toBe(false)
})

it('keeps structured transport diagnostics and failed usage without exposing the provider body', () => {
  const usage = { prompt_tokens: 25, completion_tokens: 3 }
  const error = modelFailure({ code: 'TRANSPORT', message: 'fetch failed: ECONNRESET private-response secret-key', providerRetryAfterMs: 1500 }, true, usage)
  expect(error).toMatchObject({ retryable: true, cause: {
    modelFailure: { code: 'TRANSPORT', diagnostic: 'ECONNRESET', retryAfterMs: 1500 }, usage,
  } })
  expect(error.publicMessage).toContain('连接')
  expect(JSON.stringify(error)).not.toContain('private-response')
  expect(JSON.stringify(error)).not.toContain('secret-key')
})

it('explains malformed structured model output accurately', () => {
  const error = modelFailure({ code: 'OUTPUT_SCHEMA' }, true)
  expect(error.retryable).toBe(true)
  expect(error.publicMessage).toContain('结构化结果缺少必填字段或格式不符合要求')
})
