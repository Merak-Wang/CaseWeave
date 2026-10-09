import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { TASK_WORKBENCH_HTML } from '../packages/product-host/lib/workbench.js'
import { parseDelivery } from '../packages/product-host/lib/delivery.js'
import { candidateWindow, windowedNode, CandidateExportService } from '../packages/product-api/lib/index.js'
import { createTicketResultCollection } from '../packages/domain/lib/result.js'

// Isolated UI fixture uses real paging/export code and wholly synthetic memory records. No upstream or database.
const tasks = new Map(), commands = [], artifacts = new Map(), port = Number(process.env.WORKBENCH_CONTROLS_PORT ?? 3099)
const principal = { tenantId: 'synthetic', subjectId: 'qa', entitlementVersion: 'synthetic-v1', purpose: 'ticket_retrieval', attributes: {}, issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2126-01-01T00:00:00Z' }
const json = (res, data) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
const unlabeled = task => ['dual_description_margin', 'name_gmm', 'kmeans'].includes(task.execution?.semanticMethod)
function stateFor(task) {
  const candidates = unlabeled(task) ? ['accept', 'exclude', 'undetermined'].map((label, index) => ({ ref: task.id + '-' + label, displayId: 'SYNTHETIC-' + label,
    snapshotId: 'synthetic-snapshot', sourceVersion: 'synthetic-v1', contentHash: 'synthetic-hash-' + index, evidenceLevel: 'L0', rank: index + 1,
    title: '合成候选 ' + label, summary: '纯合成摘要，不包含生产工单。', l0: {}, matchFragments: [] })) : []
  return { retrievalId: task.id, stateId: task.id + '-result', inputGeneration: 1, accessValidation: 'current', phase: unlabeled(task) ? 'stopped' : 'searching', termination: unlabeled(task) ? 'partial' : 'active',
    task: { target: 'ranked_cases' }, budget: {}, query: { original: task.text, confirmedConstraints: [], contract: { semanticExecution: task.execution } },
    snapshot: { snapshotId: 'synthetic-snapshot', shortId: 'synthetic', providerId: 'synthetic-provider', fieldCatalog: [], capabilities: { exportRead: true } },
    candidates, candidateHistory: candidates, selectedCandidateRefs: [], excludedCandidateRefs: [], promotedEvidence: [], gaps: [],
    judgments: candidates.map((c, i) => ({ candidateRef: c.ref, verdict: 'undetermined', basis: 'unresolved', reason: '合成未校准候选', evidenceRefs: [],
      operatorInference: { algorithm: task.execution.semanticMethod, proposal: task.execution.semanticMethod, phase: 'prediction', inferred: true, proposed: Number(i === 0),
        proposed_label: ['accept', 'exclude', 'undetermined'][i], quality: 'unmeasured', input_revision: 1, score: [.87, .1, 0][i], source_version: c.sourceVersion, content_hash: c.contentHash,
        record_identity: createHash('sha256').update(JSON.stringify([c.ref, c.sourceVersion, c.contentHash])).digest('hex') } })) }
}
function onlineLearningFor(task) {
  if (task.execution?.onlineLearning === false || task.execution?.semanticMethod !== 'auto') return
  const methods = task.execution.onlineModels ?? ['dense_lr', 'dense_svm', 'dense_mlp', 'dense_hgb']
  const ensemble = task.execution.onlineFusion === 'selective' && methods.length > 1
  const metric = { precision: .91, recall: .86, f1: .88, coverage: 1, agreement: .85, reference_records: 16, reference_unknown: 0, prediction_unknown: 0 }
  return { status: 'quality_passed', resultAvailable: false, scopeCount: 40, sampledCount: 20, trainingCount: 16, selectionCount: 0, finalHoldoutCount: 4,
    fitCount: methods.length * 3, samplingRequests: 20, predictedCount: 0, crossfitFolds: 2, fusion: task.execution.onlineFusion ?? 'single',
    selectedEnsemble: ensemble, selectedMembers: methods.slice(0, ensemble ? 2 : 1), selectedModel: methods[0], threshold: .5,
    selectionReason: ensemble ? 'oof_diversity_gain' : 'single_requested', singleBaseline: { name: methods[0], threshold: .5, ...metric },
    models: methods.map(name => ({ name, ...metric })), groupProjection: 'business-and-canonical-nfkc-whitespace-v1',
    quality: { basis: 'training_group_crossfit', reference_basis: 'teacher', business_accuracy: 'not_measured', precision: .91, recall: .86, precision_target: .9, recall_target: .9 },
    finalTeacherAgreement: { ...metric, precision: .82, recall: .75, reference_records: 4, reference_basis: 'teacher', used_for_selection: false, raw_before_label_override: true } }
}
function snapshot(task) {
  const state = stateFor(task), result = unlabeled(task) ? createTicketResultCollection(state) : undefined
  const node = windowedNode(state, { snapshotShortId: state.snapshot.shortId, status: unlabeled(task) ? 'partial' : 'searching', candidates: state.candidates, candidateHistory: [], selectedCandidateRefs: [], detailFields: [], exportEnabled: false,
    searchProgress: { channels: [] }, ...(result ? { result } : {}) })
  return { taskId: task.id, query: task.text, inputRevision: 1, revision: 1, eventSeq: 0, commands: [{ kind: 'query', text: task.text, operationId: task.operationId }], conversation: [], feedback: [], node,
    orchestration: { terminal: unlabeled(task), outcome: unlabeled(task) ? 'partial' : 'running', stage: unlabeled(task) ? 'finished' : 'planning', inputGeneration: 1, experts: [],
      counts: { candidates: state.candidates.length, inspected: 0, confirmed: 0, experts: 0, completedExperts: 0 }, catalog: { releaseId: 'synthetic' },
      retrieval: { execution: task.execution, ...(unlabeled(task) ? { filterActivity: 'completed', learning: { status: 'model_unknown', resultAvailable: false, scopeCount: 3, scopeRecords: 3,
        positiveCount: 1, negativeCount: 1, unresolvedCount: 1, fitCount: task.execution.semanticMethod === 'dual_description_margin' ? 0 : 1, samplingRequests: 0, qualityBasis: 'unmeasured', quality: 'unmeasured' } } : { learning: onlineLearningFor(task) }) } } }
}
const sourceFor = state => ({ providerId: 'synthetic-provider', status: async () => ({ providerId: 'synthetic-provider', snapshotValid: true }),
  readDetails: async (_principal, request) => ({ snapshotId: request.snapshotId, details: request.candidateRefs.map(ref => { const c = state.candidates.find(c => c.ref === ref)
    return { candidateRef: c.ref, displayId: c.displayId, sourceVersion: c.sourceVersion, title: c.title, summary: c.summary, l0: c.l0, fields: {}, unavailableFields: [] } }), rejectedCandidateRefs: [], warnings: [] }) })
const bodyFor = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/retrieval') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(TASK_WORKBENCH_HTML); return }
    if (url.pathname === '/retrieval/workbench-client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(await readFile(new URL('../packages/product-host/lib/workbench-client.js', import.meta.url))); return }
    if (url.pathname === '/synthetic/commands') { json(res, commands); return }
    if (url.pathname === '/api/retrieval-agent/tasks' && req.method === 'POST') {
      const body = await bodyFor(req), id = 'ui-task-' + (tasks.size + 1)
      commands.push(body); tasks.set(id, { id, ...body }); json(res, { taskId: id, inputRevision: 1 }); return
    }
    const match = /^\/api\/retrieval-agent\/tasks\/(ui-task-\d+)(?:\/(.*))?$/u.exec(url.pathname)
    if (match && tasks.has(match[1])) {
      const task = tasks.get(match[1]), state = stateFor(task)
      if (!match[2] && req.method === 'POST') { const command = await bodyFor(req); commands.push(command); json(res, { taskId: task.id, inputRevision: 1 }); return }
      if (!match[2]) { json(res, snapshot(task)); return }
      if (match[2] === 'events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': synthetic fixture\n\n'); return }
      if (match[2] === 'artifacts' && req.method === 'POST') {
        const body = await bodyFor(req), { spec } = parseDelivery(body), parts = []
        commands.push(body)
        const exported = await new CandidateExportService(sourceFor(state), { append() {} }).stream(principal, state, { format: spec.kind, template: spec.template,
          ...(spec.collection ? { collection: spec.collection } : {}), ...(spec.predictionSelection ? { predictionSelection: spec.predictionSelection } : {}) }, async part => { parts.push(typeof part === 'string' ? Buffer.from(part) : Buffer.from(part)) })
        const bytes = Buffer.concat(parts), item = { id: 'artifact-' + artifacts.size, ...body, status: 'ready', fileName: exported.fileName, rowCount: exported.receipt.rowCount,
          byteCount: bytes.length, contentSha256: exported.receipt.contentSha256, expiresAt: '2126-01-01T00:00:00Z' }
        artifacts.set(item.id, { taskId: task.id, item, bytes, mediaType: exported.mediaType }); json(res, item); return
      }
      if (match[2] === 'artifacts') { json(res, [...artifacts.values()].filter(a => a.taskId === task.id).map(a => a.item)); return }
      const file = /^artifacts\/(artifact-\d+)\/content$/u.exec(match[2] ?? '')
      if (file && artifacts.has(file[1])) { const a = artifacts.get(file[1]); if (a.taskId !== task.id) throw new Error('Wrong synthetic task')
        res.writeHead(200, { 'content-type': a.mediaType, 'content-length': a.bytes.length, 'x-content-sha256': a.item.contentSha256, 'x-result-revision': a.item.resultRevision }); res.end(a.bytes); return }
      if (match[2] === 'candidates') { json(res, candidateWindow(state, url.searchParams.get('view') ?? 'current', url.searchParams.get('cursor') ?? undefined, Number(url.searchParams.get('limit') ?? 30))); return }
      if (match[2] === 'activity') { json(res, { items: [], after: 0, more: false }); return }
    }
    json(res, { providers: [], models: [], entries: [], items: [], candidates: [], total: 0 })
  } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: error.message, code: error.code ?? 'SYNTHETIC_ERROR' })) }
}).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ fixture: 'workbench-controls', port, syntheticOnly: true })))
