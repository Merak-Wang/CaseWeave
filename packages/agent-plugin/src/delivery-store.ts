import { createHash } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import { RetrievalError } from '@retrieval-agent/contracts'
import { MySqlTaskStore, type TaskRecord } from './task-store.js'

export interface DeliverySpec { kind: 'csv' | 'jsonl' | 'report'; template: 'summary' | 'full'; audience: 'operator' | 'handoff'; resultRevision: string }
export interface DeliveryRecord {
  id: string; task_id: string; operation_id: string; request_hash: string; spec_json: DeliverySpec;
  status: 'queued' | 'running' | 'ready' | 'failed'; fence: number; owner: string; attempts: number;
  row_count: number; byte_count: number; part_count: number; content_sha256: string | null;
  meta_json: Record<string, any> | null; error: string | null; expires_at: Date; lease_until: Date | null;
}
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex')
export const DELIVERY_DDL = [
  `CREATE TABLE IF NOT EXISTS ra_delivery (id VARCHAR(64) PRIMARY KEY, task_id VARCHAR(64) NOT NULL, operation_id VARCHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL, spec_json JSON NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'queued', fence INT NOT NULL DEFAULT 0, owner VARCHAR(64) NOT NULL DEFAULT '', attempts INT NOT NULL DEFAULT 0, row_count INT NOT NULL DEFAULT 0, byte_count BIGINT NOT NULL DEFAULT 0, part_count INT NOT NULL DEFAULT 0, content_sha256 CHAR(64) NULL, meta_json JSON NULL, error TEXT NULL, lease_until TIMESTAMP(3) NULL, expires_at TIMESTAMP(3) NOT NULL, UNIQUE by_command(task_id,operation_id), INDEX runnable(status,lease_until))`,
  `CREATE TABLE IF NOT EXISTS ra_delivery_chunk (delivery_id VARCHAR(64) NOT NULL, fence INT NOT NULL, part INT NOT NULL, body MEDIUMBLOB NOT NULL, PRIMARY KEY(delivery_id,fence,part))`,
  `CREATE TABLE IF NOT EXISTS ra_delivery_trace (delivery_id VARCHAR(64) NOT NULL, fence INT NOT NULL, stage VARCHAR(64) NOT NULL, data_json JSON NOT NULL, PRIMARY KEY(delivery_id,fence,stage))`,
]

/** Durable staging, lease fencing and publication. No Provider/model I/O inside transactions. */
export class MySqlDeliveryStore {
  readonly ready: Promise<void>
  constructor(readonly tasks: MySqlTaskStore) { this.ready = (async () => { await tasks.ready; for (const ddl of DELIVERY_DDL) await tasks.pool.query(`${ddl} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`) })() }
  private async tx<T>(work: (c: PoolConnection) => Promise<T>): Promise<T> {
    await this.ready; const c = await this.tasks.pool.getConnection()
    try { await c.beginTransaction(); const result = await work(c); await c.commit(); return result }
    catch (error) { await c.rollback(); throw error } finally { c.release() }
  }
  private async locked(c: PoolConnection, id: string): Promise<DeliveryRecord> {
    const d = (await this.tasks.rows<DeliveryRecord>('SELECT * FROM ra_delivery WHERE id=? FOR UPDATE', [id], c))[0]
    if (!d) throw new RetrievalError('INVALID_REQUEST', '下载工件不存在。')
    return d
  }
  private async current(c: PoolConnection, d: DeliveryRecord): Promise<void> {
    const t = (await this.tasks.rows<TaskRecord>('SELECT * FROM ra_task WHERE id=? FOR UPDATE', [d.task_id], c))[0]
    const s = t?.state_json
    if (!s || s.phase !== 'stopped' || (s.frozenEvidence?.packId ?? s.stateId) !== d.spec_json.resultRevision
      || ['snapshot_invalid', 'permission_blocked'].includes(s.termination)) throw new RetrievalError('INVALID_TRANSITION', '确认结果已变化，请重新复核并生成新工件。')
  }
  private fence(d: DeliveryRecord, job: DeliveryRecord): void {
    if (d.status !== 'running' || d.fence !== job.fence || d.owner !== job.owner || !d.lease_until || d.lease_until.getTime() <= Date.now()) throw new RetrievalError('INVALID_TRANSITION', '下载作业执行权已变化。')
  }
  async create(taskId: string, operationId: string, spec: DeliverySpec, retry = false): Promise<DeliveryRecord> {
    return this.tx(async c => {
      const id = hash([taskId, operationId]).slice(0, 48)
      await c.query('INSERT IGNORE INTO ra_delivery(id,task_id,operation_id,request_hash,spec_json,expires_at) VALUES (?,?,?,?,?,?)', [id, taskId, operationId, hash(spec), JSON.stringify(spec), new Date(Date.now() + 7 * 86400000)])
      const d = await this.locked(c, id)
      if (d.request_hash !== hash(spec)) throw new RetrievalError('INVALID_REQUEST', '幂等键已用于不同的下载或报告。')
      if (d.expires_at.getTime() <= Date.now()) throw new RetrievalError('INVALID_TRANSITION', '工件已到期，请重新申请。')
      await this.current(c, d)
      if (retry && d.status === 'failed') { d.status = 'queued'; await c.query("UPDATE ra_delivery SET status='queued',attempts=0,error=NULL WHERE id=?", [id]) }
      return d
    })
  }
  async read(id: string): Promise<DeliveryRecord | undefined> { await this.ready; return (await this.tasks.rows<DeliveryRecord>('SELECT * FROM ra_delivery WHERE id=?', [id]))[0] }
  async list(taskId: string): Promise<DeliveryRecord[]> { await this.ready; return this.tasks.rows<DeliveryRecord>('SELECT * FROM ra_delivery WHERE task_id=? ORDER BY expires_at DESC LIMIT 20', [taskId]) }
  async claim(owner: string, leaseMs = 15000): Promise<DeliveryRecord | undefined> {
    return this.tx(async c => {
      const d = (await this.tasks.rows<DeliveryRecord>("SELECT * FROM ra_delivery WHERE expires_at>CURRENT_TIMESTAMP(3) AND (status='queued' OR (status='running' AND lease_until<CURRENT_TIMESTAMP(3))) ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED", [], c))[0]
      if (!d) return undefined
      if (d.attempts >= 3) { await c.query("UPDATE ra_delivery SET status='failed',error='多次执行中断，请重试生成。' WHERE id=?", [d.id]); return undefined }
      d.fence++; d.attempts++; d.owner = owner; d.status = 'running'; d.row_count = 0; d.byte_count = 0; d.part_count = 0
      await c.query("UPDATE ra_delivery SET fence=?,attempts=?,owner=?,status='running',row_count=0,byte_count=0,part_count=0,meta_json=NULL,content_sha256=NULL,error=NULL,lease_until=? WHERE id=?", [d.fence, d.attempts, owner, new Date(Date.now() + leaseMs), d.id])
      // Unpublished chunks from interrupted attempts are never served.
      await c.query('DELETE FROM ra_delivery_chunk WHERE delivery_id=?', [d.id])
      return d
    })
  }
  async renew(job: DeliveryRecord, leaseMs = 15000): Promise<void> {
    await this.tx(async c => { const d = await this.locked(c, job.id); this.fence(d, job); await this.current(c, d); await c.query('UPDATE ra_delivery SET lease_until=? WHERE id=?', [new Date(Date.now() + leaseMs), d.id]) })
  }
  async append(job: DeliveryRecord, content: string | Uint8Array, rows: number): Promise<void> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    if (bytes.length > 2_000_000) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '单个下载分块超过大小限制。')
    await this.tx(async c => {
      const d = await this.locked(c, job.id); this.fence(d, job); await this.current(c, d)
      await c.query('INSERT INTO ra_delivery_chunk(delivery_id,fence,part,body) VALUES (?,?,?,?)', [d.id, d.fence, d.part_count, bytes])
      await c.query('UPDATE ra_delivery SET part_count=part_count+1,byte_count=byte_count+?,row_count=? WHERE id=?', [bytes.length, rows, d.id])
    })
  }
  async publish(job: DeliveryRecord, sha256: string, meta: Record<string, unknown>): Promise<void> {
    await this.tx(async c => { const d = await this.locked(c, job.id); this.fence(d, job); await this.current(c, d)
      await c.query("UPDATE ra_delivery SET status='ready',content_sha256=?,meta_json=?,lease_until=NULL WHERE id=?", [sha256, JSON.stringify(meta), d.id]) })
  }
  async fail(job: DeliveryRecord, message: string): Promise<void> {
    await this.tx(async c => { const d = await this.locked(c, job.id); if (d.fence !== job.fence || d.owner !== job.owner || d.status !== 'running') return
      await c.query("UPDATE ra_delivery SET status='failed',error=?,lease_until=NULL WHERE id=?", [message, d.id]) })
  }
  async release(job: DeliveryRecord): Promise<void> {
    await this.tasks.pool.query("UPDATE ra_delivery SET status='queued',fence=fence+1,lease_until=NULL WHERE id=? AND fence=? AND owner=? AND status='running'", [job.id, job.fence, job.owner])
  }
  async trace(job: DeliveryRecord, stage: string, data: unknown): Promise<void> {
    await this.tx(async c => { const d = await this.locked(c, job.id); this.fence(d, job); await this.current(c, d)
      await c.query('INSERT INTO ra_delivery_trace(delivery_id,fence,stage,data_json) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE data_json=VALUES(data_json)', [job.id, job.fence, stage, JSON.stringify(data)]) })
  }
  async *chunks(d: DeliveryRecord): AsyncGenerator<Buffer> {
    for (let part = 0; part < d.part_count; part++) {
      const row = (await this.tasks.rows<{ body: Buffer }>('SELECT body FROM ra_delivery_chunk WHERE delivery_id=? AND fence=? AND part=?', [d.id, d.fence, part]))[0]
      if (!row) throw new RetrievalError('PROTOCOL_MISMATCH', '下载工件分块缺失。')
      yield row.body
    }
  }
}
