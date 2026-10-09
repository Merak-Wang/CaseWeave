import { createHash, randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RetrievalError, type CandidateExportBinding, type RetrievalState, type TicketRetrievalProvider, type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { MySqlDeliveryStore, type MySqlTaskStore, type DeliveryRecord, type DeliverySpec } from '@retrieval-agent/agent-plugin'
import { CandidateExportService, DEFAULT_EXPORT_MAX_BYTES, createRetrievalReport, validateReportNarrative, reportMarkdown, learnedResultWindow, materializeLearnedRefs, type RetrievalReport } from '@retrieval-agent/product-api'
import { confirmedCount, learnedResult } from '@retrieval-agent/domain/result'
import { trustedExportBinding, assertMatchingExportBinding } from './export-binding.js'

export interface DeliveryAccess { state: RetrievalState; principal: TrustedPrincipalContext; agent: Agent }
export interface DeliveryOptions {
  allowPredictionExport?: boolean
  /** Same finite file limit used by the synchronous export service. */
  maxExportBytes?: number
  access(id: string): Promise<DeliveryAccess>
  providerFor(agent: Agent): TicketRetrievalProvider
  model?(agent: Agent, id: string, input: unknown, signal: AbortSignal, trace: (data: unknown) => Promise<void>): Promise<unknown>
}
export function parseDelivery(value: unknown): { operationId: string; spec: DeliverySpec; retry: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RetrievalError('INVALID_REQUEST', '工件请求必须是对象。')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['operationId', 'kind', 'template', 'audience', 'resultRevision', 'retry', 'collection', 'predictionSelection'].includes(k))
    || typeof v.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(v.operationId)
    || typeof v.resultRevision !== 'string' || !v.resultRevision || v.resultRevision.length > 191
    || !['csv', 'jsonl', 'xlsx', 'report'].includes(String(v.kind)) || !['summary', 'full'].includes(String(v.template ?? 'summary'))
    || !['operator', 'handoff'].includes(String(v.audience ?? 'operator')) || (v.retry !== undefined && typeof v.retry !== 'boolean')) {
    throw new RetrievalError('INVALID_REQUEST', '工件格式、模板、版本或幂等键无效。')
  }
  if (v.collection !== undefined && !['confirmed', 'predictions'].includes(String(v.collection))
    || v.predictionSelection !== undefined && (v.collection !== 'predictions' || !['accept', 'all'].includes(String(v.predictionSelection)))
    || v.kind === 'report' && (v.collection === 'predictions' || v.predictionSelection !== undefined)) throw new RetrievalError('INVALID_REQUEST', '工件集合或候选预测范围无效。')
  return { operationId: v.operationId, spec: { kind: v.kind as DeliverySpec['kind'], template: (v.template ?? 'summary') as DeliverySpec['template'],
    audience: (v.audience ?? 'operator') as DeliverySpec['audience'], resultRevision: v.resultRevision,
    ...(v.collection === undefined ? {} : { collection: v.collection as NonNullable<DeliverySpec['collection']> }),
    ...(v.predictionSelection === undefined ? {} : { predictionSelection: v.predictionSelection as NonNullable<DeliverySpec['predictionSelection']> }) }, retry: v.retry === true }
}
export const deliveryView = (d: DeliveryRecord) => ({ id: d.id, operationId: d.operation_id, ...d.spec_json,
  status: d.expires_at.getTime() <= Date.now() ? 'expired' : d.status, rowCount: d.row_count, byteCount: d.byte_count,
  contentSha256: d.content_sha256, error: d.error, expiresAt: d.expires_at.toISOString(), fileName: d.meta_json?.fileName })

function reportModelInput(report: RetrievalReport) {
  const citations = new Map(report.citations.map(c => [c.id, c]))
  return { query: report.scope.originalQuery, requirements: report.scope.inputs.filter(i => ['supplement', 'answer'].includes(i.kind))
    .slice(-30).flatMap(i => i.text ? [i.text] : []), conditions: report.scope.conditions, confirmedCount: report.confirmedCount,
    tickets: report.examples.map(example => ({ title: example.title,
      citations: example.citations.map(id => citations.get(id)).filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map(c => ({ id: c.id, field: c.field, text: c.text })) })) }
}
function structuredSummary(report: RetrievalReport): string {
  const example = report.examples[0]?.title
  return `本次查询“${report.scope.originalQuery.slice(0, 80)}”确认${report.confirmedCount}条工单。${example ? `代表案例：${example}。` : ''}`
}

export class TaskDeliveryHost {
  readonly store: MySqlDeliveryStore
  readonly owner = randomUUID()
  private running: { job: DeliveryRecord; abort: AbortController; work: Promise<void> } | undefined
  private pumpWork: Promise<void> | undefined
  private closed = false
  constructor(readonly tasks: MySqlTaskStore, readonly options: DeliveryOptions) { this.store = new MySqlDeliveryStore(tasks) }
  pump(): Promise<void> {
    if (this.closed || this.running) return Promise.resolve()
    return this.pumpWork ??= this.claim().finally(() => { this.pumpWork = undefined })
  }
  private async claim(): Promise<void> {
    const job = await this.store.claim(this.owner)
    if (!job) return
    if (this.closed) { await this.store.release(job); return }
    const abort = new AbortController()
    const work = this.run(job, abort).catch(async e => {
      if (!this.closed) await this.store.fail(job, e instanceof RetrievalError ? e.publicMessage : '工件生成失败，请重试。').catch(() => { /* A DB outage leaves the lease recoverable. */ })
    }).finally(() => { this.running = undefined })
    this.running = { job, abort, work }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.pumpWork
    await this.store.ready
    const run = this.running
    if (run) { run.abort.abort(); await this.store.release(run.job); await run.work }
  }
  async current(taskId: string, resultRevision: string, operationId?: string, expected?: CandidateExportBinding): Promise<DeliveryAccess & { exportBinding: CandidateExportBinding }> {
    const access = await this.options.access(taskId), s = access.state
    if (s.phase !== 'stopped' || (s.frozenEvidence?.packId ?? s.stateId) !== resultRevision) throw new RetrievalError('INVALID_TRANSITION', '结果版本已变化，请刷新后重新生成。')
    if (operationId?.startsWith('auto-report-') && s.termination === 'cancelled') throw new RetrievalError('INVALID_TRANSITION', '任务已取消，自动报告不再生成。')
    if (s.accessValidation !== 'current' || ['permission_blocked', 'snapshot_invalid'].includes(s.termination)) throw new RetrievalError('SNAPSHOT_INVALID', '来源或访问资格已失效，请重新复核。')
    const exportBinding = await trustedExportBinding(this.tasks, s, resultRevision, expected)
    return { ...access, exportBinding }
  }
  async request(taskId: string, value: unknown) {
    const { operationId, spec, retry } = parseDelivery(value)
    if (spec.collection === 'predictions' && !this.options.allowPredictionExport) throw new RetrievalError('INVALID_REQUEST', '当前工作台只允许下载符合条件工单，算法预测可在页面中查看。')
    const { state } = await this.current(taskId, spec.resultRevision, operationId)
    if (spec.kind !== 'report' && spec.collection !== 'predictions' && !confirmedCount(state)) throw new RetrievalError('CANDIDATE_NOT_FOUND', '尚无可下载的确认工单。')
    return deliveryView(await this.store.create(taskId, operationId, spec, retry))
  }
  async ensureAutomaticReport(taskId: string, resultRevision: string) {
    const { state } = await this.current(taskId, resultRevision)
    if (state.termination === 'cancelled') return undefined
    const operationId = `auto-report-${createHash('sha256').update(`${taskId}\0${resultRevision}\0operator`).digest('hex').slice(0, 40)}`
    return this.request(taskId, { operationId, kind: 'report', template: 'summary', audience: 'operator', resultRevision })
  }
  async report(taskId: string, revision: string, audience: RetrievalReport['audience']): Promise<RetrievalReport> {
    if (!['operator', 'handoff'].includes(audience)) throw new RetrievalError('INVALID_REQUEST', '报告用途无效。')
    const { state, principal, agent } = await this.current(taskId, revision)
    const existing = (await this.store.list(taskId)).find(d => d.spec_json.kind === 'report' && d.spec_json.resultRevision === revision
      && d.spec_json.audience === audience && d.status === 'ready' && d.expires_at.getTime() > Date.now())
    if (existing?.meta_json?.report) {
      const report = existing.meta_json.report as RetrievalReport
      // MySQL JSON 会调整浮点表示；校验已保存文本，避免重新渲染改变文件指纹。
      const hash = createHash('sha256')
      for await (const chunk of this.store.chunks(existing)) hash.update(chunk)
      if (report.resultRevision !== revision || report.taskId !== taskId || hash.digest('hex') !== existing.content_sha256) throw new RetrievalError('PROTOCOL_MISMATCH', '保存报告的内容校验失败。')
      return report
    }
    return this.buildReport(state, audience, principal, agent)
  }
  private async buildReport(state: RetrievalState, audience: RetrievalReport['audience'], principal: TrustedPrincipalContext, agent: Agent): Promise<RetrievalReport> {
    if (learnedResult(state)) {
      const provider = this.options.providerFor(agent)
      const page = await learnedResultWindow(state, provider, principal, this.tasks.semanticResults, undefined, 5)
      if (page.items.length) state = await materializeLearnedRefs(state, provider, principal, this.tasks.semanticResults, page.items.map(c => c.ref))
    }
    const report = createRetrievalReport(state, await this.tasks.commands(state.retrievalId), audience)
    const last = (await this.tasks.rows<{ data_json: { data: { decision: { action: { kind: string; coverage?: NonNullable<RetrievalReport['coverage']['assessment']> } } } } }>(
      "SELECT data_json FROM ra_task_event WHERE task_id=? AND kind='retrieval/decision-submitted' AND seq>(SELECT COALESCE(MAX(seq),0) FROM ra_task_event WHERE task_id=? AND kind='command/accepted') ORDER BY seq DESC LIMIT 1", [state.retrievalId, state.retrievalId]))[0]
    const action = last?.data_json.data.decision.action
    if (action?.kind === 'finish' && action.coverage) { const { checked, remaining, nextAction, nextActionValue } = action.coverage; report.coverage.assessment = { checked, remaining, nextAction, nextActionValue } }
    return report
  }
  private async run(job: DeliveryRecord, abort: AbortController): Promise<void> {
    const timer = setInterval(() => { void this.store.renew(job).catch(() => abort.abort()) }, 4000)
    try {
      const { state, principal, agent, exportBinding } = await this.current(job.task_id, job.spec_json.resultRevision, job.operation_id)
      const report = await this.buildReport(state, job.spec_json.audience, principal, agent)
      const check = async () => { abort.signal.throwIfAborted(); await this.current(job.task_id, job.spec_json.resultRevision, job.operation_id, exportBinding) }
      if (job.spec_json.kind === 'report') {
        if (state.query.contract?.semanticExecution?.orchestration !== 'fixed' && this.options.model && report.citations.length) {
          const narrative = validateReportNarrative(await this.options.model(agent, job.id, reportModelInput(report), abort.signal,
            trace => this.store.trace(job, 'summary', trace)), report)
          await check()
          report.narrative = { status: 'model', paragraphs: narrative.paragraphs }
        } else report.narrative.reason = structuredSummary(report)
        await check()
        const content = reportMarkdown(report)
        await this.store.append(job, content, report.confirmedCount)
        await check()
        await this.store.publish(job, createHash('sha256').update(content).digest('hex'), { fileName: `report-${job.task_id}-${job.spec_json.audience}.md`, mediaType: 'text/markdown; charset=utf-8', report })
      } else {
        let buffers: Buffer[] = [], bytes = 0, rows = 0
        const flush = async () => { if (bytes) { await this.store.append(job, Buffer.concat(buffers), rows); buffers = []; bytes = 0 } }
        const exported = await new CandidateExportService(this.options.providerFor(agent), { append: record => this.store.trace(job, 'export-audit', record) },
          { exportBinding, allowPredictionExport: this.options.allowPredictionExport === true, assertCurrentResult: check, id: () => job.id, semanticResults: this.tasks.semanticResults, maxBytes: this.options.maxExportBytes ?? DEFAULT_EXPORT_MAX_BYTES }).stream(principal, state, { format: job.spec_json.kind, template: job.spec_json.template, ...(job.spec_json.collection ? { collection: job.spec_json.collection } : {}), ...(job.spec_json.predictionSelection ? { predictionSelection: job.spec_json.predictionSelection } : {}) },
          async (part, count) => {
            const body = typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part); rows = count
            for (let offset = 0; offset < body.length;) {
              const size = Math.min(256000 - bytes, body.length - offset)
              buffers.push(body.subarray(offset, offset + size)); bytes += size; offset += size
              if (bytes === 256000) await flush()
            }
          }, undefined, abort.signal)
        await flush(); await check()
        await this.store.publish(job, exported.receipt.contentSha256, { ...exported, report })
      }
    } finally { clearInterval(timer) }
  }
  async get(taskId: string, id: string): Promise<DeliveryRecord> {
    if (!/^[a-f0-9]{48}$/u.test(id)) throw new RetrievalError('INVALID_REQUEST', '工件引用无效。')
    const d = await this.store.read(id)
    if (!d || d.task_id !== taskId) throw new RetrievalError('UNAUTHORIZED', '工件不属于此任务。')
    await this.current(taskId, d.spec_json.resultRevision)
    if (d.expires_at.getTime() <= Date.now()) throw new RetrievalError('INVALID_TRANSITION', '工件已到期，请重新申请。')
    return d
  }
  async content(d: DeliveryRecord, response: ServerResponse): Promise<void> {
    if (d.spec_json.collection === 'predictions' && !this.options.allowPredictionExport) throw new RetrievalError('INVALID_REQUEST', '当前工作台只允许下载符合条件工单，算法预测可在页面中查看。')
    if (d.status !== 'ready') throw new RetrievalError('INVALID_TRANSITION', '工件尚未生成完成。')
    // Re-read the complete confirmed set through the Provider before serving a saved file.
    const { state, principal, agent, exportBinding } = await this.current(d.task_id, d.spec_json.resultRevision)
    if (d.spec_json.collection === 'predictions') assertMatchingExportBinding(exportBinding, d.meta_json?.receipt?.exportBinding)
    else if (d.meta_json?.receipt?.exportBinding !== undefined) assertMatchingExportBinding(exportBinding, d.meta_json.receipt.exportBinding)
    const check = async () => { await this.current(d.task_id, d.spec_json.resultRevision, undefined, exportBinding) }
    if (d.spec_json.collection === 'predictions' || confirmedCount(state)) await new CandidateExportService(this.options.providerFor(agent), { append() {} },
      { exportBinding, allowPredictionExport: this.options.allowPredictionExport === true, semanticResults: this.tasks.semanticResults, maxBytes: this.options.maxExportBytes ?? DEFAULT_EXPORT_MAX_BYTES, assertCurrentResult: check }).stream(principal, state,
      { format: d.spec_json.kind === 'report' ? 'jsonl' : d.spec_json.kind, template: d.spec_json.template, ...(d.spec_json.collection ? { collection: d.spec_json.collection } : {}), ...(d.spec_json.predictionSelection ? { predictionSelection: d.spec_json.predictionSelection } : {}) }, async () => {})
    if (d.spec_json.kind !== 'report' && d.byte_count > (this.options.maxExportBytes ?? DEFAULT_EXPORT_MAX_BYTES)) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '保存文件超过当前导出大小限制，请重新生成。')
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of this.store.chunks(d)) { hash.update(chunk); bytes += chunk.length }
    if (hash.digest('hex') !== d.content_sha256 || bytes !== d.byte_count) throw new RetrievalError('PROTOCOL_MISMATCH', '保存工件的内容校验失败，请重新生成。')
    await check()
    response.writeHead(200, { 'content-type': String(d.meta_json!.mediaType), 'content-length': String(d.byte_count), 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${d.meta_json!.fileName}"`, 'x-content-sha256': d.content_sha256!, 'x-result-revision': d.spec_json.resultRevision, 'x-content-type-options': 'nosniff' })
    for await (const chunk of this.store.chunks(d)) {
      if (response.destroyed) return
      await check()
      if (!response.write(chunk)) await new Promise<void>(resolve => {
        const done = () => { response.off('drain', done); response.off('close', done); resolve() }
        response.once('drain', done); response.once('close', done)
      })
    }
    response.end()
  }
}
