import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TicketDatabase, MilvusClient, buildIndex, queryDocument, fieldCapabilities } from '../packages/provider-database/lib/index.js'
import { parseTicketDatasetJsonl } from '../packages/provider-local/lib/index.js'
import { ModelServiceClient } from '../packages/model-service-client/lib/index.js'
import { compileQueryPlan } from '../packages/query-understanding/lib/index.js'
import { evaluateQuery } from '../packages/contracts/lib/index.js'

const command = process.argv[2]
const options = Object.fromEntries(process.argv.slice(3).map(value => { const at = value.indexOf('='); return [value.slice(0, at).replace(/^--/, ''), value.slice(at + 1)] }))
const db = new TicketDatabase(process.env.RETRIEVAL_AGENT_MYSQL_URL)
const milvus = new MilvusClient(process.env.RETRIEVAL_AGENT_MILVUS_URL, process.env.RETRIEVAL_AGENT_MILVUS_TOKEN)
const identity = { model: 'Qwen/Qwen3-Embedding-0.6B', revision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3', dimensions: 1024, normalization: 'l2', metric: 'COSINE', chunkChars: 360, chunkVersion: 'field-codepoints-v3' }
const model = new ModelServiceClient({ baseUrl: process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012', embeddingModel: identity.model, embeddingRevision: identity.revision, embeddingDimensions: identity.dimensions, defaultDeadlineMs: 120_000 })
const dataset = options.dataset ?? 'esft-development'
const report = { command, dataset, startedAt: new Date().toISOString() }
let lastProgress = 0
const progress = (completed, total) => { if (Date.now() - lastProgress > 10_000 || completed === total) { console.log(JSON.stringify({ completed, total, at: new Date().toISOString() })); lastProgress = Date.now() } }
try {
  await db.migrate()
  if (command === 'import' || command === 'prepare') {
    const path = resolve(options.path ?? 'data/tickets/esft/summary-train.jsonl')
    const records = parseTicketDatasetJsonl(await readFile(path, 'utf8'))
    const started = performance.now()
    report.generation = await db.importRecords(dataset, records, options.watermark ?? records[0].sourceVersion, n => progress(n, records.length))
    report.records = records.length; report.importMs = performance.now() - started
    if (command === 'prepare') {
      report.index = await buildIndex(db, milvus, model, report.generation, identity, { onProgress: progress })
      await db.publish(dataset, report.generation, report.index)
    } else {
      const previous = (await db.rows('SELECT generation,index_id FROM ra_publication WHERE dataset_id=?', [dataset]))[0]
      // Re-importing an already published source must not discard its ready vector generation.
      if (previous?.generation !== report.generation) await db.publish(dataset, report.generation)
      else report.index = previous.index_id ?? undefined
    }
  } else if (command === 'index') {
    const publication = await db.publication(dataset)
    report.generation = publication.source.id
    report.index = await buildIndex(db, milvus, model, report.generation, identity, { onProgress: progress })
    await db.publish(dataset, report.generation, report.index)
  } else if (command === 'publish' || command === 'rollback') {
    if (!options.generation) throw new Error('--generation is required')
    await db.publish(dataset, options.generation, options.index)
    report.generation = options.generation; report.index = options.index
  } else if (command === 'grams') {
    const { source } = await db.publication(dataset)
    // A published source generation is immutable. Repeated setup can reuse its
    // completed keyword index instead of recomputing every gram for minutes.
    report.reused = Boolean(source.grams_ready)
    if (!source.grams_ready) await db.buildGrams(source.id, n => progress(n, source.record_count))
    report.generation = source.id
  } else if (command === 'verify') {
    const { source, index } = await db.publication(dataset)
    const records = await db.records(source.id)
    const cases = [ ['副卡 AND 跨域', ['副卡', '跨域']], ['宽带', ['宽带']], ['副卡 AND NOT 测试单', ['副卡', '测试单']], ['(副卡 AND 跨域) OR 宽带', ['副卡', '跨域', '宽带']], ['“100%”', []], ['“_”', []], ['“ＡＢＣ”', []] ]
    report.generation = source.id; report.index = index?.id; report.cases = []
    for (const [query, terms] of cases) {
      const plan = compileQueryPlan(query, terms, { fields: fieldCapabilities(records) })
      const expected = records.filter(r => evaluateQuery(plan.keyword, queryDocument(r)) === true).map(r => r.ticketId).sort()
      for (const accelerate of source.grams_ready ? [false, true] : [false]) {
        const actual = []; const started = performance.now(); let firstBatchMs
        for await (const page of db.enumerate(source.id, plan.keyword, source.fields_json, { accelerate })) { firstBatchMs ??= performance.now() - started; actual.push(...page.records.map(r => r.ticketId)) }
        const missing = expected.filter(id => !actual.includes(id)); const extra = actual.filter(id => !expected.includes(id))
        report.cases.push({ query, accelerate, expected: expected.length, actual: actual.length, missing, extra, firstBatchMs, elapsedMs: performance.now() - started })
        if (missing.length || extra.length) throw new Error(`SQL/file mismatch: ${query}`)
      }
    }
  } else if (command === 'status') report.publication = await db.publication(dataset)
  else throw new Error('Usage: database.mjs import|prepare|index|publish|rollback|grams|verify|status [--dataset=name] [--path=file] [--generation=id] [--index=id]')
  report.finishedAt = new Date().toISOString()
  await mkdir('output/phase1', { recursive: true })
  await writeFile(`output/phase1/database-${command}.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await db.close() }
