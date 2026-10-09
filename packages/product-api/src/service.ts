import { createHash, randomUUID } from 'node:crypto'
import {
  RetrievalError,
  isReadableTicketField,
  type CandidateExportReceipt,
  type CandidateExportBinding,
  type RetrievalState,
  type TicketCandidateRef,
  type TicketDetail,
  type TicketRetrievalProvider,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { encodeCsv, csvCell } from './csv.js'
import { XlsxWriter, XLSX_MEDIA_TYPE } from './xlsx.js'

export const DEFAULT_EXPORT_MAX_BYTES = 50_000_000
export type CandidateExportFormat = 'csv' | 'jsonl' | 'xlsx'
type ExportChunk<F extends CandidateExportFormat> = F extends 'xlsx' ? Uint8Array : string
import { hostAuthorizedCandidates } from './candidate-selection.js'
import { createTicketResultCollection, learnedResult } from '@retrieval-agent/domain/result'
import { learnedResultWindow, materializeLearnedRefs } from './numeric-results.js'
import { predictionRows, type PredictionSelection } from './predictions.js'
export interface ExportCollectionOptions { readonly collection?: 'confirmed' | 'predictions'; readonly predictionSelection?: PredictionSelection }

export interface ExportAuditRecord {
  readonly auditId: string
  readonly exportId: string
  readonly retrievalId: string
  readonly tenantId: string
  readonly subjectId: string
  readonly entitlementVersion: string
  readonly snapshotShortId: string
  readonly candidateRefs: readonly TicketCandidateRef[]
  readonly fields: readonly string[]
  readonly rowCount: number
  readonly contentSha256: string
  readonly generatedAt: string
  readonly resultRevision: string
  readonly exportBinding?: CandidateExportBinding
}
export interface ExportAuditSink {
  append(record: ExportAuditRecord): Promise<void> | void
}

export class InMemoryExportAuditSink implements ExportAuditSink {
  readonly records: ExportAuditRecord[] = []
  append(record: ExportAuditRecord): void { this.records.push(record) }
}

export interface CandidateExport {
  readonly fileName: string
  readonly mediaType: 'text/csv; charset=utf-8'
  readonly content: string
  readonly receipt: CandidateExportReceipt
}

export interface CandidateXlsxExport {
  readonly fileName: string
  readonly mediaType: typeof XLSX_MEDIA_TYPE
  readonly content: Uint8Array
  readonly receipt: CandidateExportReceipt
}

export interface CandidateExportServiceConfig {
  /** 仅显式开启的研究环境可下载未确认预测；业务入口默认只交付确认结果。 */
  readonly allowPredictionExport?: boolean
  /** Read by the trusted Host from its durable task store, never from request JSON. */
  readonly exportBinding?: CandidateExportBinding
  readonly semanticResults?: import('@retrieval-agent/contracts').SemanticResultStore
  readonly maxRows?: number
  readonly maxBytes?: number
  readonly now?: () => Date
  readonly id?: () => string
  readonly pageSize?: number
  /** The Host checks live task identity after asynchronous Provider work. */
  readonly assertCurrentResult?: () => void | Promise<void>
}

const PREDICTION_HEADERS = ['prediction_status', 'prediction_label', 'prediction_method', 'prediction_score', 'prediction_quality', 'prediction_input_revision', 'prediction_semantic_generation', 'prediction_record_identity']
const HEADERS = [
  'query', 'exported_at', 'snapshot', 'completeness', 'rank', 'ticket', 'title', 'summary',
  'type', 'category', 'product', 'component', 'region', 'status', 'priority', 'created_at',
  'source_version', 'evidence_level', 'judgment', 'judgment_reason', 'evidence_ids', 'evidence_readers',
  'result_revision', 'candidate_ref', 'content_hash', 'judgment_evidence_refs', 'query_conditions', 'stopping_reason',
  'redaction_review', 'judgment_basis', 'model_method', 'model_score', 'teacher_confidence', 'quality_evaluation',
] as const

/** Trusted-host application service; every detail/export operation re-enters the Provider. */
export class CandidateExportService {
  readonly #provider: TicketRetrievalProvider
  readonly #audit: ExportAuditSink
  readonly #maxRows: number
  readonly #maxBytes: number
  readonly #now: () => Date
  readonly #id: () => string
  readonly #pageSize: number
  readonly #exportBinding: CandidateExportBinding | undefined
  readonly #allowPredictionExport: boolean
  readonly #assertCurrentResult: () => void | Promise<void>
  readonly #semanticResults: import('@retrieval-agent/contracts').SemanticResultStore | undefined

  constructor(provider: TicketRetrievalProvider, audit: ExportAuditSink, config: CandidateExportServiceConfig = {}) {
    this.#provider = provider
    this.#allowPredictionExport = config.allowPredictionExport === true
    this.#exportBinding = config.exportBinding ? Object.freeze({ ...config.exportBinding }) : undefined
    this.#semanticResults = config.semanticResults
    this.#audit = audit
    this.#maxRows = config.maxRows ?? Number.POSITIVE_INFINITY
    this.#maxBytes = config.maxBytes ?? DEFAULT_EXPORT_MAX_BYTES
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) throw new RangeError('export maxBytes must be a positive finite integer')
    this.#pageSize = config.pageSize ?? 100
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 200) {
      throw new RangeError('export pageSize must be between 1 and 200')
    }
    this.#assertCurrentResult = config.assertCurrentResult ?? (() => {})
    this.#now = config.now ?? (() => new Date())
    this.#id = config.id ?? (() => randomUUID())
  }

  async exportCsv(
    principal: TrustedPrincipalContext,
    state: RetrievalState,
    refs?: readonly TicketCandidateRef[],
    signal?: AbortSignal, collectionOptions: ExportCollectionOptions = {},
  ): Promise<CandidateExport> {
    const parts: string[] = []
    const file = await this.stream(principal, state, { format: 'csv', template: 'summary', ...collectionOptions }, async part => { parts.push(part) }, refs, signal)
    return { ...file, mediaType: 'text/csv; charset=utf-8', content: parts.join('') }
  }

  async exportXlsx(
    principal: TrustedPrincipalContext, state: RetrievalState, refs?: readonly TicketCandidateRef[], signal?: AbortSignal, collectionOptions: ExportCollectionOptions = {},
  ): Promise<CandidateXlsxExport> {
    const parts: Uint8Array[] = []
    const file = await this.stream(principal, state, { format: 'xlsx', template: 'summary', ...collectionOptions }, async part => { parts.push(part) }, refs, signal)
    return { ...file, mediaType: XLSX_MEDIA_TYPE, content: Buffer.concat(parts) }
  }

  /** Staging sink only: the Host publishes bytes after the final grant/result check. */
  async stream<F extends CandidateExportFormat>(
    principal: TrustedPrincipalContext, state: RetrievalState,
    options: { format: F; template: 'summary' | 'full' } & ExportCollectionOptions,
    write: (chunk: ExportChunk<F>, rows: number) => Promise<void>, refs?: readonly TicketCandidateRef[], signal?: AbortSignal,
  ): Promise<{ fileName: string; mediaType: string; receipt: CandidateExportReceipt }> {
    if (state.snapshot === undefined) throw new RetrievalError('SNAPSHOT_INVALID', '检索快照不存在。')
    if (!state.snapshot.capabilities.exportRead) throw new RetrievalError('FIELD_NOT_ALLOWED', '当前数据源未开放工单下载。')
    if (!['csv', 'jsonl', 'xlsx'].includes(options.format) || !['summary', 'full'].includes(options.template)) throw new RetrievalError('INVALID_REQUEST', '下载格式或字段模板无效。')
    const predictions = options.collection === 'predictions'
    if (predictions && !this.#allowPredictionExport) throw new RetrievalError('INVALID_REQUEST', '当前工作台只允许下载已确认工单，算法预测可在页面中查看。')
    const exportBinding = this.#exportBinding
    if (predictions && !exportBinding) throw new RetrievalError('PROVIDER_UNAVAILABLE', '候选预测下载缺少可信持久任务版本，请重新生成。')
    if (exportBinding && (exportBinding.taskId !== state.retrievalId
      || !Number.isSafeInteger(exportBinding.inputRevision) || exportBinding.inputRevision < 0
      || !Number.isSafeInteger(exportBinding.semanticGeneration) || exportBinding.semanticGeneration < 0
      || exportBinding.semanticGeneration !== (state.inputGeneration ?? 0)
      || exportBinding.resultRevision !== (state.frozenEvidence?.packId ?? state.stateId))) {
      throw new RetrievalError('INVALID_TRANSITION', '任务输入或语义结果版本绑定不一致，请刷新后重新生成。')
    }
    if (options.collection !== undefined && !['confirmed', 'predictions'].includes(options.collection)
      || options.predictionSelection !== undefined && (!predictions || !['accept', 'all'].includes(options.predictionSelection))) throw new RetrievalError('INVALID_REQUEST', '导出集合或候选预测范围无效。')
    if (predictions && state.accessValidation !== 'current') throw new RetrievalError('UNAUTHORIZED', '候选预测访问资格失效。')
    const predictionSet = predictions ? predictionRows(state, options.predictionSelection) : []
    const numeric = predictions ? undefined : learnedResult(state)
    if (numeric && !this.#semanticResults) throw new RetrievalError('PROVIDER_UNAVAILABLE', '完整结果集合存储未接通，不能导出样本子集。')
    if (numeric && refs) state = await materializeLearnedRefs(state, this.#provider, principal, this.#semanticResults!, refs)
    const result = createTicketResultCollection(state)
    const confirmed = new Map((predictions ? predictionSet.map(row => row.candidate) : numeric && refs ? state.candidates.filter(c => refs.includes(c.ref)) : result.tickets).map(c => [c.ref, c]))
    const selectedRefs = refs ?? [...confirmed.keys()]
    if (selectedRefs.some(ref => !confirmed.has(ref))) throw new RetrievalError('CANDIDATE_NOT_FOUND', predictions ? '下载引用不属于当前候选预测集合。' : '下载只能包含当前结果版本中已确认的工单。')
    const candidates = numeric && !refs ? [] : hostAuthorizedCandidates(state, selectedRefs)
    if ((numeric && !refs ? numeric.returned : candidates.length) > this.#maxRows) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '候选数量超过单次导出限制。')
    const fields = options.template === 'full' ? state.snapshot!.fieldCatalog.filter(isReadableTicketField).map(f => f.key) : []
    const selectedHeaders = [...HEADERS, ...(predictions ? PREDICTION_HEADERS : [])]
    const headers = options.template === 'full' ? [...selectedHeaders, 'body_fields', 'unavailable_fields'] : selectedHeaders
    const authorize = async () => {
      if (signal?.aborted) throw new RetrievalError('CANCELLED', '下载已取消。')
      const status = await this.#provider.status(principal, state.snapshot!.snapshotId)
      if (status.providerId !== this.#provider.providerId || state.snapshot!.providerId && state.snapshot!.providerId !== this.#provider.providerId) {
        throw new RetrievalError('PROTOCOL_MISMATCH', '下载来源与当前检索 Provider 不一致。')
      }
      if (status.snapshotValid !== true) throw new RetrievalError('SNAPSHOT_INVALID', '检索快照已失效，请重新检索后导出。')
      await this.#assertCurrentResult()
    }
    await authorize()
    const generatedAt = this.#now().toISOString(), hash = createHash('sha256')
    let bytes = 0, rowCount = 0
    const emit = async (chunk: string | Uint8Array) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength
      if (bytes > this.#maxBytes) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '导出文件超过大小限制。')
      hash.update(chunk); await write(chunk as ExportChunk<F>, rowCount)
    }
    if (options.format === 'csv') await emit(encodeCsv(headers, []))
    const workbook = options.format === 'xlsx' ? await XlsxWriter.create(headers, emit) : undefined
    const evidenceByRef = new Map<string, typeof result.evidence[number][]>()
    for (const e of result.evidence) { const list = evidenceByRef.get(e.candidateRef) ?? []; list.push(e); evidenceByRef.set(e.candidateRef, list) }
    const judgments = new Map((predictions ? predictionSet.map(row => row.judgment) : result.judgments).map(j => [j.candidateRef, j]))
    const pages = async function* (service: CandidateExportService) {
      if (numeric && !refs) {
        let cursor: string | undefined
        do {
          const page = await learnedResultWindow(state, service.#provider, principal, service.#semanticResults!, cursor, service.#pageSize)
          for (const judgment of page.judgments) judgments.set(judgment.candidateRef as TicketCandidateRef, judgment as import('@retrieval-agent/contracts').RetrievalCandidateJudgment)
          yield page.items; cursor = page.nextCursor
        } while (cursor)
      } else for (let offset = 0; offset < candidates.length; offset += service.#pageSize) yield candidates.slice(offset, offset + service.#pageSize)
    }
    const seenRefs = new Set<TicketCandidateRef>()
    for await (const page of pages(this)) {
      if (signal?.aborted) throw new RetrievalError('CANCELLED', '下载已取消。')
      const details = await this.#provider.readDetails(principal, { snapshotId: state.snapshot!.snapshotId,
        candidateRefs: page.map(c => c.ref), fields, purpose: 'candidate_export' }, signal ? { signal } : undefined)
      await this.#assertCurrentResult()
      if (details.snapshotId !== state.snapshot!.snapshotId) throw new RetrievalError('PROTOCOL_MISMATCH', '下载响应不属于当前来源快照。')
      if (details.rejectedCandidateRefs.length || details.details.length !== page.length) throw new RetrievalError('UNAUTHORIZED', '部分确认工单已不可导出，请重新复核。')
      const byRef = new Map<TicketCandidateRef, TicketDetail>()
      const allowed = new Set(page.map(c => c.ref))
      for (const d of details.details) {
        if (!allowed.delete(d.candidateRef) || Object.keys(d.fields).some(f => !fields.includes(f)) || d.unavailableFields.some(f => !fields.includes(f))) {
          throw new RetrievalError('PROTOCOL_MISMATCH', '下载响应包含重复、未请求的工单或越权字段。')
        }
        if (fields.some(f => !Object.hasOwn(d.fields, f) && !d.unavailableFields.includes(f))) throw new RetrievalError('PROTOCOL_MISMATCH', '下载响应未说明所请求字段是否缺失。')
        if (Object.values(d.fields).some(values => !Array.isArray(values) || values.some(value => typeof value !== 'string'))
          || d.unavailableFields.some(f => Object.hasOwn(d.fields, f))) throw new RetrievalError('PROTOCOL_MISMATCH', '下载字段值或缺失声明无效。')
        byRef.set(d.candidateRef, d)
      }
      for (const c of page) {
        if (seenRefs.has(c.ref)) throw new RetrievalError('PROTOCOL_MISMATCH', '确认集合分页包含重复工单。')
        seenRefs.add(c.ref)
        const d = byRef.get(c.ref)!
        if (d.sourceVersion !== c.sourceVersion || d.displayId !== c.displayId || d.title !== c.title || d.summary !== c.summary) throw new RetrievalError('SNAPSHOT_INVALID', '工单来源版本已变化，请重新检索后导出。')
        const evidence = evidenceByRef.get(c.ref) ?? [], judgment = judgments.get(c.ref) ?? (numeric ? {
          reason: '学习模型集合预测；本条未逐条交 LLM 判断。', basis: 'proxy', evidenceRefs: [],
          operatorInference: { algorithm: 'learned', model_id: numeric.model_id, score: undefined } } : undefined)
        const predictionInference = predictions ? judgments.get(c.ref)?.operatorInference : undefined
        const row = [state.query.original, generatedAt, state.snapshot!.shortId, state.lastPage?.completeness ?? 'unknown',
          String(c.rank), d.displayId, d.title, d.summary, d.l0.type ?? '', d.l0.category ?? '', d.l0.product ?? '', d.l0.component ?? '',
          d.l0.region ?? '', d.l0.status ?? '', d.l0.priority ?? '', d.l0.createdAt ?? '', d.sourceVersion,
          c.evidenceLevel, predictions ? 'candidate_unmeasured' : 'confirmed', judgment?.reason ?? '', JSON.stringify(evidence.map(e => e.evidenceId)),
          JSON.stringify(Object.fromEntries(evidence.map(e => [e.evidenceId, e.readers ?? ['unknown']]))), result.resultRevision, c.ref, c.contentHash,
          JSON.stringify(judgment?.evidenceRefs ?? []), JSON.stringify(state.query.confirmedConstraints), result.stoppingReason,
          d.l0.additionalFields?.find(f => f.key === 'source.redaction')?.value ?? '',
          judgment?.basis ?? 'model', String(judgment?.operatorInference?.algorithm ?? numeric?.metadata.model ?? ''),
          String(judgment?.operatorInference?.score ?? ''), String('confidence' in (judgment ?? {}) ? (judgment as { confidence?: number }).confidence ?? '' : ''), 'not_human_evaluated',
          ...(predictions ? ['candidate_unmeasured', String(predictionInference?.proposed_label ?? 'undetermined'), String(judgment?.operatorInference?.algorithm ?? ''), String(predictionInference?.score ?? ''), 'unmeasured', String(exportBinding!.inputRevision), String(predictionInference?.input_revision), String(predictionInference?.record_identity ?? '')] : []),
          ...(options.template === 'full' ? [JSON.stringify(d.fields), JSON.stringify(d.unavailableFields)] : [])]
        rowCount++
        if (workbook) await workbook.addRow(row)
        else await emit(options.format === 'csv' ? row.map(csvCell).join(',') + '\r\n' : JSON.stringify({
          schemaVersion: 1, ticketId: d.displayId, candidateRef: c.ref, title: d.title, summary: d.summary, summaryOrigin: c.summaryOrigin,
          l0: d.l0, fields: d.fields, unavailableFields: d.unavailableFields, sourceVersion: d.sourceVersion, contentHash: c.contentHash,
          resultRevision: result.resultRevision, judgment: { verdict: predictions ? 'undetermined' : 'accept', ...(predictions ? { proposedLabel: predictionInference?.proposed_label, quality: 'unmeasured' } : {}), reason: judgment?.reason ?? '', basis: judgment?.basis ?? 'model', method: judgment?.operatorInference?.algorithm ?? numeric?.metadata.model ?? '', qualityEvaluation: 'not_human_evaluated',
            confidence: judgment && 'confidence' in judgment ? judgment.confidence ?? null : null,
            inference: judgment?.operatorInference ?? null, evidenceRefs: judgment?.evidenceRefs ?? [] },
          evidence: evidence.map(e => ({ evidenceId: e.evidenceId, field: e.field, start: e.start, end: e.end, text: e.text, origin: e.origin, spanHash: e.spanHash })),
          scope: { ...(exportBinding ? { exportBinding } : {}), collection: predictions ? 'predictions' : 'confirmed', ...(predictions ? { predictionSelection: options.predictionSelection ?? 'accept' } : {}), query: state.query.original, conditions: state.query.confirmedConstraints, snapshot: state.snapshot!.shortId, stoppingReason: result.stoppingReason },
        }) + '\n')
      }
    }
    const expectedRows = numeric && !refs ? numeric.returned : candidates.length
    if (rowCount !== expectedRows) throw new RetrievalError('PROTOCOL_MISMATCH', '导出实际行数与确认集合不一致。')
    if (workbook) await workbook.finish()
    await authorize()
    const contentSha256 = hash.digest('hex'), exportId = this.#id(), auditId = this.#id()
    const receipt: CandidateExportReceipt = { exportId, retrievalId: state.retrievalId, snapshotShortId: state.snapshot!.shortId,
      generatedAt, rowCount, fields: options.format !== 'jsonl' ? headers : ['ticketId', 'candidateRef', 'title', 'summary', 'l0', 'fields', 'unavailableFields', 'sourceVersion', 'contentHash', 'resultRevision', 'judgment', 'evidence', 'scope'], contentSha256, auditId, resultRevision: result.resultRevision, ...(exportBinding ? { exportBinding } : {}) }
    await this.#audit.append({ ...receipt, resultRevision: result.resultRevision, tenantId: principal.tenantId, subjectId: principal.subjectId,
      entitlementVersion: principal.entitlementVersion, candidateRefs: candidates.map(c => c.ref), fields: receipt.fields })
    await this.#assertCurrentResult()
    return { fileName: `retrieval-${predictions ? 'predictions-' + (options.predictionSelection ?? 'accept') + '-' : ''}${state.retrievalId}-${generatedAt.slice(0, 10)}.${options.format}`,
      mediaType: options.format === 'xlsx' ? XLSX_MEDIA_TYPE : options.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8', receipt }
  }
}
