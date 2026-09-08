import { randomUUID } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { HybridRankingEngine } from '@retrieval-agent/model-service-client/ranking'
import { ModelServiceClient } from '@retrieval-agent/model-service-client'
import { loadModelDependencyManifest } from './model-dependencies.mjs'

const baseUrl = process.argv.find(a => a.startsWith('--base-url='))?.slice(11) ?? 'http://127.0.0.1:8012'
const manifest = (await loadModelDependencyManifest(process.cwd(), process.env)).roles.embedding
const identity = { model: manifest.model, revision: manifest.revision, dimensions: manifest.dimensions }
const traces = []
const ranker = new HybridRankingEngine({ baseUrl, embeddingIdentity: identity, embeddingBatchSize: 4,
  allowKeywordFallback: true, modelDeadlineMs: 120000, fetch: async (url, init) => {
    const body = JSON.parse(init.body), started = performance.now()
    const trace = { requestId: body.requestId, startedAt: new Date().toISOString(), source: String(url) }; traces.push(trace)
    try { const response = await fetch(url, init); trace.status = response.status; return response }
    finally { trace.clientMs = performance.now() - started }
  } })
const id = randomUUID(), abort = new AbortController()
const documents = Array.from({ length: 64 }, (_, i) => ({ id: id + '-' + i, contentHash: id + '-' + i,
  title: '用于检查取消的工单', summary: '副卡解绑后仍共享流量，需要核对绑定关系。'.repeat(4), body: '', metadata: '' }))
const query = { text: '副卡解绑', mode: 'hybrid', semanticHints: [], excludedTerms: [] }
const timer = setTimeout(() => abort.abort(), 750)
let cancelled = false
try { await ranker.rank(documents, query, { maxScan: 64, signal: abort.signal }) }
catch (error) { if (error.code !== 'CANCELLED') throw error; cancelled = true }
finally { clearTimeout(timer) }
if (!cancelled) throw new Error('Cold ranking unexpectedly completed before the cancellation')
// A genuine inference after cancellation detects residual long-running work; health alone is insufficient.
const client = new ModelServiceClient({ baseUrl, embeddingModel: identity.model, embeddingRevision: identity.revision,
  embeddingDimensions: identity.dimensions, defaultDeadlineMs: 30000 })
const started = performance.now()
const result = await client.embed({ texts: ['取消后核验真实推理仍然可用'], inputType: 'query' })
if (result[0]?.length !== identity.dimensions) throw new Error('Inference after cancellation failed')
const report = { scope: 'actual HTTP cancellation and a subsequent actual embedding; server requestId logs establish computation/queue timing',
  passed: true, traces, postCancelInferenceMs: performance.now() - started }
await mkdir('output/github-acceptance', { recursive: true })
await writeFile('output/github-acceptance/ranking-cancellation.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
