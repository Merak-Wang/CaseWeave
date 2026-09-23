import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { RetrievalError } from '@retrieval-agent/contracts'
import { modelFailure, type ModelFailureCause } from './model-failure.js'

export interface PythonOperatorRun {
  readonly scope: { task_id: string; input_revision: number; snapshot: string; authorization: string }
  readonly model_identity: string
  readonly knowledge: { release: string; entries: readonly Record<string, unknown>[] }
  readonly op: string; readonly instruction: string; readonly source_handle?: string
  readonly params?: Readonly<Record<string, unknown>>
}
interface Pending {
  callback(method: string, payload: unknown): Promise<unknown>
  result(value: unknown): Promise<void>
  resolve(metrics: Record<string, unknown>): void
  reject(error: unknown): void
  cleanup(): void
  tail: Promise<void>
  failure?: unknown
}

function callbackFailure(error: unknown) {
  const cause = error instanceof RetrievalError ? error.cause as ModelFailureCause | undefined : undefined
  // Python 负责单次模型请求的重试与计量；其他回调错误保持原来的失败语义。
  return error instanceof RetrievalError && cause?.modelFailure
    ? { ...cause.modelFailure, message: error.publicMessage, retryable: error.retryable, ...(cause.usage ? { usage: cause.usage } : {}) }
    : 'host_callback_rejected'
}

/** Long-lived UTF-8 NDJSON worker; callbacks are host-owned and never select credentials. */
export class PythonOperatorBridge {
  private child: ChildProcessWithoutNullStreams | undefined
  private socket: WebSocket | undefined
  private connection: Promise<void> | undefined
  private readonly jobs = new Map<string, Pending>()
  private closed = false
  constructor(readonly root = process.cwd(), readonly statePath = resolve(root, '.cache/semantic-operators/artifacts.sqlite'),
    readonly python = process.env.CASEWEAVE_PYTHON, readonly serviceUrl = process.env.CASEWEAVE_OPERATORS_URL) {}
  private fail(): void {
    for (const [id, job] of this.jobs) { this.jobs.delete(id); job.cleanup(); job.reject(new RetrievalError('PROVIDER_UNAVAILABLE', 'Python 算子连接退出，任务和已提交结果已保留。', { retryable: true })) }
  }
  private async connect(): Promise<void> {
    if (this.closed) throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Python 算子工作进程已关闭。')
    if (!this.serviceUrl) { this.process(); return }
    if (this.connection) return this.connection
    this.connection = new Promise<void>((ready, reject) => {
      const url = new URL('/v1/operators', this.serviceUrl)
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Invalid operator service URL')
      url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:'
      const token = process.env.CASEWEAVE_OPERATORS_TOKEN
      const socket = new WebSocket(url, ['caseweave-operators-v1', ...(token ? [`auth.${token}`] : [])])
      this.socket = socket
      socket.addEventListener('open', () => ready(), { once: true })
      socket.addEventListener('message', event => this.receive(String(event.data)))
      const lost = () => { if (this.socket === socket) { this.socket = undefined; this.connection = undefined; this.fail() }
        reject(new RetrievalError('PROVIDER_UNAVAILABLE', 'FastAPI 算子服务连接不可用。', { retryable: true })) }
      socket.addEventListener('close', lost, { once: true }); socket.addEventListener('error', lost, { once: true })
    })
    return this.connection
  }
  private process(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Python 算子工作进程已关闭。')
    if (this.child) return this.child
    const args = ['-m', 'caseweave_ops.server', '--stdio', '--state', this.statePath]
    const child = spawn(this.python ?? 'uv', this.python ? args : ['run', '--frozen', '--inexact', '--project', resolve(this.root, 'python/semantic-operators'), 'python', ...args],
      { cwd: this.root, windowsHide: true, stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        PYTHONPATH: resolve(this.root, 'python/semantic-operators/src') } })
    this.child = child
    child.stderr.on('data', () => { /* stdout owns the protocol; do not expose source-bearing diagnostics */ })
    const fail = () => {
      if (this.child === child) { this.child = undefined; this.fail() }
    }
    child.once('error', fail); child.once('exit', fail)
    child.stdin.on('error', fail)
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => this.receive(line))
    return child
  }
  private receive(line: string): void {
      try {
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error('oversize')
        const frame = JSON.parse(line) as Record<string, unknown>
        const job = typeof frame.job === 'string' ? this.jobs.get(frame.job) : undefined
        if (!job) { if (frame.type === 'error' && !frame.job) throw new Error('invalid frame'); return }
        const id = frame.job as string
        // 独立模型请求可并行；行读取、结果和完成帧仍走单一归并队列。
        if (frame.type === 'request' && frame.method === 'llm.generate') {
          void job.tail.then(async () => {
            try { this.send({ type: 'response', id: frame.id, payload: await job.callback('llm.generate', frame.payload) }) }
            catch (error) { job.failure = error; this.send({ type: 'response', id: frame.id, error: callbackFailure(error) }) }
          }).catch(() => {})
          return
        }
        job.tail = job.tail.then(async () => {
          if (!this.jobs.has(id)) return
          if (frame.type === 'request') {
            if (typeof frame.id !== 'string' || typeof frame.method !== 'string') throw new Error('invalid callback')
            try { this.send({ type: 'response', id: frame.id, payload: await job.callback(frame.method, frame.payload) }) }
            catch (error) { job.failure = error; this.send({ type: 'response', id: frame.id, error: 'host_callback_rejected' }) }
          } else if (frame.type === 'result') await job.result(frame.value)
          else if (frame.type === 'done') { this.jobs.delete(id); job.cleanup(); job.resolve(frame.metrics as Record<string, unknown>) }
          else if (frame.type === 'error') {
            // 模型重试在请求层已经结束；使用该请求的终态错误，不让并发失败相互覆盖。
            const terminalModel = frame.model_failure as ModelFailureCause['modelFailure'] | undefined
            const failure = terminalModel ? modelFailure(terminalModel) : job.failure
            throw new RetrievalError(failure instanceof RetrievalError ? failure.code : 'PROVIDER_UNAVAILABLE',
              failure instanceof RetrievalError ? failure.publicMessage : `Python 算子未完成：${String(frame.error).replace(/[^a-zA-Z_]/g, '')}。`,
              { retryable: !terminalModel && failure instanceof RetrievalError && failure.retryable,
                cause: { operatorUsage: frame.metrics, ...(terminalModel ? { modelFailure: terminalModel } : {}) } })
          }
          else throw new Error('invalid frame type')
        }).catch(error => { this.jobs.delete(id); job.cleanup(); this.send({ type: 'cancel', job: id }); job.reject(error) })
      } catch { this.fail(); this.child?.kill(); this.socket?.close() }
  }
  private send(frame: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame))
    else this.child?.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  async run(input: PythonOperatorRun, callback: Pending['callback'], result: Pending['result'], signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted(); await this.connect(); signal?.throwIfAborted()
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = () => { this.jobs.delete(id); cleanup(); this.send({ type: 'cancel', job: id }); reject(new RetrievalError('CANCELLED', '算子已取消或输入代次已变化。')) }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      this.jobs.set(id, { callback, result, resolve, reject, cleanup, tail: Promise.resolve() })
      signal?.addEventListener('abort', abort, { once: true })
      this.send({ type: 'run', job: id, ...input })
    })
  }
  close(): void { this.closed = true; this.send({ type: 'shutdown' }); this.child?.stdin.end(); this.socket?.close() }
}
