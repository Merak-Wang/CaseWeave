import { createHash } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { RetrievalError } from '@retrieval-agent/contracts'

type Kind = 'candidate' | 'evidence' | 'context'
const tables: Record<Kind, string> = { candidate: 'ra_task_candidate', evidence: 'ra_task_evidence', context: 'ra_task_context' }
export const ARTIFACT_DDL = Object.values(tables).map(table => `CREATE TABLE IF NOT EXISTS ${table} (task_id VARCHAR(64) NOT NULL, content_hash CHAR(64) NOT NULL, identity_key VARCHAR(191) NOT NULL, body_json JSON NOT NULL, PRIMARY KEY(task_id,content_hash), INDEX by_identity(task_id,identity_key))`)
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

/** Immutable content lives once outside state/event JSON. Arrays remain lossless identity relations. */
export async function externalizeArtifacts(connection: PoolConnection, taskId: string, value: unknown): Promise<unknown> {
  const bodies = new Map<string, { kind: Kind; body: unknown; identity: string }>()
  function visit(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(visit)
    if (!object(v)) return v
    const kind: Kind | undefined = typeof v.evidenceId === 'string' && typeof v.text === 'string' ? 'evidence'
      : typeof v.ref === 'string' && typeof v.summary === 'string' && typeof v.snapshotId === 'string' ? 'candidate'
        : typeof v.id === 'string' && typeof v.roleId === 'string' && typeof v.renderedHash === 'string' ? 'context' : undefined
    if (kind) {
      const key = hash(v)
      bodies.set(`${kind}:${key}`, { kind, body: v, identity: String(v.evidenceId ?? v.ref ?? v.id) })
      return { $raArtifact: { kind, hash: key } }
    }
    return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, visit(child)]))
  }
  const encoded = visit(value)
  for (const kind of Object.keys(tables) as Kind[]) {
    const rows = [...bodies.entries()].filter(([, b]) => b.kind === kind)
    for (let offset = 0; offset < rows.length; offset += 150) {
      const batch = rows.slice(offset, offset + 150)
      await connection.query(`INSERT IGNORE INTO ${tables[kind]} (task_id,content_hash,identity_key,body_json) VALUES ${batch.map(() => '(?,?,?,?)').join(',')}`,
        batch.flatMap(([key, b]) => [taskId, key.slice(kind.length + 1), b.identity, JSON.stringify(b.body)]))
    }
  }
  return encoded
}

export async function hydrateArtifacts(query: (sql: string, values: unknown[]) => Promise<unknown>, taskId: string, value: unknown): Promise<unknown> {
  const refs = new Map<Kind, Set<string>>()
  function collect(v: unknown): void {
    if (Array.isArray(v)) { v.forEach(collect); return }
    if (!object(v)) return
    if (object(v.$raArtifact) && Object.keys(v).length === 1) {
      const { kind, hash: key } = v.$raArtifact
      if (typeof kind !== 'string' || !(kind in tables) || typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)) throw new RetrievalError('PROTOCOL_MISMATCH', '持久证据引用无效。')
      const set = refs.get(kind as Kind) ?? new Set(); set.add(key); refs.set(kind as Kind, set)
    } else Object.values(v).forEach(collect)
  }
  collect(value)
  const bodies = new Map<string, unknown>()
  for (const [kind, keys] of refs) {
    const list = [...keys]
    for (let offset = 0; offset < list.length; offset += 500) {
      const batch = list.slice(offset, offset + 500)
      const [rows] = await query(`SELECT content_hash,body_json FROM ${tables[kind]} WHERE task_id=? AND content_hash IN (${batch.map(() => '?').join(',')})`, [taskId, ...batch]) as [RowDataPacket[], unknown]
      for (const row of rows) {
        if (hash(row.body_json) !== row.content_hash) throw new RetrievalError('PROTOCOL_MISMATCH', '持久证据哈希不匹配。')
        bodies.set(`${kind}:${row.content_hash}`, row.body_json)
      }
    }
  }
  function visit(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(visit)
    if (!object(v)) return v
    if (object(v.$raArtifact) && Object.keys(v).length === 1) {
      const body = bodies.get(`${v.$raArtifact.kind}:${v.$raArtifact.hash}`)
      if (!body) throw new RetrievalError('PROTOCOL_MISMATCH', '持久证据正文缺失，不能恢复为已读或确认结果。')
      return body
    }
    return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, visit(child)]))
  }
  return visit(value)
}
