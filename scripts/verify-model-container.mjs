// Real inference and existing SQL/Milvus publication comparison. Never imports or reindexes data.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { TicketDatabase, DatabaseTicketProvider, MilvusClient } from '../packages/provider-database/lib/index.js'
import { ModelServiceClient } from '../packages/model-service-client/lib/index.js'
import { buildFastTicketRequest, SpacyQueryAnalyzer } from '../packages/query-understanding/lib/index.js'
import { RetrievalController, InMemoryRetrievalEventJournal } from '../packages/domain/lib/index.js'

const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const at = value.indexOf('='); if (at < 0) throw new Error('Use --url=URL --out=FILE [--baseline=FILE] [--device=cpu|cuda:0]')
  return [value.slice(2, at), value.slice(at + 1)]
}))
const baseUrl = options.url ?? 'http://127.0.0.1:8012'
const out = options.out ?? 'output/phase7/host.json'
const manifestBytes = await readFile('architecture/model-manifest.json')
const manifest = JSON.parse(manifestBytes)
const embedding = manifest.dependencies[manifest.embedding.dependency].source
const query = '帮我找副卡和跨域有关工单'
const texts = [query, '副卡在跨域业务办理时失败，返回不支持异地共享。', '宽带欠费导致无法上网。', '主卡与副卡归属省份不同，跨域绑定失败。']
async function request(path, body) {
  const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(120_000), ...(body ? {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 'retrieval-agent.models.v1', requestId: randomUUID(), ...body }),
  } : {}) })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}
const report = { at: new Date().toISOString(), baseUrl, query,
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  lexiconSha256: createHash('sha256').update(await readFile('config/query-domain-lexicon.json')).digest('hex'),
  tolerances: { minimumCosine: 0.999, maximumAbsoluteDifference: 0.005, minimumCandidateJaccard: 0.9 },
  health: await request('/health/ready'), analysis: await request('/v1/query-analysis', { query }) }
if (options.device) assert.equal(report.health.device, options.device)
report.embedding = await request('/v1/embeddings', { model: embedding.repoId, input: texts,
  inputType: 'document', normalize: true, dimensions: manifest.embedding.dimensions })
report.queryEmbedding = await request('/v1/embeddings', { model: embedding.repoId, input: [query],
  inputType: 'query', instruction: manifest.embedding.queryInstruction, normalize: true, dimensions: manifest.embedding.dimensions })
const db = new TicketDatabase(process.env.RETRIEVAL_AGENT_MYSQL_URL)
try {
  const dataset = process.env.RETRIEVAL_AGENT_DATASET_ID ?? 'esft-development'
  const publication = await db.publication(dataset)
  assert.ok(publication.index, 'Existing publication must have a real vector index')
  report.publication = { source: publication.source.id, index: publication.index.id, records: publication.source.record_count,
    chunks: publication.index.completed_chunks, identity: publication.index.identity_json }
  const model = new ModelServiceClient({ baseUrl, embeddingModel: embedding.repoId, embeddingRevision: embedding.revision,
    embeddingDimensions: manifest.embedding.dimensions, defaultDeadlineMs: 120_000 })
  const controller = new RetrievalController(new DatabaseTicketProvider(db, new MilvusClient(), model, dataset, 15),
    new InMemoryRetrievalEventJournal(), undefined, { searchTopK: 100 })
  const principal = { tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1', purpose: 'ticket_retrieval',
    attributes: { group: ['admin'], region: ['cn'], role: ['administrator'], environment: ['development'] }, issuedAt: new Date().toISOString() }
  const start = performance.now()
  let state = await controller.start(principal, await buildFastTicketRequest(query, { analyzer: new SpacyQueryAnalyzer({ baseUrl }) }))
  while (state.lastPage?.nextCursor) state = await controller.continueRanking(principal, state)
  assert.ok(state.searchProgress.channels.every(c => c.status === 'completed'))
  report.fastSearch = { elapsedMs: performance.now() - start, channels: state.searchProgress.channels,
    ids: state.candidates.map(c => c.displayId).sort(), timings: state.searchProgress.timings }
  if (options.baseline) {
    const baseline = JSON.parse(await readFile(options.baseline, 'utf8'))
    assert.deepEqual(report.publication, baseline.publication, 'Published index/source identity changed')
    assert.equal(report.lexiconSha256, baseline.lexiconSha256)
    const semanticAnalysis = ({ requestId, elapsedMs, ...value }) => value
    assert.deepEqual(semanticAnalysis(report.analysis), semanticAnalysis(baseline.analysis))
    const vectors = [...report.embedding.data, ...report.queryEmbedding.data]
    const previous = [...baseline.embedding.data, ...baseline.queryEmbedding.data]
    report.comparison = { vectors: vectors.map((row, i) => {
      const a = row.embedding; const b = previous[i].embedding
      assert.equal(a.length, 1024); assert.equal(a.length, b.length)
      const cosine = a.reduce((sum, v, j) => sum + v * b[j], 0) / Math.hypot(...a) / Math.hypot(...b)
      const maximumAbsoluteDifference = Math.max(...a.map((v, j) => Math.abs(v - b[j])))
      assert.ok(cosine >= report.tolerances.minimumCosine, `Embedding cosine ${cosine}`)
      assert.ok(maximumAbsoluteDifference <= report.tolerances.maximumAbsoluteDifference, `Embedding difference ${maximumAbsoluteDifference}`)
      return { cosine, maximumAbsoluteDifference }
    }) }
    const intersection = report.fastSearch.ids.filter(id => baseline.fastSearch.ids.includes(id))
    const union = new Set([...report.fastSearch.ids, ...baseline.fastSearch.ids])
    report.comparison.candidateJaccard = intersection.length / union.size
    report.comparison.added = report.fastSearch.ids.filter(id => !baseline.fastSearch.ids.includes(id))
    report.comparison.removed = baseline.fastSearch.ids.filter(id => !report.fastSearch.ids.includes(id))
    assert.ok(report.comparison.candidateJaccard >= report.tolerances.minimumCandidateJaccard)
    assert.equal(report.fastSearch.channels.find(c => c.channel === 'keyword').count, baseline.fastSearch.channels.find(c => c.channel === 'keyword').count)
  }
} finally {
  await db.close()
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ out, device: report.health.device, publication: report.publication,
  candidates: report.fastSearch.ids.length, elapsedMs: report.fastSearch.elapsedMs, comparison: report.comparison }, null, 2))
