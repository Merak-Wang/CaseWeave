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
  CandidateExportService,
  InMemoryExportAuditSink,
  type ExportAuditSink,
} from '@retrieval-agent/product-api'
import {
  EXPORT_CANDIDATES_ENDPOINT,
  type ExportCandidatesErrorResponse,
  type ExportCandidatesParams,
  type ExportCandidatesResponse,
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new RetrievalError('INVALID_REQUEST', '导出接口只接受 JSON。')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '导出请求过大。')
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

function writeJson(response: ServerResponse, status: number, body: ExportCandidatesResponse | ExportCandidatesErrorResponse): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
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
  return {
    fileName: exported.fileName,
    mediaType: exported.mediaType,
    contentUtf8: exported.content,
    receipt: exported.receipt,
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
}
