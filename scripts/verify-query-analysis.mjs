import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { SpacyQueryAnalyzer, buildFastTicketRequest } from '@retrieval-agent/query-understanding'

// Explicit real-service acceptance; uses the configured local NLP model, no LLM key.
const baseUrl = process.argv[2] ?? process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012'
const analyzer = new SpacyQueryAnalyzer({ baseUrl, deadlineMs: 20000 })
const reports = []
for (const query of ['🔎帮我找北京的副卡和跨域有关工单', '查找用户不在北京时副卡办理失败的工单',
  '只看上海的副卡工单', '查找用户不在北京时副卡办理失败的工单，只看北京的工单']) {
  const analysis = await analyzer.analyze(query)
  for (const field of ['tokens', 'entities', 'candidates']) {
    for (const span of analysis[field]) assert.equal(query.slice(span.start, span.end), span.text)
  }
  const request = await buildFastTicketRequest(query, { analyzer })
  assert.equal(request.fastQuery.vector.text, query)
  if (query.includes('用户不在') && !query.includes('只看')) assert.equal(request.filters.some(filter => filter.field === 'region'), false)
  const region = query.includes('只看北京') || query.startsWith('🔎') ? '北京' : query.includes('只看上海') ? '上海' : undefined
  if (region) assert.deepEqual(request.filters.filter(filter => filter.field === 'region'), [{ field: 'region', op: 'eq', value: region }])
  reports.push({ query, spans: Object.fromEntries(['tokens', 'entities', 'candidates'].map(field => [field, analysis[field].length])),
    entities: analysis.entities, filters: request.filters, analyzer: analysis.analyzer, passed: true })
}
await mkdir('output/query-analysis', { recursive: true })
await writeFile('output/query-analysis/acceptance.json', JSON.stringify({ baseUrl, reports }, null, 2) + '\n')
console.log(`Real query-analysis HTTP acceptance passed: ${reports.length} queries. Evidence: output/query-analysis/acceptance.json`)
