import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { RetrievalState, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { RetrievalController } from '../../domain/src/controller.js'
import { InMemoryRetrievalEventJournal } from '../../domain/src/journal.js'
import { MySqlTaskStore, taskOwner, type TaskJob, type TaskRecord, type CommandReceipt } from './task-store.js'
import { testHybridRanker } from '../../../tests/support/fake-model-gateway.js'

const principal: TrustedPrincipalContext = { tenantId: 'synthetic-queue', subjectId: 'reader',
  purpose: 'ticket_retrieval', entitlementVersion: 'v1', attributes: {}, issuedAt: '2026-10-08T00:00:00Z' }

async function sourceState(fixed: boolean): Promise<RetrievalState> {
  const provider = new LocalTicketProvider([normalizeFixtureTicket({ ticketId: 'synthetic-ticket', displayId: 'SYNTHETIC',
    tenantId: principal.tenantId, allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'synthetic-v1',
    title: '副卡', summary: '合成工单', conversationOrUpdates: [], resolutionSteps: [], errorCodes: [],
    piiRedactionStatus: 'not_applicable' })], { ranker: testHybridRanker() })
  const controller = new RetrievalController(provider, new InMemoryRetrievalEventJournal())
  const state = await controller.start(principal, { target: 'ranked_cases', query: '副卡' })
  return fixed ? { ...state, query: { ...state.query, contract: { ...state.query.contract!,
    semanticExecution: { orchestration: 'fixed', onlineLearning: false, semanticMethod: 'auto' } } } } : state
}

// Double SQL I/O only. Actual public store methods run its transaction,
// command hash, lease and enqueue rules. Never invoke its network constructor.
function memorySql() {
  const task: TaskRecord = { id: 'synthetic-task', session_id: 'synthetic-session', owner_hash: taskOwner(principal),
    original_query: '副卡', event_seq: 0, input_revision: 0, semantic_revision: 0, query_revision: 0,
    state_json: null, failure: null, created_at: new Date('2026-10-08T00:00:00Z') }
  const receipts = new Map<string, { request_hash: string; receipt_json: CommandReceipt }>()
  const queued: { kind: string; revision: number }[] = []
  let running = true
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<[unknown, unknown[]]> => {
    if (sql.startsWith('SELECT * FROM ra_task_command')) return [[receipts.get(String(params[1]))].filter(Boolean), []]
    if (sql.startsWith('SELECT * FROM ra_task WHERE')) return [[task], []]
    if (sql.startsWith('SELECT id FROM ra_task_job')) return [running ? [{ id: 'synthetic-search' }] : [], []]
    if (sql.includes('COUNT(*) AS n')) return [[{ n: 0 }], []]
    if (sql.startsWith('INSERT IGNORE INTO ra_task_job')) queued.push({ kind: String(params[2]), revision: Number(params[3]) })
    if (sql.startsWith('INSERT INTO ra_task_command')) receipts.set(String(params[1]),
      { request_hash: String(params[2]), receipt_json: JSON.parse(String(params[4])) })
    if (sql.startsWith('UPDATE ra_task_job SET status=?')) running = params[0] === 'running'
    return [[], []]
  })
  const connection = { query, beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn() } as unknown as PoolConnection
  const pool = { query, getConnection: vi.fn(async () => connection) } as unknown as Pool
  const store = Object.create(MySqlTaskStore.prototype) as MySqlTaskStore
  Object.assign(store, { pool, ready: Promise.resolve(), learningEnabled: false })
  return { store, task, queued, query }
}

describe('fixed command/queue admission without a database', () => {
  it('a duplicate query operation returns the same receipt and queues only once', async () => {
    const f = memorySql()
    const first = await f.store.create(f.task.id, f.task.session_id, principal, '副卡', 'same-operation',
      { orchestration: 'fixed', onlineLearning: false, semanticMethod: 'auto' })
    const revision = f.task.input_revision
    const repeated = await f.store.create(f.task.id, f.task.session_id, principal, '副卡', 'same-operation',
      { orchestration: 'fixed', onlineLearning: false, semanticMethod: 'auto' })
    expect(repeated).toEqual(first)
    expect(f.task.input_revision).toBe(revision)
    expect(f.queued).toEqual([{ kind: 'search', revision: 1 }])
  })

  it('the same operation ID cannot silently replace its query or execution mode', async () => {
    const f = memorySql()
    await f.store.create(f.task.id, f.task.session_id, principal, '副卡', 'same-operation',
      { orchestration: 'fixed', onlineLearning: false, semanticMethod: 'auto' })
    await expect(f.store.create(f.task.id, f.task.session_id, principal, '另一条查询', 'same-operation'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.queued).toHaveLength(1)
  })

  it.each([true, false])('search completion dispatches fixed=%s and duplicate settlement does not double queue', async fixed => {
    const f = memorySql()
    f.task.state_json = await sourceState(fixed)
    const job: TaskJob = { id: 'synthetic-search', task_id: f.task.id, kind: 'search', input_revision: 0,
      fence: 1, owner: 'synthetic-worker', attempts: 1, status: 'running' }
    await f.store.settle(job)
    expect(f.queued.map(j => j.kind)).toEqual([fixed ? 'fixed' : 'agent'])
    await expect(f.store.settle(job)).rejects.toMatchObject({ code: 'INVALID_TRANSITION', retryable: true })
    expect(f.queued).toHaveLength(1)
  })

  it('obsolete input revision neither settles nor queues a continuation', async () => {
    const f = memorySql()
    f.task.state_json = await sourceState(true)
    f.task.input_revision = 2
    const job: TaskJob = { id: 'synthetic-search', task_id: f.task.id, kind: 'search', input_revision: 1,
      fence: 1, owner: 'synthetic-worker', attempts: 1, status: 'running' }
    await f.store.settle(job)
    expect(f.queued).toHaveLength(0)
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE ra_task_job SET status=?'))).toBe(false)
  })

  it('a stopped task does not acquire a fixed continuation', async () => {
    const f = memorySql()
    const state = await sourceState(true)
    const controller = new RetrievalController({} as never, new InMemoryRetrievalEventJournal())
    f.task.state_json = controller.stop(state, 'cancelled')
    const job: TaskJob = { id: 'synthetic-search', task_id: f.task.id, kind: 'search', input_revision: 0,
      fence: 1, owner: 'synthetic-worker', attempts: 1, status: 'running' }
    await f.store.settle(job)
    expect(f.queued).toHaveLength(0)
  })
})
