import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { projectOrchestration } from './orchestration.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RetrievalError, RetrievalId, type TicketCandidateNode, type TicketRetrievalProvider } from '@retrieval-agent/contracts'
import { DurableRetrievalAgentService, MySqlTaskStore, compileTaskInformation, executeTaskJob, taskOwner, callReportModel, type TaskJob, type TaskCommand } from '@retrieval-agent/agent-plugin'
import { projectTicketCandidateState, windowedNode, candidateWindow, candidateEvidence, type CandidateView } from '@retrieval-agent/product-api'
import { SpacyQueryAnalyzer, type TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'
import { TASK_WORKBENCH_HTML } from './workbench.js'
import { TaskDeliveryHost, deliveryView, type DeliveryOptions } from './delivery.js'

export const TASKS_ENDPOINT = '/api/retrieval-agent/tasks'
export interface TaskHostOptions {
  agentFor(sessionId: string, create?: boolean): Promise<Agent>
  applicationFor(agent: Agent): DurableRetrievalAgentService
  analyzer: TicketQueryAnalyzer
  providerFor?(agent: Agent): TicketRetrievalProvider
  reportModel?: DeliveryOptions['model']
  leaseMs?: number
  concurrency?: number
  onError?(job: TaskJob, error: unknown): void
  onRequestError?(error: unknown): void
}
export interface TaskSnapshot {
  orchestration?: ReturnType<typeof projectOrchestration> | undefined
  taskId: string; sessionId: string; eventSeq: number; semanticRevision: number; queryRevision: number; inputRevision: number;
  query: string; failure: string | null; node: TicketCandidateNode | undefined;
  question: { id: string; question_json: unknown } | undefined; commands: TaskCommand[];
  conversation: { seq: number; role: 'user' | 'assistant'; text: string }[];
  feedback: { seq: number; candidateRef: string; text: string; status: 'received' | 'reviewed'; verdict?: string; reason?: string }[];
  receipt?: { operationId: string; inputRevision: number; eventSeq: number };
  learning?: { status: string; releaseId?: string; reason?: string };
}

export function parseTaskCommand(value: unknown): { operationId: string; command: TaskCommand } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RetrievalError('INVALID_REQUEST', '命令必须是 JSON 对象。')
  const v = value as Record<string, unknown>
  if (typeof v.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.operationId)) throw new RetrievalError('INVALID_REQUEST', '命令需要有效的幂等键。')
  const fields: Record<string, string[]> = { query: ['text'], supplement: ['text'], feedback: ['text', 'candidateRef', 'relevance'], answer: ['text', 'questionId'], cancel: [] }
  if (typeof v.kind !== 'string' || !Object.hasOwn(fields, v.kind)
    || Object.keys(v).some(key => !['kind', 'operationId', ...fields[v.kind as string]!].includes(key))) throw new RetrievalError('INVALID_REQUEST', '命令类型或字段无效。')
  if (v.kind !== 'cancel' && (typeof v.text !== 'string' || !v.text.trim() || v.text.length > 2000)) throw new RetrievalError('INVALID_REQUEST', '请输入 1–2000 字的内容。')
  const text = v.text as string
  let command: TaskCommand
  switch (v.kind) {
    case 'query': command = { kind: 'query', text }; break
    case 'cancel': command = { kind: 'cancel' }; break
    case 'supplement': command = { kind: 'supplement', text, information: compileTaskInformation(text) }; break
    case 'answer':
      if (typeof v.questionId !== 'string' || !v.questionId || v.questionId.length > 191) throw new RetrievalError('INVALID_REQUEST', '问题引用无效。')
      command = { kind: 'answer', text, questionId: v.questionId, information: compileTaskInformation(text) }; break
    case 'feedback':
      if (typeof v.candidateRef !== 'string' || !v.candidateRef || v.candidateRef.length > 512 || !['related', 'unrelated'].includes(String(v.relevance))) throw new RetrievalError('INVALID_REQUEST', '相关性反馈无效。')
      command = { kind: 'feedback', text, candidateRef: v.candidateRef, relevance: v.relevance as 'related' | 'unrelated' }; break
    default: throw new RetrievalError('INVALID_REQUEST', '不支持的命令。')
  }
  return { operationId: v.operationId, command }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!String(request.headers['content-type']).startsWith('application/json')) throw new RetrievalError('INVALID_REQUEST', '接口只接受 JSON。')
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of request) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > 65536) throw new RetrievalError('INVALID_REQUEST', '命令过大。'); chunks.push(data) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new RetrievalError('INVALID_REQUEST', 'JSON 无效。') }
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}

/** Public command/snapshot/event endpoint and persistent worker, also used by HTTP acceptance fixtures. */
export class TaskHost {
  readonly #owner = randomUUID()
  readonly #running = new Map<string, { abort: AbortController; work: Promise<void>; job: TaskJob }>()
  readonly #connections = new Set<ServerResponse>()
  #timer: ReturnType<typeof setInterval> | undefined
  #pumpWork: Promise<void> | undefined
  #closed = false
  #nextSourceCheck = 0
  readonly deliveries: TaskDeliveryHost | undefined
  constructor(readonly store: MySqlTaskStore, readonly options: TaskHostOptions) {
    if (options.providerFor) this.deliveries = new TaskDeliveryHost(store, { providerFor: options.providerFor,
      ...(options.reportModel ? { model: options.reportModel } : {}), access: async id => {
        const { agent, application } = await this.access(id)
        const state = await application.authorizePresentation(agent, RetrievalId(id))
        const principal = await application.principal(agent, 'export')
        return { state, agent, principal }
      } })
  }
  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => { void this.pump().catch(() => { /* next tick retries DB availability */ }) }, 250)
    this.#timer.unref()
  }
  async close(): Promise<void> {
    this.#closed = true; if (this.#timer) clearInterval(this.#timer)
    await this.#pumpWork
    await this.deliveries?.close()
    for (const response of this.#connections) response.end()
    // Abort children before releasing the lease so a shutdown fence is not recorded as expert failure.
    for (const run of this.#running.values()) run.abort.abort()
    for (const run of this.#running.values()) await this.store.release(run.job)
    await Promise.allSettled([...this.#running.values()].map(run => run.work))
  }
  pump(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    return this.#pumpWork ??= this.claimJobs().finally(() => { this.#pumpWork = undefined })
  }
  private async claimJobs(): Promise<void> {
    await this.deliveries?.pump()
    if (Date.now() >= this.#nextSourceCheck) {
      await this.store.scheduleSourceChecks()
      this.#nextSourceCheck = Date.now() + 60_000
    }
    while (!this.#closed && this.#running.size < (this.options.concurrency ?? 4)) {
      const job = await this.store.claim(this.#owner, this.options.leaseMs ?? 15000, [...this.#running.keys()],
        [...this.#running.values()].some(run => run.job.kind === 'learn'))
      if (!job) break
      if (this.#closed) { await this.store.release(job); break }
      const abort = new AbortController()
      const work = this.run(job, abort).finally(() => { this.#running.delete(job.task_id) })
      this.#running.set(job.task_id, { abort, work, job })
    }
  }
  private async run(job: TaskJob, abort: AbortController): Promise<void> {
    const renewal = setInterval(() => {
      void this.store.renew(job, this.options.leaseMs ?? 15000).then(valid => { if (!valid) abort.abort() }, () => abort.abort())
    }, Math.max(50, Math.floor((this.options.leaseMs ?? 15000) / 3)))
    try {
      const task = (await this.store.read(job.task_id))!
      const agent = await this.options.agentFor(task.session_id)
      const application = this.options.applicationFor(agent)
      await application.mirror(agent)
      await executeTaskJob(application, agent, job, this.options.analyzer, abort.signal)
      await this.store.settle(job)
    } catch (error) {
      this.options.onError?.(job, error)
      if (!this.#closed) {
        const message = error instanceof RetrievalError ? error.publicMessage : ['learn', 'unlearn', 'source_check'].includes(job.kind)
          ? 'Wiki 学习或修订未完成，已保留作业记录；已有确认结果仍按原资格下载。' : '后台执行失败，已保存任务条件。'
        const retryable = error instanceof RetrievalError ? error.retryable : !abort.signal.aborted
        try { await this.store.settle(job, message, retryable) } catch { /* a newer command or owner fenced this worker */ }
      }
    } finally { clearInterval(renewal) }
  }
  private async access(id: string) {
    await this.store.ready
    const task = (await this.store.rows<{ id: string; session_id: string; owner_hash: string; has_state: number }>(
      'SELECT id,session_id,owner_hash,state_json IS NOT NULL AS has_state FROM ra_task WHERE id=?', [id]))[0]
    if (!task) throw new RetrievalError('INVALID_REQUEST', '任务不存在。')
    const agent = await this.options.agentFor(task.session_id)
    const application = this.options.applicationFor(agent)
    const principal = await application.principal(agent, 'detail_read')
    if (task.owner_hash !== taskOwner(principal)) throw new RetrievalError('UNAUTHORIZED', '当前身份无权访问任务。')
    return { task, agent, application, principal }
  }
  async snapshot(id: string, attempt = 0): Promise<TaskSnapshot> {
    const { task: identity, agent, application } = await this.access(id)
    let node: TicketCandidateNode | undefined
    let orchestration: ReturnType<typeof projectOrchestration> | undefined
    if (identity.has_state) {
      const authorized = await application.authorizePresentation(agent, RetrievalId(id))
      if (authorized.accessValidation !== 'current' && authorized.termination !== 'snapshot_invalid') throw new RetrievalError('UNAUTHORIZED', authorized.stopExplanation ?? '当前工单访问资格未通过。')
      node = windowedNode(authorized, projectTicketCandidateState(authorized, authorized.retrievalId))
      if (authorized.accessValidation === 'current' && !['snapshot_invalid', 'permission_blocked'].includes(authorized.termination)) orchestration = projectOrchestration(authorized)
    }
    const task = (await this.store.rows<{ id: string; session_id: string; event_seq: number; semantic_revision: number;
      query_revision: number; input_revision: number; original_query: string; failure: string | null; state_revision: number | null }>(
      "SELECT id,session_id,event_seq,semantic_revision,query_revision,input_revision,original_query,failure,JSON_EXTRACT(state_json,'$.revision') AS state_revision FROM ra_task WHERE id=?", [id]))[0]!
    // If admission raced authorization, retry from the authoritative version.
    if (node?.version !== (task.state_revision ?? undefined)) {
      if (attempt >= 3) throw new RetrievalError('PROVIDER_UNAVAILABLE', '任务正在更新，请重试读取最新快照。', { retryable: true })
      return this.snapshot(id, attempt + 1)
    }
    const learning = await this.store.learningStatus(id)
    const receipts = await this.store.rows<{ receipt_json: { operationId: string; inputRevision: number; eventSeq: number } }>(
      "SELECT receipt_json FROM ra_task_command WHERE task_id=? AND JSON_EXTRACT(receipt_json,'$.eventSeq')<=? ORDER BY JSON_EXTRACT(receipt_json,'$.eventSeq') DESC LIMIT 1", [id, task.event_seq])
    const entries = await this.store.rows<{ seq: number; kind: string; data_json: any }>(
      "SELECT seq,kind,data_json FROM ra_task_event WHERE task_id=? AND seq<=? AND kind IN ('command/accepted','retrieval/decision-submitted') ORDER BY seq DESC LIMIT 60", [id, task.event_seq])
    const conversation: TaskSnapshot['conversation'] = entries.reverse().flatMap<TaskSnapshot['conversation'][number]>(e => {
      if (e.kind === 'command/accepted') return [{ seq: e.seq, role: 'user' as const, text: e.data_json.command.text ?? '取消本轮任务' }]
      const a = e.data_json.data.decision.action
      const text = a.kind === 'clarify' ? a.question : a.kind === 'finish' ? a.explanation : a.kind === 'delegate' ? '已分派 ' + a.assignments.length + ' 项专项核查：' + a.assignments.map((item: { goal: string }) => item.goal).join('；')
        : a.kind === 'inspect' ? a.candidateRefs?.length ? '正在读取 ' + a.candidateRefs.length + ' 条工单的来源依据。' : '正在读取下一组来源依据。' : '正在补充搜索，核对可能遗漏的工单。'
      return [{ seq: e.seq, role: 'assistant' as const, text }]
    })
    return { taskId: task.id, sessionId: task.session_id, eventSeq: task.event_seq, semanticRevision: task.semantic_revision,
      queryRevision: task.query_revision, inputRevision: task.input_revision, query: task.original_query, failure: task.failure, node, orchestration,
      question: await this.store.question(id), commands: await this.store.commands(id), conversation,
      ...(receipts[0] ? { receipt: receipts[0].receipt_json } : {}),
      feedback: entries.filter(e => e.kind === 'command/accepted' && e.data_json.command.kind === 'feedback').map(e => {
        const command = e.data_json.command
        const reviewed = entries.filter(later => later.seq > e.seq && later.kind === 'retrieval/decision-submitted')
          .flatMap(later => later.data_json.data.decision.judgments).find(j => j.candidateRef === command.candidateRef)
        return { seq: e.seq, candidateRef: command.candidateRef, text: command.text,
          status: reviewed ? 'reviewed' as const : 'received' as const,
          ...(reviewed ? { verdict: reviewed.verdict, reason: reviewed.reason } : {}) }
      }),
      ...(learning ? { learning } : {}) }
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        send(response, 403, { code: 'ORIGIN_REJECTED', message: '请求来源不受信任。' }); return
      }
      const url = new URL(request.url!, 'http://localhost')
      const parts = url.pathname.slice(TASKS_ENDPOINT.length).split('/').filter(Boolean)
      const id = parts[0]
      if (id && !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new RetrievalError('INVALID_REQUEST', '任务引用无效。')
      if (request.method === 'POST' && parts.length <= 1) {
        const { operationId, command } = parseTaskCommand(await readJson(request))
        if (!id) {
          if (command.kind !== 'query') throw new RetrievalError('INVALID_REQUEST', '新任务需要查询。')
          const agent = await this.options.agentFor(operationId, true)
          const principal = await this.options.applicationFor(agent).principal(agent, 'detail_read')
          send(response, 202, await this.store.create(operationId, String(agent.session.id), principal, command.text, operationId))
        } else {
          if (command.kind === 'query') throw new RetrievalError('INVALID_REQUEST', '请通过新任务入口提交查询。')
          const { principal } = await this.access(id)
          const receipt = await this.store.submit(id, principal, operationId, command)
          this.#running.get(id)?.abort.abort()
          send(response, 202, receipt)
        }
        return
      }
      if (request.method === 'GET' && id && parts.length === 1) { send(response, 200, await this.snapshot(id)); return }
      if (request.method === 'GET' && id && parts[1] === 'evidence' && parts.length === 2) {
        const { agent, application } = await this.access(id)
        const state = await application.authorizePresentation(agent, RetrievalId(id))
        send(response, 200, candidateEvidence(state, url.searchParams.get('candidateRef') ?? '')); return
      }
      if (request.method === 'GET' && id && parts[1] === 'candidates' && parts.length === 2) {
        const { agent, application } = await this.access(id)
        const state = await application.authorizePresentation(agent, RetrievalId(id))
        if (state.accessValidation !== 'current') throw new RetrievalError('UNAUTHORIZED', '当前候选访问资格失效。')
        send(response, 200, candidateWindow(state, (url.searchParams.get('view') ?? 'current') as CandidateView,
          url.searchParams.get('cursor') ?? undefined, Number(url.searchParams.get('limit') ?? 30))); return
      }
      if (request.method === 'GET' && id && parts[1] === 'knowledge' && parts.length <= 3) {
        const { agent, application } = await this.access(id)
        const state = await application.authorizePresentation(agent, RetrievalId(id))
        if (state.accessValidation !== 'current' || ['snapshot_invalid', 'permission_blocked'].includes(state.termination)) throw new RetrievalError('UNAUTHORIZED', '当前任务访问资格已失效。')
        const view = await application.coordinator?.knowledgeView?.(state, parts[2])
          ?? { status: 'disabled', domains: [] }
        const latest = await application.authorizePresentation(agent, RetrievalId(id))
        if (latest.accessValidation !== 'current' || ['snapshot_invalid', 'permission_blocked'].includes(latest.termination)) throw new RetrievalError('UNAUTHORIZED', '当前任务访问资格已失效。')
        if (latest.inputGeneration !== state.inputGeneration || latest.knowledgeCatalog?.releaseId !== state.knowledgeCatalog?.releaseId) throw new RetrievalError('INVALID_TRANSITION', '任务已更新，请重新打开知识库。')
        send(response, 200, { ...view, inputGeneration: state.inputGeneration ?? 0 }); return
      }
      if (request.method === 'GET' && id && parts[1] === 'experts' && parts[2] && parts.length === 3) {
        const { agent, application } = await this.access(id)
        const state = await application.authorizePresentation(agent, RetrievalId(id))
        if (state.accessValidation !== 'current') throw new RetrievalError('UNAUTHORIZED', '当前证据访问资格失效。')
        const expert = state.expertTasks?.find(e => e.id === parts[2] && e.inputGeneration === (state.inputGeneration ?? 0))
        if (!expert) throw new RetrievalError('INVALID_REQUEST', '专家分支已变化。')
        const refs = new Set(state.candidates.map(c => c.ref))
        const judgments = expert.finding?.judgments.filter(j => refs.has(j.candidateRef)) ?? []
        send(response, 200, { id: expert.id, scope: expert.scope, goal: expert.goal, status: expert.status, knowledgeRefs: expert.knowledgeRefs,
          question: expert.finding?.question, nextAction: expert.finding?.nextAction, gaps: expert.finding?.gaps,
          judgmentCount: judgments.length, judgments: judgments.slice(0, 30),
          candidates: state.candidates.filter(c => judgments.slice(0, 30).some(j => j.candidateRef === c.ref)),
          conflicts: state.expertConflicts?.filter(c => c.findingIds.includes(expert.finding?.id ?? '')).slice(0, 30) }); return
      }
      if (id && this.deliveries && parts[1] === 'report' && parts.length === 2 && request.method === 'GET') {
        send(response, 200, await this.deliveries.report(id, url.searchParams.get('resultRevision') ?? '',
          (url.searchParams.get('audience') ?? 'operator') as 'operator' | 'handoff')); return
      }
      if (id && this.deliveries && parts[1] === 'artifacts') {
        if (parts.length === 2 && request.method === 'POST') { send(response, 202, await this.deliveries.request(id, await readJson(request))); return }
        if (parts.length === 2 && request.method === 'GET') {
          await this.access(id); send(response, 200, (await this.deliveries.store.list(id)).map(deliveryView)); return
        }
        if (parts[2] && request.method === 'GET') {
          const d = await this.deliveries.get(id, parts[2])
          if (parts.length === 3) { send(response, 200, deliveryView(d)); return }
          if (parts.length === 4 && parts[3] === 'manifest') { send(response, 200, { ...deliveryView(d), ...d.meta_json }); return }
          if (parts.length === 4 && parts[3] === 'content') { await this.deliveries.content(d, response); return }
        }
      }
      if (request.method === 'GET' && id && parts[1] === 'events' && parts.length === 2) {
        let cursor = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RetrievalError('INVALID_REQUEST', '事件游标无效。')
        await this.snapshot(id)
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'connection': 'keep-alive', 'x-accel-buffering': 'no' })
        response.write(': connected\n\n'); this.#connections.add(response)
        let busy = false
        const poll = async (): Promise<void> => {
          if (busy || response.destroyed) return
          busy = true
          try {
            // A new grant and source validation precede each delivery, including reconnects.
            const { task, agent, application } = await this.access(id)
            if (task.has_state) {
              const state = await application.authorizePresentation(agent, RetrievalId(id))
              if (state.accessValidation !== 'current' || ['snapshot_invalid', 'permission_blocked'].includes(state.termination)) throw new RetrievalError('UNAUTHORIZED', '当前来源访问资格失效。')
            }
            const events = await this.store.rows<{ seq: number; kind: string }>('SELECT seq,kind FROM ra_task_event WHERE task_id=? AND seq>? ORDER BY seq LIMIT 100', [id, cursor])
            const last = events.at(-1)
            if (last) {
              if (!response.write(`id: ${last.seq}\nevent: change\ndata: ${JSON.stringify({ seq: last.seq, kinds: [...new Set(events.map(e => e.kind))] })}\n\n`)) { response.end(); return }
              cursor = last.seq
            } else response.write(': keepalive\n\n')
          } catch (e) {
            if (e instanceof RetrievalError && e.retryable) response.write('event: retry\ndata: {}\n\n')
            else { response.write('event: access-error\ndata: {}\n\n'); response.end() }
          }
          finally { busy = false }
        }
        const timer = setInterval(() => { void poll() }, 750)
        response.once('close', () => { clearInterval(timer); this.#connections.delete(response) })
        await poll(); return
      }
      send(response, 405, { code: 'METHOD_NOT_ALLOWED', message: '不支持的任务请求。' })
    } catch (error) {
      this.options.onRequestError?.(error)
      if (response.headersSent) { response.end(); return }
      const failure = error instanceof RetrievalError ? error : new RetrievalError('PROVIDER_UNAVAILABLE', '任务服务暂时不可用，请重试。', { retryable: true })
      send(response, failure.code === 'UNAUTHORIZED' ? 403 : ['INVALID_TRANSITION', 'SNAPSHOT_INVALID'].includes(failure.code) ? 409 : failure.retryable ? 503 : 400,
        { code: failure.code, message: failure.publicMessage, retryable: failure.retryable })
    }
  }
}

export async function installTaskHost(ctx: Context, config: { mysqlUrl?: string; workspacePath?: string; queryAnalysisBaseUrl?: string }): Promise<void> {
  const workbenchClient = await readFile(new URL('./workbench-client.js', import.meta.url))
  const store = new MySqlTaskStore(config.mysqlUrl, Boolean(process.env.RETRIEVAL_AGENT_WIKI_ROOT) && process.env.RETRIEVAL_AGENT_WIKI_LEARNING !== '0')
  await store.ready
  const restoring = new Map<string, Promise<Agent>>()
  const agentFor = async (id: string, create = false): Promise<Agent> => {
    const live = ctx.agents.get(SessionId(id)); if (live) return live
    let pending = restoring.get(id)
    if (!pending) {
      pending = (async () => {
        const saved = await store.forSession(id)
        const agentOptions = ctx.get('agentDefaultModel')?.currentSelection() ?? {}
        const handle = create && !saved
          ? await ctx.agents.create({ sessionId: SessionId(id), agentOptions, meta: { agentPreset: 'retrieval-agent', ...(config.workspacePath ? { cwd: config.workspacePath } : {}) }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'retrieval-agent') } })
          : await ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'retrieval-agent') } })
        return handle.agent
      })()
      restoring.set(id, pending)
      pending.finally(() => { restoring.delete(id) }).catch(() => {})
    }
    return pending
  }
  const applicationFor = (agent: Agent): DurableRetrievalAgentService => {
    const service = ctx.agentPresets.serviceFor(agent, 'retrievalAgent')
    if (!(service instanceof DurableRetrievalAgentService)) throw new RetrievalError('PROVIDER_UNAVAILABLE', '此任务未加载 MySQL 持久检索能力。')
    return service
  }
  const host = new TaskHost(store, { agentFor, applicationFor,
    providerFor: agent => {
      const provider = ctx.agentPresets.serviceFor(agent, 'ticketRetrievalProvider')
      if (!provider) throw new RetrievalError('PROVIDER_UNAVAILABLE', '当前工单来源不可用。')
      return provider
    },
    reportModel: (agent, id, stage, input, signal, trace) => callReportModel(ctx, agent, id, stage, input, signal, trace),
    onError: (_job, error) => { ctx.logger.warn('retrieval background operation failed', error) },
    onRequestError: error => { ctx.logger.warn('retrieval request failed', error) },
    analyzer: new SpacyQueryAnalyzer({ baseUrl: config.queryAnalysisBaseUrl ?? process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012' }) })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: TASKS_ENDPOINT, handler: (request, response) => host.handle(request, response) }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/retrieval', handler: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(TASK_WORKBENCH_HTML)
  } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/retrieval/workbench-client.js', handler: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); response.end(workbenchClient)
  } }))
  // Also repair mirrors with no remaining computation after a commit/push crash.
  const mirrors = setInterval(() => { void (async () => {
    for (const id of await store.pendingSessions()) {
      const agent = await agentFor(id); await applicationFor(agent).mirror(agent)
    }
  })().catch(() => {}) }, 2000)
  host.start()
  ctx.effect(() => async () => { clearInterval(mirrors); await host.close(); await store.close() })
}
