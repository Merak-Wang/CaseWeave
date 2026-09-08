import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { HybridRankingEngine } from '../packages/retrieval-ranking/lib/index.js'

const baseUrl = process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012'
const afterRestart = process.argv.includes('--after-restart')
const identity = { model: 'Qwen/Qwen3-Embedding-0.6B', revision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3', dimensions: 1024 }
const documents = ['副卡跨域解绑需要核实原文。', '宽带故障已经恢复。'].map((body, i) => ({ id: `phase7-${i}`,
  contentHash: createHash('sha256').update(body).digest('hex'), title: body, summary: body, body, metadata: '' }))
const ranker = new HybridRankingEngine({ baseUrl, embeddingIdentity: identity, preparePollIntervalMs: 50 })
const progress = []
const prepared = await ranker.prepare(documents, { onProgress: value => progress.push(value) })
assert.equal(prepared.documentCount, 2)
if (afterRestart) assert.equal(progress.at(-1)?.cacheHit, true, 'Restart must reuse the persistent vectors')
const payload = { protocolVersion: 'retrieval-agent.models.v1', model: identity.model, inputType: 'document', normalize: true, dimensions: 1024 }
const abort = new AbortController()
const interrupted = fetch(baseUrl + '/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' },
  signal: abort.signal, body: JSON.stringify({ ...payload, requestId: randomUUID(), input: Array(16).fill('跨域主副卡解绑核验'.repeat(200)) }) })
const timer = setTimeout(() => abort.abort(), 50)
const aborted = await interrupted.then(response => ({ status: response.status }), error => ({ error: error.name }))
clearTimeout(timer)
assert.equal(aborted.error, 'AbortError')
const response = await fetch(baseUrl + '/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' },
  signal: AbortSignal.timeout(30_000), body: JSON.stringify({ ...payload, requestId: randomUUID(), inputType: 'query', input: ['副卡解绑'] }) })
const recovered = await response.json()
assert.equal(response.status, 200)
assert.equal(recovered.data[0].embedding.length, 1024)
await mkdir('output/phase7', { recursive: true })
const result = { at: new Date().toISOString(), baseUrl, afterRestart, prepared, progress, aborted,
  subsequentRequest: { status: response.status, elapsedMs: recovered.elapsedMs, timings: recovered.timings } }
await writeFile(`output/phase7/lifecycle-${afterRestart ? 'after' : 'before'}.json`, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
