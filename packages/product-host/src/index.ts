import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  RetrievalError,
  RetrievalId,
  TicketCandidateRef,
} from '@retrieval-agent/contracts'
import type {} from '@retrieval-agent/agent-plugin'
import {
  CandidateDetailService,
  CandidateExportService,
  InMemoryDetailReadAuditSink,
  InMemoryExportAuditSink,
  type DetailReadAuditSink,
  type ExportAuditSink,
} from '@retrieval-agent/product-api'
import {
  CONTINUE_RETRIEVAL_ENDPOINT,
  EXPORT_CANDIDATES_ENDPOINT,
  READ_TICKET_DETAIL_ENDPOINT,
  type ContinueRetrievalErrorResponse,
  type ContinueRetrievalParams,
  type ContinueRetrievalResponse,
  type ExportCandidatesErrorResponse,
  type ExportCandidatesParams,
  type ExportCandidatesResponse,
  type ReadTicketDetailErrorResponse,
  type ReadTicketDetailParams,
  type ReadTicketDetailResponse,
} from '@retrieval-agent/product-api/protocol'

const MAX_REQUEST_BYTES = 64 * 1024

export function parseExportCandidatesParams(value: unknown): ExportCandidatesParams {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetrievalError('INVALID_REQUEST', '导出请求格式无效。')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['sessionId', 'retrievalId', 'candidateRefs'].includes(key))) {
    throw new RetrievalError('INVALID_REQUEST', '导出请求包含未知字段。')
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0 || record.sessionId.length > 512) {
    throw new RetrievalError('INVALID_REQUEST', '会话引用无效。')
  }
  if (typeof record.retrievalId !== 'string' || !Array.isArray(record.candidateRefs)) {
    throw new RetrievalError('INVALID_REQUEST', '检索或候选引用无效。')
  }
  if (record.candidateRefs.length > 200 || record.candidateRefs.some(ref => typeof ref !== 'string')) {
    throw new RetrievalError('INVALID_REQUEST', '候选引用无效。')
  }
  return {
    sessionId: record.sessionId.trim(),
    retrievalId: RetrievalId(record.retrievalId),
    candidateRefs: record.candidateRefs.map(ref => TicketCandidateRef(ref as string)),
  }
}

export function parseReadTicketDetailParams(value: unknown): ReadTicketDetailParams {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetrievalError('INVALID_REQUEST', '详情请求格式无效。')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['sessionId', 'retrievalId', 'candidateRefs', 'fields'].includes(key))) {
    throw new RetrievalError('INVALID_REQUEST', '详情请求包含未知字段。')
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0 || record.sessionId.length > 512
    || typeof record.retrievalId !== 'string') {
    throw new RetrievalError('INVALID_REQUEST', '会话或检索引用无效。')
  }
  if (!Array.isArray(record.candidateRefs) || record.candidateRefs.length !== 1
    || record.candidateRefs.some(ref => typeof ref !== 'string')) {
    throw new RetrievalError('INVALID_REQUEST', '单次详情请求必须包含一个候选引用。')
  }
  if (!Array.isArray(record.fields) || record.fields.length > 16
    || record.fields.some(field => typeof field !== 'string' || field.trim().length === 0 || field.length > 256)) {
    throw new RetrievalError('INVALID_REQUEST', '详情字段无效。')
  }
  return {
    sessionId: record.sessionId.trim(),
    retrievalId: RetrievalId(record.retrievalId),
    candidateRefs: record.candidateRefs.map(ref => TicketCandidateRef(ref as string)),
    fields: record.fields as string[],
  }
}

export function parseContinueRetrievalParams(value: unknown): ContinueRetrievalParams {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetrievalError('INVALID_REQUEST', '继续检索请求格式无效。')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['sessionId', 'retrievalId'].includes(key))) {
    throw new RetrievalError('INVALID_REQUEST', '继续检索请求包含未知字段。')
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0 || record.sessionId.length > 512
    || typeof record.retrievalId !== 'string') {
    throw new RetrievalError('INVALID_REQUEST', '会话或检索引用无效。')
  }
  return { sessionId: record.sessionId.trim(), retrievalId: RetrievalId(record.retrievalId) }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new RetrievalError('INVALID_REQUEST', '产品接口只接受 JSON。')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new RetrievalError('INVALID_REQUEST', '请求体过大。')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new RetrievalError('INVALID_REQUEST', '导出请求不是有效 JSON。', { cause: error })
  }
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (host === undefined) return false
  try { return new URL(origin).host === host }
  catch { return false }
}

function statusOf(error: RetrievalError): number {
  switch (error.code) {
    case 'UNAUTHORIZED': return 403
    case 'SNAPSHOT_INVALID':
    case 'SNAPSHOT_NOT_FOUND': return 409
    case 'EXPORT_LIMIT_EXCEEDED': return 413
    case 'PROVIDER_UNAVAILABLE':
    case 'TIMEOUT': return 503
    case 'CANCELLED': return 408
    default: return 400
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: ExportCandidatesResponse | ExportCandidatesErrorResponse
    | ReadTicketDetailResponse | ReadTicketDetailErrorResponse
    | ContinueRetrievalResponse | ContinueRetrievalErrorResponse,
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

/** Continue only the Provider-issued cursor belonging to this live authorized retrieval. */
export async function continueRetrievalForAgent(
  ctx: Context,
  agent: Agent,
  params: ContinueRetrievalParams,
  signal?: AbortSignal,
): Promise<ContinueRetrievalResponse> {
  const retrievalAgent = ctx.agentPresets.serviceFor(agent, 'retrievalAgent')
  if (retrievalAgent === undefined) {
    throw new RetrievalError(
      'PROVIDER_UNAVAILABLE',
      '当前会话未加载工单检索能力，请重新打开会话后重试。',
      { retryable: true },
    )
  }
  const state = retrievalAgent.currentOrUndefined(agent)
  if (state === undefined || state.retrievalId !== params.retrievalId) {
    throw new RetrievalError('INVALID_REQUEST', '当前会话没有对应的检索结果。')
  }
  const continued = await retrievalAgent.continueRanking(agent, signal)
  return {
    retrievalId: continued.retrievalId,
    candidateCount: continued.candidates.length,
    nextPageAvailable: continued.lastPage?.nextCursor !== undefined,
  }
}

/** Resolve an untrusted wire request through the live Agent's trusted services. */
export async function exportCandidatesForAgent(
  ctx: Context,
  agent: Agent,
  params: ExportCandidatesParams,
  audit: ExportAuditSink,
  signal?: AbortSignal,
): Promise<ExportCandidatesResponse> {
  const retrievalAgent = ctx.agentPresets.serviceFor(agent, 'retrievalAgent')
  const provider = ctx.agentPresets.serviceFor(agent, 'ticketRetrievalProvider')
  if (retrievalAgent === undefined || provider === undefined) {
    throw new RetrievalError(
      'PROVIDER_UNAVAILABLE',
      '当前会话未加载工单检索能力，请重新打开会话后重试。',
      { retryable: true },
    )
  }
  const state = retrievalAgent.currentOrUndefined(agent)
  if (state === undefined || state.retrievalId !== params.retrievalId) {
    throw new RetrievalError('INVALID_REQUEST', '当前会话没有对应的检索结果。')
  }
  const principal = await retrievalAgent.principal(agent, 'export', signal)
  const exported = await new CandidateExportService(provider, audit)
    .exportCsv(principal, state, params.candidateRefs, signal)
  retrievalAgent.recordExport(agent, exported.receipt)
  return {
    fileName: exported.fileName,
    mediaType: exported.mediaType,
    contentUtf8: exported.content,
    receipt: exported.receipt,
  }
}

/** Resolve an inline detail click through the live Agent, trusted Principal and active Provider. */
export async function readTicketDetailsForAgent(
  ctx: Context,
  agent: Agent,
  params: ReadTicketDetailParams,
  audit: DetailReadAuditSink,
  signal?: AbortSignal,
): Promise<ReadTicketDetailResponse> {
  const retrievalAgent = ctx.agentPresets.serviceFor(agent, 'retrievalAgent')
  const provider = ctx.agentPresets.serviceFor(agent, 'ticketRetrievalProvider')
  if (retrievalAgent === undefined || provider === undefined) {
    throw new RetrievalError(
      'PROVIDER_UNAVAILABLE',
      '当前会话未加载工单详情能力，请重新打开会话后重试。',
      { retryable: true },
    )
  }
  const state = retrievalAgent.currentOrUndefined(agent)
  if (state === undefined || state.retrievalId !== params.retrievalId) {
    throw new RetrievalError('INVALID_REQUEST', '当前会话没有对应的检索结果。')
  }
  const principal = await retrievalAgent.principal(agent, 'detail_read', signal)
  const read = await new CandidateDetailService(provider, audit)
    .readDetails(principal, state, params.candidateRefs, params.fields, signal)
  retrievalAgent.recordDetailRead(agent, read.receipt)
  return {
    details: read.result.details,
    rejectedCandidateRefs: read.result.rejectedCandidateRefs,
    warnings: read.result.warnings,
    receipt: read.receipt,
  }
}

export const name = 'retrieval-product-host'
export const inject = ['webServer', 'agents', 'agentPresets', 'workspaceRegistry']

export interface Config {
  /** Existing product-owned directory adopted as the default DSH workspace. */
  readonly workspacePath?: string
}

/** Seed the product workspace and register the export route without changing the DSH Agent loop. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.workspacePath !== undefined) {
    const workspacePath = config.workspacePath.trim()
    if (workspacePath.length === 0) throw new Error('retrieval-product-host workspacePath must not be empty')
    await ctx.workspaceRegistry.create(workspacePath, '工单检索')
  }
  const audit = new InMemoryExportAuditSink()
  const detailAudit = new InMemoryDetailReadAuditSink()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EXPORT_CANDIDATES_ENDPOINT,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        writeJson(response, 405, { code: 'METHOD_NOT_ALLOWED', message: '只允许 POST。', retryable: false })
        return
      }
      if (!sameOrigin(request)) {
        writeJson(response, 403, { code: 'ORIGIN_REJECTED', message: '请求来源不受信任。', retryable: false })
        return
      }
      const abort = new AbortController()
      const onAbort = (): void => { abort.abort() }
      request.once('aborted', onAbort)
      try {
        const params = parseExportCandidatesParams(await readJson(request))
        const agent = ctx.agents.get(SessionId(params.sessionId))
        if (agent === undefined) {
          writeJson(response, 409, { code: 'SESSION_NOT_ACTIVE', message: '会话当前不可用，请重新打开后重试。', retryable: true })
          return
        }
        writeJson(response, 200, await exportCandidatesForAgent(ctx, agent, params, audit, abort.signal))
      } catch (error) {
        if (error instanceof RetrievalError) {
          writeJson(response, statusOf(error), { code: error.code, message: error.publicMessage, retryable: error.retryable })
        } else {
          writeJson(response, 500, { code: 'INTERNAL', message: '导出失败。', retryable: false })
        }
      } finally {
        request.off('aborted', onAbort)
      }
    },
  }), 'retrieval-product-host: export route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: READ_TICKET_DETAIL_ENDPOINT,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        writeJson(response, 405, { code: 'METHOD_NOT_ALLOWED', message: '只允许 POST。', retryable: false })
        return
      }
      if (!sameOrigin(request)) {
        writeJson(response, 403, { code: 'ORIGIN_REJECTED', message: '请求来源不受信任。', retryable: false })
        return
      }
      const abort = new AbortController()
      const onAbort = (): void => { abort.abort() }
      request.once('aborted', onAbort)
      try {
        const params = parseReadTicketDetailParams(await readJson(request))
        const agent = ctx.agents.get(SessionId(params.sessionId))
        if (agent === undefined) {
          writeJson(response, 409, { code: 'SESSION_NOT_ACTIVE', message: '会话当前不可用，请重新打开后重试。', retryable: true })
          return
        }
        writeJson(response, 200, await readTicketDetailsForAgent(ctx, agent, params, detailAudit, abort.signal))
      } catch (error) {
        if (error instanceof RetrievalError) {
          writeJson(response, statusOf(error), { code: error.code, message: error.publicMessage, retryable: error.retryable })
        } else {
          writeJson(response, 500, { code: 'INTERNAL', message: '工单详情读取失败。', retryable: false })
        }
      } finally {
        request.off('aborted', onAbort)
      }
    },
  }), 'retrieval-product-host: detail route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONTINUE_RETRIEVAL_ENDPOINT,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        writeJson(response, 405, { code: 'METHOD_NOT_ALLOWED', message: '只允许 POST。', retryable: false })
        return
      }
      if (!sameOrigin(request)) {
        writeJson(response, 403, { code: 'ORIGIN_REJECTED', message: '请求来源不受信任。', retryable: false })
        return
      }
      const abort = new AbortController()
      const onAbort = (): void => { abort.abort() }
      request.once('aborted', onAbort)
      try {
        const params = parseContinueRetrievalParams(await readJson(request))
        const agent = ctx.agents.get(SessionId(params.sessionId))
        if (agent === undefined) {
          writeJson(response, 409, { code: 'SESSION_NOT_ACTIVE', message: '会话当前不可用，请重新打开后重试。', retryable: true })
          return
        }
        writeJson(response, 200, await continueRetrievalForAgent(ctx, agent, params, abort.signal))
      } catch (error) {
        if (error instanceof RetrievalError) {
          writeJson(response, statusOf(error), { code: error.code, message: error.publicMessage, retryable: error.retryable })
        } else {
          writeJson(response, 500, { code: 'INTERNAL', message: '继续检索失败。', retryable: false })
        }
      } finally {
        request.off('aborted', onAbort)
      }
    },
  }), 'retrieval-product-host: continue route')
}
