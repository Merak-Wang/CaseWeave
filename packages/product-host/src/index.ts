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
import { installTaskHost } from './tasks.js'
export * from './tasks.js'
import {
  CandidateDetailService,
  CandidateExportService,
  InMemoryDetailReadAuditSink,
  InMemoryExportAuditSink,
  projectTicketCandidateState,
  type DetailReadAuditSink,
  type ExportAuditSink,
} from '@retrieval-agent/product-api'
import {
  CONTINUE_RETRIEVAL_ENDPOINT,
  EXPORT_CANDIDATES_ENDPOINT,
  READ_TICKET_DETAIL_ENDPOINT,
  READ_RETRIEVAL_ENDPOINT,
  type ContinueRetrievalErrorResponse,
  type ContinueRetrievalParams,
  type ContinueRetrievalResponse,
  type ExportCandidatesErrorResponse,
  type ExportCandidatesParams,
  type ExportCandidatesResponse,
  type ReadTicketDetailErrorResponse,
  type ReadTicketDetailParams,
  type ReadTicketDetailResponse,
  type ReadRetrievalParams,
  type ReadRetrievalResponse,
  type ReadRetrievalErrorResponse,
} from '@retrieval-agent/product-api/protocol'

const MAX_REQUEST_BYTES = 64 * 1024

export function parseExportCandidatesParams(value: unknown): ExportCandidatesParams {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetrievalError('INVALID_REQUEST', '导出请求格式无效。')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['sessionId', 'retrievalId', 'candidateRefs', 'resultRevision'].includes(key))) {
    throw new RetrievalError('INVALID_REQUEST', '导出请求包含未知字段。')
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0 || record.sessionId.length > 512) {
    throw new RetrievalError('INVALID_REQUEST', '会话引用无效。')
  }
  if (typeof record.retrievalId !== 'string' || typeof record.resultRevision !== 'string'
    || record.resultRevision.trim().length === 0 || record.resultRevision.length > 512) {
    throw new RetrievalError('INVALID_REQUEST', '检索或候选引用无效。')
  }
  if (record.candidateRefs !== undefined && (!Array.isArray(record.candidateRefs)
    || record.candidateRefs.length === 0 || record.candidateRefs.some(ref => typeof ref !== 'string'))) {
    throw new RetrievalError('INVALID_REQUEST', '候选引用无效。')
  }
  return {
    sessionId: record.sessionId.trim(),
    retrievalId: RetrievalId(record.retrievalId),
    resultRevision: record.resultRevision,
    ...(record.candidateRefs === undefined ? {} : {
      candidateRefs: (record.candidateRefs as string[]).map(ref => TicketCandidateRef(ref)),
    }),
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

function parseRetrievalIdentity(value: unknown, operation: string): ContinueRetrievalParams {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetrievalError('INVALID_REQUEST', `${operation}请求格式无效。`)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['sessionId', 'retrievalId'].includes(key))) {
    throw new RetrievalError('INVALID_REQUEST', `${operation}请求包含未知字段。`)
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0 || record.sessionId.length > 512
    || typeof record.retrievalId !== 'string') {
    throw new RetrievalError('INVALID_REQUEST', '会话或检索引用无效。')
  }
  return { sessionId: record.sessionId.trim(), retrievalId: RetrievalId(record.retrievalId) }
}

export function parseContinueRetrievalParams(value: unknown): ContinueRetrievalParams {
  return parseRetrievalIdentity(value, '继续检索')
}

export function parseReadRetrievalParams(value: unknown): ReadRetrievalParams {
  return parseRetrievalIdentity(value, '重新授权')
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
    case 'INVALID_TRANSITION':
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
    | ReadRetrievalResponse | ReadRetrievalErrorResponse
    | ContinueRetrievalResponse | ContinueRetrievalErrorResponse,
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

/** Session events identify a retrieval; only a current Provider grant allows presentation. */
export async function readRetrievalForAgent(
  ctx: Context,
  agent: Agent,
  params: ReadRetrievalParams,
  signal?: AbortSignal,
): Promise<ReadRetrievalResponse> {
  const retrievalAgent = ctx.agentPresets.serviceFor(agent, 'retrievalAgent')
  if (retrievalAgent === undefined) {
    throw new RetrievalError('PROVIDER_UNAVAILABLE', '当前会话未加载工单检索能力。', { retryable: true })
  }
  const state = await retrievalAgent.authorizePresentation(agent, params.retrievalId, signal)
  if (state.accessValidation !== 'current') {
    if (state.termination === 'backend_error') {
      throw new RetrievalError('PROVIDER_UNAVAILABLE', '工单来源暂时不可用，无法完成重新授权；请稍后重试。', { retryable: true })
    }
    if (state.termination === 'snapshot_invalid') throw new RetrievalError('SNAPSHOT_INVALID', '历史快照已失效，请重新检索。')
    if (state.termination === 'cancelled') throw new RetrievalError('CANCELLED', '重新授权已取消，请重试。')
    throw new RetrievalError('UNAUTHORIZED', '当前身份未获得历史工单的重新授权。')
  }
  return { node: projectTicketCandidateState(state, state.retrievalId) }
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
  const state = await (retrievalAgent.stateForTask?.(agent, params.retrievalId) ?? retrievalAgent.currentOrUndefined(agent))
  if (state === undefined || state.retrievalId !== params.retrievalId) {
    throw new RetrievalError('INVALID_REQUEST', '当前会话没有对应的检索结果。')
  }
  if (retrievalAgent.currentOrUndefined(agent)?.retrievalId !== params.retrievalId) {
    throw new RetrievalError('INVALID_TRANSITION', '历史任务不能通过当前会话的分页按钮继续，请打开对应任务并保存补充。')
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
  const state = await (retrievalAgent.stateForTask?.(agent, params.retrievalId) ?? retrievalAgent.currentOrUndefined(agent))
  if (state === undefined || state.retrievalId !== params.retrievalId) {
    throw new RetrievalError('INVALID_REQUEST', '当前会话没有对应的检索结果。')
  }
  const assertCurrentResult = async (): Promise<void> => {
    const current = await (retrievalAgent.stateForTask?.(agent, params.retrievalId) ?? retrievalAgent.currentOrUndefined(agent))
    if (current?.retrievalId !== state.retrievalId || current.phase !== 'stopped'
      || (current.frozenEvidence?.packId ?? current.stateId) !== params.resultRevision) {
      throw new RetrievalError('INVALID_TRANSITION', '确认结果已变化，请刷新结果后重新下载。')
    }
    if (['permission_blocked', 'snapshot_invalid'].includes(current.termination)) {
      throw new RetrievalError('SNAPSHOT_INVALID', '当前确认结果的访问资格已失效，请重新复核。')
    }
  }
  await assertCurrentResult()
  const principal = await retrievalAgent.principal(agent, 'export', signal)
  await assertCurrentResult()
  const exported = await new CandidateExportService(provider, audit, { assertCurrentResult })
    .exportCsv(principal, state, params.candidateRefs, signal)
  await retrievalAgent.recordExport(agent, exported.receipt)
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
  const state = await (retrievalAgent.stateForTask?.(agent, params.retrievalId) ?? retrievalAgent.currentOrUndefined(agent))
  if (state === undefined || state.retrievalId !== params.retrievalId) {
    throw new RetrievalError('INVALID_REQUEST', '当前会话没有对应的检索结果。')
  }
  const principal = await retrievalAgent.principal(agent, 'detail_read', signal)
  const read = await new CandidateDetailService(provider, audit)
    .readDetails(principal, state, params.candidateRefs, params.fields, signal)
  await retrievalAgent.recordDetailRead(agent, read.receipt, read.result)
  return {
    details: read.result.details,
    rejectedCandidateRefs: read.result.rejectedCandidateRefs,
    warnings: read.result.warnings,
    receipt: read.receipt,
  }
}

export const name = 'retrieval-product-host'
export const inject = ['webServer', 'agents', 'agentPresets', 'workspaceRegistry', 'llm', 'settings', 'credentials', 'agentDefaultModel']

export interface Config {
  readonly taskPersistence?: 'session' | 'mysql'
  readonly mysqlUrl?: string
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
  if ((config.taskPersistence ?? (process.env.RETRIEVAL_AGENT_STORAGE === 'mysql_milvus' ? 'mysql' : 'session')) === 'mysql') await installTaskHost(ctx, config)
  const detailAudit = new InMemoryDetailReadAuditSink()
  const register = <Params>(
    path: string,
    parse: (value: unknown) => Params & { readonly sessionId: string },
    execute: (agent: Agent, params: Params, signal: AbortSignal) => Promise<Parameters<typeof writeJson>[2]>,
    failureMessage: string,
  ): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path,
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
          const params = parse(await readJson(request))
          const agent = ctx.agents.get(SessionId(params.sessionId))
          if (agent === undefined) {
            writeJson(response, 409, { code: 'SESSION_NOT_ACTIVE', message: '会话当前不可用，请重新打开后重试。', retryable: true })
            return
          }
          await ctx.agentPresets.serviceFor(agent, 'retrievalAgent')?.loadTask?.(agent)
          writeJson(response, 200, await execute(agent, params, abort.signal))
        } catch (error) {
          if (error instanceof RetrievalError) {
            writeJson(response, statusOf(error), { code: error.code, message: error.publicMessage, retryable: error.retryable })
          } else {
            writeJson(response, 500, { code: 'INTERNAL', message: failureMessage, retryable: false })
          }
        } finally {
          request.off('aborted', onAbort)
        }
      },
    }), `retrieval-product-host: ${path}`)
  }
  register(EXPORT_CANDIDATES_ENDPOINT, parseExportCandidatesParams,
    (agent, params, signal) => exportCandidatesForAgent(ctx, agent, params, audit, signal), '导出失败。')
  register(READ_TICKET_DETAIL_ENDPOINT, parseReadTicketDetailParams,
    (agent, params, signal) => readTicketDetailsForAgent(ctx, agent, params, detailAudit, signal), '工单详情读取失败。')
  register(CONTINUE_RETRIEVAL_ENDPOINT, parseContinueRetrievalParams,
    (agent, params, signal) => continueRetrievalForAgent(ctx, agent, params, signal), '继续检索失败。')
  register(READ_RETRIEVAL_ENDPOINT, parseReadRetrievalParams,
    (agent, params, signal) => readRetrievalForAgent(ctx, agent, params, signal), '无法重新授权当前工单集合。')
}
