import { randomUUID } from 'node:crypto'
import { MODEL_SERVICE_PROTOCOL_VERSION } from '@retrieval-agent/model-service-client'

const baseUrlArgument = process.argv.find(argument => argument.startsWith('--base-url='))
const baseUrl = baseUrlArgument?.slice('--base-url='.length) ?? process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012'

async function json(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json()
  return { status: response.status, body }
}

const live = await json('/health/live')
const ready = await json('/health/ready')
if (live.status !== 200 || live.body.live !== true || ready.status !== 200 || ready.body.ready !== true) {
  throw new Error('model service is not ready')
}

const protocolMismatch = await json('/v1/embeddings', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ protocolVersion: 'old-protocol', requestId: 'bad-protocol' }),
})
if (protocolMismatch.status !== 409 || protocolMismatch.body.error?.code !== 'PROTOCOL_MISMATCH') {
  throw new Error('model service did not reject protocol drift')
}

const duplicateRerank = await json('/v1/rerank', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
    requestId: 'duplicate-rerank',
    model: 'Qwen/Qwen3-Reranker-0.6B',
    query: 'query', instruction: 'judge', topK: 1,
    candidates: [{ id: 'same', text: 'one' }, { id: 'same', text: 'two' }],
  }),
})
if (duplicateRerank.status !== 400 || duplicateRerank.body.error?.code !== 'INVALID_REQUEST') {
  throw new Error('model service did not reject duplicate rerank candidates')
}

const syntheticRow = '主副卡计费关系状态异常需要刷新'.repeat(50)
const concurrent = await Promise.all(Array.from({ length: 6 }, async () => json('/v1/embeddings', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
    requestId: randomUUID(),
    model: 'Qwen/Qwen3-Embedding-0.6B',
    input: Array.from({ length: 16 }, () => syntheticRow),
    inputType: 'document', dimensions: 1024, normalize: true,
  }),
})))
const statuses = concurrent.map(result => result.status)
if (!statuses.includes(200) || !statuses.includes(429)
  || concurrent.filter(result => result.status === 429).some(result => result.body.error?.code !== 'BACKPRESSURE')) {
  throw new Error(`expected both successful inference and structured backpressure, received ${statuses.join(',')}`)
}

console.log(JSON.stringify({
  protocolVersion: ready.body.protocolVersion,
  device: ready.body.device,
  dtype: ready.body.models.map(model => ({ kind: model.kind, dtype: model.dtype })),
  checks: {
    live: live.status,
    ready: ready.status,
    protocolMismatch: protocolMismatch.status,
    duplicateRerank: duplicateRerank.status,
    concurrentEmbeddingStatuses: statuses,
  },
}, undefined, 2))
