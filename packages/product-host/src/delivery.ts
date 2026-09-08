import { createHash, randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RetrievalError, type RetrievalState, type TicketRetrievalProvider, type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { MySqlDeliveryStore, type MySqlTaskStore, type DeliveryRecord, type DeliverySpec } from '@retrieval-agent/agent-plugin'
import { CandidateExportService, createRetrievalReport, validateReportNarrative, reportMarkdown, type RetrievalReport } from '@retrieval-agent/product-api'

export interface DeliveryAccess { state: RetrievalState; principal: TrustedPrincipalContext; agent: Agent }
export interface DeliveryOptions {
  access(id: string): Promise<DeliveryAccess>
  providerFor(agent: Agent): TicketRetrievalProvider
  model?(agent: Agent, id: string, stage: 'write' | 'review', input: unknown, signal: AbortSignal, trace: (data: unknown) => Promise<void>): Promise<unknown>
}
export function parseDelivery(value: unknown): { operationId: string; spec: DeliverySpec; retry: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RetrievalError('INVALID_REQUEST', '工件请求必须是对象。')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['operationId', 'kind', 'template', 'audience', 'resultRevision', 'retry'].includes(k))
    || typeof v.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(v.operationId)
    || typeof v.resultRevision !== 'string' || !v.resultRevision || v.resultRevision.length > 191
    || !['csv', 'jsonl', 'report'].includes(String(v.kind)) || !['summary', 'full'].includes(String(v.template ?? 'summary'))
    || !['operator', 'handoff'].includes(String(v.audience ?? 'operator')) || (v.retry !== undefined && typeof v.retry !== 'boolean')) {
    throw new RetrievalError('INVALID_REQUEST', '工件格式、模板、版本或幂等键无效。')
  }
  return { operationId: v.operationId, spec: { kind: v.kind as DeliverySpec['kind'], template: (v.template ?? 'summary') as DeliverySpec['template'],
    audience: (v.audience ?? 'operator') as DeliverySpec['audience'], resultRevision: v.resultRevision }, retry: v.retry === true }
}
export const deliveryView = (d: DeliveryRecord) => ({ id: d.id, operationId: d.operation_id, ...d.spec_json,
  status: d.expires_at.getTime() <= Date.now() ? 'expired' : d.status, rowCount: d.row_count, byteCount: d.byte_count,
  contentSha256: d.content_sha256, error: d.error, expiresAt: d.expires_at.toISOString(), fileName: d.meta_json?.fileName })

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
  async current(taskId: string, resultRevision: string): Promise<DeliveryAccess> {
    const access = await this.options.access(taskId), s = access.state
    if (s.phase !== 'stopped' || (s.frozenEvidence?.packId ?? s.stateId) !== resultRevision) throw new RetrievalError('INVALID_TRANSITION', '结果版本已变化，请刷新后重新生成。')
    if (s.accessValidation !== 'current' || ['permission_blocked', 'snapshot_invalid'].includes(s.termination)) throw new RetrievalError('SNAPSHOT_INVALID', '来源或访问资格已失效，请重新复核。')
    return access
  }
  async request(taskId: string, value: unknown) {
    const { operationId, spec, retry } = parseDelivery(value)
    const { state } = await this.current(taskId, spec.resultRevision)
    if (spec.kind !== 'report' && !state.selectedCandidateRefs.length) throw new RetrievalError('CANDIDATE_NOT_FOUND', '尚无可下载的确认工单。')
    return deliveryView(await this.store.create(taskId, operationId, spec, retry))
  }
  async report(taskId: string, revision: string, audience: RetrievalReport['audience']): Promise<RetrievalReport> {
    if (!['operator', 'handoff'].includes(audience)) throw new RetrievalError('INVALID_REQUEST', '报告用途无效。')
    const { state } = await this.current(taskId, revision)
    const existing = (await this.store.list(taskId)).find(d => d.spec_json.kind === 'report' && d.spec_json.resultRevision === revision
      && d.spec_json.audience === audience && d.status === 'ready' && d.expires_at.getTime() > Date.now())
    if (existing?.meta_json?.report) {
      const report = existing.meta_json.report as RetrievalReport
      if (report.resultRevision !== revision || report.taskId !== taskId || createHash('sha256').update(reportMarkdown(report)).digest('hex') !== existing.content_sha256) throw new RetrievalError('PROTOCOL_MISMATCH', '保存报告的内容校验失败。')
      return report
    }
    return this.buildReport(state, audience)
  }
  private async buildReport(state: RetrievalState, audience: RetrievalReport['audience']): Promise<RetrievalReport> {
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
      const { state, principal, agent } = await this.current(job.task_id, job.spec_json.resultRevision)
      const report = await this.buildReport(state, job.spec_json.audience)
      const check = async () => { abort.signal.throwIfAborted(); await this.current(job.task_id, job.spec_json.resultRevision) }
      if (job.spec_json.kind === 'report') {
        if (this.options.model && report.citations.length) {
          let reason = '模型解释未通过引用或独立来源校验。'
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const input = { ...report, scope: { ...report.scope, inputs: report.scope.inputs.slice(-30) }, correction: attempt ? reason : undefined }
              const draft = validateReportNarrative(await this.options.model(agent, `${job.id}-${attempt}`, 'write', input, abort.signal,
                trace => this.store.trace(job, `write-${attempt}`, trace)), report)
              const review = await this.options.model(agent, `${job.id}-${attempt}`, 'review', { report: input, draft }, abort.signal,
                trace => this.store.trace(job, `review-${attempt}`, trace)) as { supported?: boolean; reason?: string }
              if (!review || Object.keys(review).sort().join() !== 'reason,supported' || review.supported !== true || typeof review.reason !== 'string' || !review.reason.trim()) throw new Error('独立来源校验未通过。')
              report.narrative = { status: 'model', paragraphs: draft.paragraphs }; break
            } catch (e) { await check(); reason = e instanceof RetrievalError ? e.publicMessage : '模型解释暂不可用或未通过独立来源校验。' }
          }
          if (report.narrative.status !== 'model') report.narrative = { status: 'structured', paragraphs: [], reason }
        } else report.narrative.reason = report.citations.length ? '当前模型不可用，交付结构化说明。' : '没有适合模型解释的已确认可见引用，交付结构化说明。'
        await check()
        const content = reportMarkdown(report)
        await this.store.append(job, content, report.confirmedCount)
        await check()
        await this.store.publish(job, createHash('sha256').update(content).digest('hex'), { fileName: `report-${job.task_id}-${job.spec_json.audience}.md`, mediaType: 'text/markdown; charset=utf-8', report })
      } else {
        let buffers: Buffer[] = [], bytes = 0, rows = 0
        const flush = async () => { if (bytes) { await this.store.append(job, Buffer.concat(buffers), rows); buffers = []; bytes = 0 } }
        const exported = await new CandidateExportService(this.options.providerFor(agent), { append: record => this.store.trace(job, 'export-audit', record) },
          { assertCurrentResult: check, id: () => job.id }).stream(principal, state, { format: job.spec_json.kind, template: job.spec_json.template },
          async (part, count) => {
            const body = Buffer.from(part, 'utf8'); rows = count
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
    if (d.status !== 'ready') throw new RetrievalError('INVALID_TRANSITION', '工件尚未生成完成。')
    // Re-read the complete confirmed set through the Provider before serving a saved file.
    const { state, principal, agent } = await this.current(d.task_id, d.spec_json.resultRevision)
    if (state.selectedCandidateRefs.length) await new CandidateExportService(this.options.providerFor(agent), { append() {} },
      { assertCurrentResult: async () => { await this.current(d.task_id, d.spec_json.resultRevision) } }).stream(principal, state,
      { format: 'jsonl', template: d.spec_json.template }, async () => {})
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of this.store.chunks(d)) { hash.update(chunk); bytes += chunk.length }
    if (hash.digest('hex') !== d.content_sha256 || bytes !== d.byte_count) throw new RetrievalError('PROTOCOL_MISMATCH', '保存工件的内容校验失败，请重新生成。')
    await this.current(d.task_id, d.spec_json.resultRevision)
    response.writeHead(200, { 'content-type': String(d.meta_json!.mediaType), 'content-length': String(d.byte_count), 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${d.meta_json!.fileName}"`, 'x-content-sha256': d.content_sha256!, 'x-result-revision': d.spec_json.resultRevision, 'x-content-type-options': 'nosniff' })
    for await (const chunk of this.store.chunks(d)) {
      if (response.destroyed) return
      await this.current(d.task_id, d.spec_json.resultRevision)
      if (!response.write(chunk)) await new Promise<void>(resolve => {
        const done = () => { response.off('drain', done); response.off('close', done); resolve() }
        response.once('drain', done); response.once('close', done)
      })
    }
    response.end()
  }
}
