import { createHash, randomUUID } from 'node:crypto'
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { RetrievalError, makeRetrievalEvent, type RetrievalState, type RetrievalDomainEvent, type RetrievalEventType,
  type RetrievalEventDataMap, type RetrievalId, type TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { RetrievalController, migrateProjectionState, type RetrievalEventJournal, type RetrievalClarificationAnswer } from '@retrieval-agent/domain'
import { ARTIFACT_DDL, externalizeArtifacts, hydrateArtifacts } from './artifact-store.js'

export type TaskCommand = { kind: 'query'; text: string }
  | { kind: 'supplement'; text: string; information: RetrievalClarificationAnswer }
  | { kind: 'feedback'; text: string; candidateRef: string; relevance: 'related' | 'unrelated' }
  | { kind: 'answer'; text: string; questionId: string; information: RetrievalClarificationAnswer }
  | { kind: 'cancel' }
export interface TaskRecord {
  id: string; session_id: string; owner_hash: string; original_query: string; event_seq: number;
  input_revision: number; semantic_revision: number; query_revision: number;
  state_json: RetrievalState | null; failure: string | null; created_at: Date;
}
export interface TaskJob { id: string; task_id: string; kind: 'search' | 'agent' | 'page' | 'learn' | 'unlearn' | 'source_check'; input_revision: number;
  fence: number; owner: string; attempts: number; status: string }
export interface TaskEvent { seq: number; kind: string; data: unknown }
export interface CommandReceipt { taskId: string; operationId: string; eventSeq: number; inputRevision: number; status: 'accepted' }
const json = (value: unknown): string => JSON.stringify(value)
const hash = (value: unknown): string => createHash('sha256').update(json(value)).digest('hex')
const commandHash = (command: TaskCommand): string => {
  const { information: _compiledAtAdmission, ...wire } = command as TaskCommand & { information?: RetrievalClarificationAnswer }
  return hash(wire)
}
export const taskOwner = (p: TrustedPrincipalContext): string => hash([p.tenantId, p.subjectId])
export const staleTask = (): RetrievalError => new RetrievalError('INVALID_TRANSITION', '任务已收到新的信息或执行权已失效，请读取最新状态后重试。', { retryable: true })
export const isLearningResult = (state: RetrievalState): boolean => state.phase === 'stopped'
  && (state.termination === 'top_k_accepted' || state.termination === 'no_result')
  && state.accessValidation === 'current' && Boolean(state.frozenEvidence)

/** Per-operation buffer: no Session event becomes visible before its MySQL transaction commits. */
export class TaskJournal implements RetrievalEventJournal {
  readonly pending: RetrievalDomainEvent[] = []
  constructor(readonly previous: readonly RetrievalDomainEvent[] = [], readonly sequenceBase = previous.length) {}
  append<T extends RetrievalEventType>(retrievalId: RetrievalId, type: T, data: RetrievalEventDataMap[T]): RetrievalDomainEvent<T> {
    const event = makeRetrievalEvent({ eventId: randomUUID(), retrievalId, sequence: this.sequenceBase + this.pending.length,
      occurredAt: new Date().toISOString(), type, data })
    this.pending.push(event)
    return event
  }
  read(id: RetrievalId): readonly RetrievalDomainEvent[] { return [...this.previous, ...this.pending].filter(e => e.retrievalId === id) }
}

const DDL = [
  ...ARTIFACT_DDL,
  `CREATE TABLE IF NOT EXISTS ra_task (id VARCHAR(64) PRIMARY KEY, session_id VARCHAR(191) NOT NULL, owner_hash CHAR(64) NOT NULL, original_query TEXT NOT NULL, event_seq BIGINT NOT NULL DEFAULT 0, input_revision INT NOT NULL DEFAULT 0, semantic_revision INT NOT NULL DEFAULT 0, query_revision INT NOT NULL DEFAULT 0, state_json JSON NULL, failure TEXT NULL, created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3))`,
  `CREATE TABLE IF NOT EXISTS ra_task_event (task_id VARCHAR(64) NOT NULL, seq BIGINT NOT NULL, kind VARCHAR(100) NOT NULL, data_json JSON NOT NULL, PRIMARY KEY(task_id,seq))`,
  `CREATE TABLE IF NOT EXISTS ra_task_command (task_id VARCHAR(64) NOT NULL, operation_id VARCHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL, command_json JSON NOT NULL, receipt_json JSON NOT NULL, PRIMARY KEY(task_id,operation_id))`,
  `CREATE TABLE IF NOT EXISTS ra_task_outbox (task_id VARCHAR(64) NOT NULL, seq BIGINT NOT NULL, delivered BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(task_id,seq))`,
  `CREATE TABLE IF NOT EXISTS ra_task_job (id VARCHAR(64) PRIMARY KEY, task_id VARCHAR(64) NOT NULL, kind VARCHAR(16) NOT NULL, input_revision INT NOT NULL, status VARCHAR(16) NOT NULL, fence BIGINT NOT NULL DEFAULT 0, owner VARCHAR(64) NOT NULL DEFAULT '', lease_until TIMESTAMP(3) NULL, available_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), attempts INT NOT NULL DEFAULT 0, error TEXT NULL, UNIQUE job_once(task_id,kind,input_revision), INDEX runnable(status,available_at,lease_until))`,
  `CREATE TABLE IF NOT EXISTS ra_task_question (id VARCHAR(191) PRIMARY KEY, task_id VARCHAR(64) NOT NULL, question_json JSON NOT NULL, answered BOOLEAN NOT NULL DEFAULT FALSE)`,
  `CREATE TABLE IF NOT EXISTS ra_wiki_learning (task_id VARCHAR(64) NOT NULL, input_revision INT NOT NULL, status VARCHAR(32) NOT NULL, result_revision VARCHAR(191) NULL, release_id VARCHAR(100) NULL, details_json JSON NOT NULL, PRIMARY KEY(task_id,input_revision))`,
]

/** MySQL is the only product authority. Transactions contain no Provider, DSH or network work. */
export class MySqlTaskStore {
  readonly pool: Pool
  readonly ready: Promise<void>
  constructor(url = process.env.RETRIEVAL_AGENT_MYSQL_URL ?? 'mysql://root@127.0.0.1:13306/retrieval_agent', readonly learningEnabled = false) {
    this.pool = createPool({ uri: url, connectionLimit: 8, charset: 'utf8mb4_bin', timezone: 'Z' })
    this.ready = this.migrate()
  }
  private async migrate(): Promise<void> {
    for (const ddl of DDL) await this.pool.query(`${ddl} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  }
  async close(): Promise<void> { await this.ready; await this.pool.end() }
  async rows<T>(sql: string, params: unknown[] = [], c: Pool | PoolConnection = this.pool): Promise<T[]> {
    const [rows] = await c.query<RowDataPacket[]>(sql, params); return rows as T[]
  }
  private async transaction<T>(work: (c: PoolConnection) => Promise<T>): Promise<T> {
    await this.ready
    const c = await this.pool.getConnection()
    try { await c.beginTransaction(); const result = await work(c); await c.commit(); return result }
    catch (error) { await c.rollback(); throw error } finally { c.release() }
  }
  async read(id: string): Promise<TaskRecord | undefined> {
    await this.ready; return this.hydrateTask((await this.rows<TaskRecord>('SELECT * FROM ra_task WHERE id=?', [id]))[0])
  }
  async forSession(id: string): Promise<TaskRecord | undefined> {
    await this.ready
    // Sorting a complete JSON projection can exceed MySQL's sort buffer even for one large task.
    const task = (await this.rows<{ id: string }>('SELECT id FROM ra_task WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [id]))[0]
    return task ? this.read(task.id) : undefined
  }
  private async hydrateTask(task: TaskRecord | undefined, c: Pool | PoolConnection = this.pool): Promise<TaskRecord | undefined> {
    if (!task?.state_json) return task
    return { ...task, state_json: migrateProjectionState(await hydrateArtifacts((sql, values) => c.query(sql, values), task.id, task.state_json) as RetrievalState) }
  }
  private async lock(c: PoolConnection, id: string): Promise<TaskRecord> {
    const task = (await this.rows<TaskRecord>('SELECT * FROM ra_task WHERE id=? FOR UPDATE', [id], c))[0]
    if (!task) throw new RetrievalError('INVALID_REQUEST', '任务不存在。')
    return (await this.hydrateTask(task, c))!
  }
  private async append(c: PoolConnection, task: TaskRecord, kind: string, data: unknown): Promise<void> {
    task.event_seq++
    await c.query('INSERT INTO ra_task_event(task_id,seq,kind,data_json) VALUES (?,?,?,?)', [task.id, task.event_seq, kind, json(await externalizeArtifacts(c, task.id, data))])
    await c.query('INSERT INTO ra_task_outbox(task_id,seq) VALUES (?,?)', [task.id, task.event_seq])
  }
  private async save(c: PoolConnection, t: TaskRecord): Promise<void> {
    await c.query('UPDATE ra_task SET event_seq=?,input_revision=?,semantic_revision=?,query_revision=?,state_json=?,failure=? WHERE id=?',
      [t.event_seq, t.input_revision, t.semantic_revision, t.query_revision, t.state_json ? json(await externalizeArtifacts(c, t.id, t.state_json)) : null, t.failure, t.id])
  }
  private async enqueue(c: PoolConnection, task: TaskRecord, kind: TaskJob['kind']): Promise<void> {
    await c.query('INSERT IGNORE INTO ra_task_job(id,task_id,kind,input_revision,status) VALUES (?,?,?,?,?)',
      [randomUUID(), task.id, kind, task.input_revision, 'queued'])
  }
  async create(id: string, sessionId: string, principal: TrustedPrincipalContext, text: string, operationId = id): Promise<CommandReceipt> {
    return this.transaction(async c => {
      await c.query('INSERT IGNORE INTO ra_task(id,session_id,owner_hash,original_query) VALUES (?,?,?,?)', [id, sessionId, taskOwner(principal), text])
      const task = await this.lock(c, id)
      return this.accept(c, task, principal, operationId, { kind: 'query', text })
    })
  }
  async submit(id: string, principal: TrustedPrincipalContext, operationId: string, command: Exclude<TaskCommand, { kind: 'query' }>): Promise<CommandReceipt> {
    return this.transaction(async c => this.accept(c, await this.lock(c, id), principal, operationId, command))
  }
  private async accept(c: PoolConnection, task: TaskRecord, principal: TrustedPrincipalContext, operationId: string, command: TaskCommand): Promise<CommandReceipt> {
    if (task.owner_hash !== taskOwner(principal)) throw new RetrievalError('UNAUTHORIZED', '当前身份无权访问此任务。')
    const previous = (await this.rows<{ request_hash: string; receipt_json: CommandReceipt }>('SELECT * FROM ra_task_command WHERE task_id=? AND operation_id=?', [task.id, operationId], c))[0]
    if (previous) {
      if (previous.request_hash !== commandHash(command)) throw new RetrievalError('INVALID_REQUEST', '幂等键已用于不同的命令。')
      return previous.receipt_json
    }
    if (command.kind === 'query' && task.event_seq !== 0) throw new RetrievalError('INVALID_TRANSITION', '此任务已经接收查询。')
    if (command.kind === 'answer') {
      const question = (await this.rows<{ id: string }>('SELECT id FROM ra_task_question WHERE task_id=? AND id=? AND answered=FALSE', [task.id, command.questionId], c))[0]
      if (!question || task.state_json?.phase !== 'awaiting_clarification') throw new RetrievalError('INVALID_TRANSITION', '问题已变化或已经回答，请读取当前问题。')
      await c.query('UPDATE ra_task_question SET answered=TRUE WHERE id=?', [command.questionId])
    }
    if (command.kind === 'feedback' && !task.state_json?.candidates.some(candidate => candidate.ref === command.candidateRef)) {
      throw new RetrievalError('INVALID_REQUEST', '反馈候选不属于当前任务集合。')
    }
    if (command.kind !== 'query' && command.kind !== 'answer') {
      await c.query('UPDATE ra_task_question SET answered=TRUE WHERE task_id=? AND answered=FALSE', [task.id])
    }
    const hard = (command.kind === 'supplement' || command.kind === 'answer') && Boolean(command.information.filters?.length)
    task.input_revision++; task.semantic_revision++; if (hard || command.kind === 'query') task.query_revision++
    task.failure = null
    await this.append(c, task, 'command/accepted', { operationId, command })
    if (task.state_json && command.kind !== 'query') {
      const journal = new TaskJournal([], await this.domainEventCount(task.id, c))
      // These transitions only validate already bound identities and alter task data. No Provider I/O.
      const controller = new RetrievalController({} as ConstructorParameters<typeof RetrievalController>[0], journal)
      task.state_json = command.kind === 'cancel' ? controller.stop(task.state_json, 'cancelled')
        : controller.acceptUserInformation(task.state_json, command.kind === 'feedback'
          ? { accepted: true, answer: `用户标记工单 ${command.candidateRef} 为${command.relevance === 'related' ? '相关' : '不相关'}。${command.text}` }
          : command.information, command.kind === 'answer')
      for (const event of journal.pending) await this.append(c, task, event.type, event)
    }
    // Fence every old worker immediately; a cancelled HTTP/model call may still return later.
    await c.query("UPDATE ra_task_job SET status='superseded',fence=fence+1 WHERE task_id=? AND status IN ('queued','running','waiting')", [task.id])
    if (this.learningEnabled && command.kind !== 'query') await this.enqueue(c, task, 'unlearn')
    if (command.kind !== 'cancel') {
      const state = task.state_json
      const needsSearch = !state || hard || !state.lastPage || state.searchProgress?.channels.some(channel => channel.status === 'running')
      await this.enqueue(c, task, needsSearch ? 'search' : 'agent')
    }
    const receipt: CommandReceipt = { taskId: task.id, operationId, eventSeq: task.event_seq, inputRevision: task.input_revision, status: 'accepted' }
    await c.query('INSERT INTO ra_task_command(task_id,operation_id,request_hash,command_json,receipt_json) VALUES (?,?,?,?,?)',
      [task.id, operationId, commandHash(command), json(command), json(receipt)])
    await this.save(c, task)
    return receipt
  }
  async commands(id: string): Promise<TaskCommand[]> {
    return (await this.rows<{ data_json: { command: TaskCommand } }>("SELECT data_json FROM ra_task_event WHERE task_id=? AND kind='command/accepted' ORDER BY seq LIMIT 10000", [id])).map(e => e.data_json.command)
  }
  async domainEventCount(id: string, c: Pool | PoolConnection = this.pool): Promise<number> {
    return Number((await this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM ra_task_event WHERE task_id=? AND kind LIKE 'retrieval/%'", [id], c))[0]!.n)
  }
  async domainEvents(id: string, c: Pool | PoolConnection = this.pool, afterSequence = -1): Promise<RetrievalDomainEvent[]> {
    const events = (await this.rows<{ data_json: RetrievalDomainEvent }>("SELECT data_json FROM ra_task_event WHERE task_id=? AND kind LIKE 'retrieval/%' AND JSON_EXTRACT(data_json,'$.sequence')>? ORDER BY seq", [id, afterSequence], c)).map(r => r.data_json)
    return await hydrateArtifacts((sql, values) => c.query(sql, values), id, events) as RetrievalDomainEvent[]
  }
  async events(id: string, after = 0, limit = 100): Promise<TaskEvent[]> {
    await this.ready
    const events = (await this.rows<{ seq: number; kind: string; data_json: unknown }>('SELECT seq,kind,data_json FROM ra_task_event WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?', [id, after, limit])).map(e => ({ seq: e.seq, kind: e.kind, data: e.data_json }))
    return await hydrateArtifacts((sql, values) => this.pool.query(sql, values), id, events) as TaskEvent[]
  }
  async commit(base: TaskRecord, state: RetrievalState, events: readonly RetrievalDomainEvent[], job?: TaskJob, semantic = true): Promise<TaskRecord> {
    return this.transaction(async c => {
      const task = await this.lock(c, base.id)
      if (task.input_revision !== base.input_revision || task.state_json?.stateId !== base.state_json?.stateId) throw staleTask()
      if (job) await this.assertLease(c, job)
      task.state_json = state
      if (semantic) task.semantic_revision++
      const count = await this.domainEventCount(task.id, c)
      for (const [i, event] of events.entries()) await this.append(c, task, event.type, { ...event, sequence: Number(count) + i })
      if (state.phase === 'awaiting_clarification' && state.clarification) {
        // stateId at the question transition is an immutable question identity.
        const existing = await this.rows<{ id: string }>('SELECT id FROM ra_task_question WHERE task_id=? AND answered=FALSE', [task.id], c)
        if (!existing.length) await c.query('INSERT INTO ra_task_question(id,task_id,question_json) VALUES (?,?,?)', [state.stateId, task.id, json(state.clarification)])
      }
      if (this.learningEnabled && isLearningResult(state)) await this.enqueue(c, task, 'learn')
      await this.save(c, task); return task
    })
  }
  async question(id: string): Promise<{ id: string; question_json: unknown } | undefined> {
    return (await this.rows<{ id: string; question_json: unknown }>('SELECT id,question_json FROM ra_task_question WHERE task_id=? AND answered=FALSE', [id]))[0]
  }
  async claim(owner: string, leaseMs = 15000, excluded: readonly string[] = [], excludeLearning = false): Promise<TaskJob | undefined> {
    return this.transaction(async c => {
      const job = (await this.rows<TaskJob>(`SELECT j.* FROM ra_task_job j JOIN ra_task t ON t.id=j.task_id AND t.input_revision=j.input_revision
        WHERE ((j.status='queued' AND j.available_at<=CURRENT_TIMESTAMP(3)) OR (j.status='running' AND j.lease_until<CURRENT_TIMESTAMP(3)))
        ${excluded.length ? 'AND t.session_id NOT IN (SELECT session_id FROM ra_task WHERE id IN (?))' : ''}
        ${excludeLearning ? "AND j.kind <> 'learn'" : ''}
        ORDER BY CASE j.kind WHEN 'unlearn' THEN 0 WHEN 'learn' THEN 2 WHEN 'source_check' THEN 3 ELSE 1 END,j.available_at LIMIT 1 FOR UPDATE SKIP LOCKED`, excluded.length ? [[...excluded]] : [], c))[0]
      if (!job) return undefined
      job.fence++; job.attempts++; job.owner = owner; job.status = 'running'
      await c.query("UPDATE ra_task_job SET status='running',owner=?,fence=?,attempts=?,lease_until=TIMESTAMPADD(MICROSECOND,?,CURRENT_TIMESTAMP(3)) WHERE id=?",
        [owner, job.fence, job.attempts, leaseMs * 1000, job.id])
      return job
    })
  }
  private async assertLease(c: PoolConnection, job: TaskJob): Promise<void> {
    const valid = await this.rows<{ id: string }>("SELECT id FROM ra_task_job WHERE id=? AND status='running' AND owner=? AND fence=? AND lease_until>CURRENT_TIMESTAMP(3) FOR UPDATE", [job.id, job.owner, job.fence], c)
    if (!valid.length) throw staleTask()
  }
  async renew(job: TaskJob, leaseMs = 15000): Promise<boolean> {
    const [result] = await this.pool.query<import('mysql2').ResultSetHeader>("UPDATE ra_task_job SET lease_until=TIMESTAMPADD(MICROSECOND,?,CURRENT_TIMESTAMP(3)) WHERE id=? AND status='running' AND owner=? AND fence=? AND lease_until>CURRENT_TIMESTAMP(3)", [leaseMs * 1000, job.id, job.owner, job.fence])
    return result.affectedRows === 1
  }
  async release(job: TaskJob): Promise<void> {
    await this.pool.query("UPDATE ra_task_job SET status='queued',fence=fence+1,lease_until=NULL,available_at=CURRENT_TIMESTAMP(3) WHERE id=? AND status='running' AND owner=? AND fence=?", [job.id, job.owner, job.fence])
  }
  async settle(job: TaskJob, error?: string, retryable = false): Promise<void> {
    await this.transaction(async c => {
      const task = await this.lock(c, job.task_id)
      if (task.input_revision !== job.input_revision) return
      await this.assertLease(c, job)
      const status = error ? retryable && job.attempts < 3 ? 'queued' : 'failed'
        : job.kind === 'agent' && task.state_json?.phase === 'awaiting_clarification' ? 'waiting' : 'completed'
      await c.query('UPDATE ra_task_job SET status=?,error=?,lease_until=NULL,available_at=TIMESTAMPADD(SECOND,?,CURRENT_TIMESTAMP(3)) WHERE id=?', [status, error ?? null, job.kind === 'source_check' ? 60 : job.attempts, job.id])
      await this.append(c, task, `job/${status}`, { id: job.id, kind: job.kind, attempts: job.attempts, ...(error ? { error } : {}) })
      if (status === 'failed' && !['learn', 'unlearn', 'source_check'].includes(job.kind)) task.failure = error ?? '后台任务失败。'
      if (status === 'completed' && job.kind === 'search' && task.state_json?.phase !== 'stopped') await this.enqueue(c, task, 'agent')
      if (status === 'waiting' && task.state_json?.lastPage?.nextCursor) await this.enqueue(c, task, 'page')
      await this.save(c, task)
    })
  }
  /** Periodic source checks are durable jobs; a restart neither loses nor doubles them. */
  async scheduleSourceChecks(): Promise<void> {
    if (!this.learningEnabled) return
    await this.ready
    await this.pool.query(`INSERT IGNORE INTO ra_task_job(id,task_id,kind,input_revision,status)
      SELECT UUID(),t.id,'source_check',t.input_revision,'queued' FROM ra_wiki_learning l
      JOIN ra_task t ON t.id=l.task_id AND t.input_revision=l.input_revision WHERE l.status='published'`)
    await this.pool.query(`UPDATE ra_task_job j JOIN ra_wiki_learning l ON l.task_id=j.task_id AND l.input_revision=j.input_revision
      SET j.status='queued',j.attempts=0 WHERE j.kind='source_check' AND j.status IN ('completed','failed')
      AND j.available_at<=CURRENT_TIMESTAMP(3) AND l.status='published'`)
  }
  /** Files are staged/validated outside this transaction. Only the pointer rename holds the source fence. */
  async commitLearning(job: TaskJob, resultRevision: string | undefined, status: string, details: Record<string, unknown>,
    publication?: { releaseId: string; commit(): Promise<void> }): Promise<void> {
    await this.transaction(async c => {
      const task = await this.lock(c, job.task_id)
      if (task.input_revision !== job.input_revision) throw staleTask()
      await this.assertLease(c, job)
      if (resultRevision && (!task.state_json || task.state_json.frozenEvidence?.packId !== resultRevision || !isLearningResult(task.state_json))) throw staleTask()
      await publication?.commit()
      await c.query('INSERT INTO ra_wiki_learning(task_id,input_revision,status,result_revision,release_id,details_json) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),result_revision=VALUES(result_revision),release_id=VALUES(release_id),details_json=VALUES(details_json)',
        [task.id, task.input_revision, status, resultRevision ?? null, publication?.releaseId ?? null, json(details)])
      await this.append(c, task, `wiki/${status}`, { inputRevision: task.input_revision, ...(publication ? { releaseId: publication.releaseId } : {}), reason: details.reason })
      await this.save(c, task)
    })
  }
  async learningRecords(id: string): Promise<{ input_revision: number; status: string; release_id: string | null; details_json: Record<string, unknown> }[]> {
    await this.ready
    return this.rows('SELECT input_revision,status,release_id,details_json FROM ra_wiki_learning WHERE task_id=? ORDER BY input_revision DESC', [id])
  }
  async learningStatus(id: string): Promise<{ status: string; releaseId?: string; reason?: string } | undefined> {
    const jobs = await this.rows<{ status: string; error: string | null }>("SELECT j.status,j.error FROM ra_task_job j JOIN ra_task t ON t.id=j.task_id AND t.input_revision=j.input_revision WHERE j.task_id=? AND j.kind='learn'", [id])
    const job = jobs[0]
    if (!job) return undefined
    if (['queued', 'running', 'failed'].includes(job.status)) return { status: job.status, ...(job.error ? { reason: job.error } : {}) }
    const record = (await this.learningRecords(id))[0]
    return record ? { status: record.status, ...(record.release_id ? { releaseId: record.release_id } : {}),
      ...(typeof record.details_json.reason === 'string' ? { reason: record.details_json.reason } : {}) } : { status: job.status }
  }
  async pendingOutbox(id: string): Promise<TaskEvent[]> {
    const events = (await this.rows<{ seq: number; kind: string; data_json: unknown }>('SELECT e.seq,e.kind,e.data_json FROM ra_task_outbox o JOIN ra_task_event e ON e.task_id=o.task_id AND e.seq=o.seq WHERE o.task_id=? AND o.delivered=FALSE ORDER BY o.seq LIMIT 200', [id])).map(e => ({ seq: e.seq, kind: e.kind, data: e.data_json }))
    return await hydrateArtifacts((sql, values) => this.pool.query(sql, values), id, events) as TaskEvent[]
  }
  async delivered(id: string, seq: number): Promise<void> { await this.pool.query('UPDATE ra_task_outbox SET delivered=TRUE WHERE task_id=? AND seq<=?', [id, seq]) }
  async pendingSessions(): Promise<string[]> {
    await this.ready
    return (await this.rows<{ session_id: string }>("SELECT DISTINCT t.session_id FROM ra_task t LEFT JOIN ra_task_job j ON j.task_id=t.id LEFT JOIN ra_task_outbox o ON o.task_id=t.id WHERE j.status IN ('queued','running') OR o.delivered=FALSE")).map(t => t.session_id)
  }
}
