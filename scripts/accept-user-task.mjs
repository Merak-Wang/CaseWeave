import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { parseArgs } from 'node:util'

// A public-API user journey. No production imports, injected decisions or oracle filters.
const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:3084' },
  query: { type: 'string' }, task: { type: 'string' },
  out: { type: 'string' }, expect: { type: 'string' },
  'timeout-ms': { type: 'string', default: '180000' },
} })
if (Boolean(values.query) === Boolean(values.task)) throw new Error('Supply exactly one of --query "自然语言" or --task TASK_ID')
const timeoutMs = Number(values['timeout-ms'])
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be at least 1000')
const base = new URL(values.url)
const output = resolve(values.out ?? join('output', `user-task-${Date.now()}`))
await mkdir(output, { recursive: true })
// Expectations stay outside the product request. Use only independently supported IDs.
const expected = values.expect ? JSON.parse(await readFile(values.expect, 'utf8')) : undefined
const report = { startedAt: new Date().toISOString(), baseUrl: base.href, query: values.query, checks: [], observations: [] }
let taskId = values.task, created = false, lastVersion, snapshot, terminal = false
const deadline = Date.now() + timeoutMs
async function save(name, value) { await writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n') }
function check(ok, message) {
  report.checks.push({ message, passed: Boolean(ok) })
  if (!ok) throw new Error(message)
}
async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.code ?? ''} ${data.message ?? ''}`)
  return data
}
// Decode downloaded CSV independently of the product's encoder, including quoted newlines.
function csvRows(content) {
  const rows = [], row = []; let cell = '', quoted = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (c === '"') {
      if (quoted && content[i + 1] === '"') { cell += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(cell.replace(/\r$/u, '')); cell = ''
      if (c === '\n') { rows.push(row.splice(0)); }
    } else cell += c
  }
  if (quoted) throw new Error('download has an unterminated CSV cell')
  if (cell || row.length) rows.push([...row, cell])
  return rows
}
try {
  if (values.query) {
    const command = { kind: 'query', text: values.query, operationId: randomUUID() }
    const receipt = await request('/api/retrieval-agent/tasks', command)
    taskId = receipt.taskId; created = true
    check(typeof taskId === 'string' && taskId.length > 0, 'query returned a task identity')
    const duplicate = await request('/api/retrieval-agent/tasks', command)
    check(duplicate.taskId === taskId, 'repeating the same submission retains one task')
    await save('query-receipt.json', receipt)
  }
  report.taskId = taskId
  const taskPath = '/api/retrieval-agent/tasks/' + encodeURIComponent(taskId)
  let detailRead = false
  while (Date.now() < deadline) {
    snapshot = await request(taskPath)
    const node = snapshot.node
    if (snapshot.eventSeq !== lastVersion) {
      lastVersion = snapshot.eventSeq
      report.observations.push({ at: new Date().toISOString(), eventSeq: lastVersion,
        status: node?.status, candidates: node?.collectionWindow?.current ?? node?.candidates?.length ?? 0, confirmed: node?.collectionWindow?.confirmed ?? node?.selectedCandidateRefs?.length ?? 0,
        question: snapshot.question?.question_json?.question, failure: snapshot.failure })
      await save('snapshot.json', snapshot)
      console.log(JSON.stringify(report.observations.at(-1)))
    }
    if (!detailRead && node?.candidates?.length && node.detailFields?.length) {
      const candidate = node.candidates[0]
      const payload = { sessionId: snapshot.sessionId, retrievalId: taskId, candidateRefs: [candidate.ref], fields: node.detailFields.map(f => f.key) }
      await save('detail-request.json', payload)
      const details = await request('/api/retrieval-agent/detail', payload)
      await save('detail.json', details)
      check(details.details?.length === 1 && details.details[0].candidateRef === candidate.ref, 'advertised detail fields are readable for the selected ticket')
      detailRead = true
    }
    if (snapshot.failure) throw new Error(snapshot.failure)
    if (node?.result) {
      terminal = true
      const result = node.result
      await save('result.json', result)
      const tickets = []
      if (node.collectionWindow) {
        let cursor
        do {
          const page = await request(taskPath + '/candidates?view=confirmed&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
          tickets.push(...page.items); cursor = page.nextCursor
        } while (cursor)
        check(tickets.length === node.collectionWindow.confirmed, 'paged confirmation list matches authoritative count')
      } else tickets.push(...result.tickets)
      const ids = tickets.map(t => t.displayId)
      await save('confirmed-tickets.json', tickets)
      if (node.collectionWindow) {
        const description = await request(taskPath + '/report?resultRevision=' + encodeURIComponent(result.resultRevision))
        check(description.confirmedCount === ids.length && description.citations.every(c => tickets.some(t => t.ref === c.candidateRef && t.sourceVersion === c.sourceVersion && t.contentHash === c.contentHash)), 'report count and source citations match complete confirmed set')
        await save('retrieval-report.json', description)
      }
      if (ids.length) {
        const exported = await request('/api/retrieval-agent/export', { sessionId: snapshot.sessionId, retrievalId: taskId, resultRevision: result.resultRevision })
        check(exported.receipt.resultRevision === result.resultRevision && exported.receipt.rowCount === ids.length, 'download uses the same confirmed result version and count')
        check(createHash('sha256').update(exported.contentUtf8).digest('hex') === exported.receipt.contentSha256, 'download bytes match the receipt hash')
        await writeFile(join(output, basename(exported.fileName)), exported.contentUtf8)
        await save('download-receipt.json', exported.receipt)
        const [header, ...rows] = csvRows(exported.contentUtf8.replace(/^\uFEFF/u, ''))
        const ticketColumn = header.indexOf('ticket'), revisionColumn = header.indexOf('result_revision')
        check(ticketColumn >= 0 && revisionColumn >= 0, 'download declares ticket and result version columns')
        check(JSON.stringify(rows.map(row => row[ticketColumn]).sort()) === JSON.stringify([...ids].sort())
          && rows.every(row => row[revisionColumn] === result.resultRevision), 'downloaded CSV contains exactly the confirmed ticket IDs and result version')
        const unconfirmed = node.candidates.find(c => !tickets.some(t => t.ref === c.ref))
        if (unconfirmed) {
          const response = await fetch(new URL('/api/retrieval-agent/export', base), { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: snapshot.sessionId, retrievalId: taskId, resultRevision: result.resultRevision, candidateRefs: [unconfirmed.ref] }), signal: AbortSignal.timeout(30000) })
          check(response.status === 400, 'an unconfirmed ticket cannot be downloaded')
        }
      } else check(node.exportEnabled === false, 'zero confirmed tickets disable download')
      report.outcome = ['top_k_accepted', 'no_result'].includes(result.stoppingReason) ? 'completed' : 'incomplete'
      // Completion of the protocol is not a semantic quality judgment.
      report.semanticQuality = expected ? 'checked only against supplied independent IDs' : 'not evaluated'
      if (expected) {
        if (expected.confirmedIds) check(JSON.stringify([...ids].sort()) === JSON.stringify([...expected.confirmedIds].sort()), 'confirmed IDs match independent expectations')
        if (expected.excludedIds) check(expected.excludedIds.every(id => !ids.includes(id)), 'independently excluded IDs are absent')
      }
      break
    }
    if (snapshot.question) { report.outcome = 'needs_user_reply'; break }
    await pause(1000)
  }
  report.outcome ??= 'incomplete'
} catch (error) {
  report.outcome = 'failed'; report.error = error.message
} finally {
  // Only clean up a task created by this acceptance run. Never cancel an inspected existing task.
  if (created && !terminal && taskId) {
    try { report.cancellation = await request('/api/retrieval-agent/tasks/' + encodeURIComponent(taskId), { kind: 'cancel', operationId: randomUUID() }) }
    catch (error) { report.cancellationError = error.message }
  }
  report.finishedAt = new Date().toISOString()
  await save('run.json', report)
  console.log(JSON.stringify({ outcome: report.outcome, taskId, output, error: report.error }))
  process.exitCode = report.outcome === 'completed' ? 0 : report.outcome === 'failed' ? 1 : 2
}
