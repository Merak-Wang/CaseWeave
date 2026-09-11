import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { makeRetrievalEvent, RetrievalId } from '@retrieval-agent/contracts'
import { expect, it } from 'vitest'
import { decodeSessionFrames, migrateSessionDirectory } from './migration-files.js'
import { readRetrievalSessionEvents } from './session-events.js'

const id = SessionId('migration-fixture')
const product = makeRetrievalEvent({ eventId: 'stable-event', retrievalId: RetrievalId('old-task'), sequence: 0,
  occurredAt: '2026-09-10T00:00:00.000Z', type: 'retrieval/stopped', data: { reason: 'cancelled', remainingGapKinds: ['coverage'] } })
const rows = [{ type: 'session', version: 0, id, createdAt: 1, delegationDepth: 0 },
  ...[
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', surfaceOp: 'append', data: { id: 'original-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '原始查询' }] } },
    { type: 'session/title', data: { title: '原始查询', source: { kind: 'fallback' }, messageSeqs: [1] } },
    { type: product.type, data: { event: product } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'fixture' }, system: '只按来源判断' }, reason: 'change' } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((row, seq) => ({ ...row, seq, time: seq + 10 }))]
const encoded = rows.map(row => JSON.stringify(row) + '\n')
const source = Buffer.concat(encoded.map(row => zstdCompressSync(row)))

it('decodes all append frames and refuses torn/corrupt tails', () => {
  expect(decodeSessionFrames(source).toString()).toBe(encoded.join(''))
  expect(() => decodeSessionFrames(source.subarray(0, -3))).toThrow()
  expect(() => decodeSessionFrames(Buffer.concat([source, Buffer.from('bad')]))).toThrow()
})

it('preserves V0 bytes, restores through the actual V3 backend and appends after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caseweave-migration-'))
  const directory = join(root, '_no-cwd', id)
  const contexts: Context[] = []
  try {
    await mkdir(directory, { recursive: true })
    const original = join(directory, 'session.jsonl.zstd')
    await writeFile(original, source)
    expect((await migrateSessionDirectory(root))[0]?.action).toBe('checked')
    expect(await readdir(directory)).toEqual(['session.jsonl.zstd'])
    expect((await migrateSessionDirectory(root, true))[0]?.action).toBe('migrated')
    expect(await readFile(original)).toEqual(source)
    for (let round = 0; round < 2; round++) {
      const ctx = new Context(); contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
      const handle = await ctx.sessionPersistence.open(id, round ? 'read' : 'write')
      try {
        const read = await handle.read()
        const session = Session.fromRestore(id, read.events, handle.header, handle.inheritedEventCount, read.eventState)
        expect(readRetrievalSessionEvents(session)).toEqual([product])
        expect(session.deriveMessages().map(message => ({ role: message.role, content: message.content }))).toEqual([
          { role: 'system', content: [{ type: 'text', text: '只按来源判断' }] },
          { role: 'user', content: [{ type: 'text', text: '原始查询' }] },
        ])
        const user = session.snapshotEvents().find(event => event.type === 'user/message')!
        expect(session.snapshotEvents().find(event => String(event.type) === 'session/title')?.data).toMatchObject({ messageSeqs: [user.seq] })
        if (!round) {
          session.append('retrieval/input-accepted', { messageId: 'continued', text: '迁移后继续', turn: 2 })
          await handle.append(session.snapshotEvents().slice(read.events.length)); await handle.flush()
        }
        else expect(read.events.at(-1)?.data).toEqual({ messageId: 'continued', text: '迁移后继续', turn: 2 })
      } finally { await handle.close(); await ctx.fiber.dispose() }
    }
    expect((await migrateSessionDirectory(root, true))[0]?.action).toBe('current')
    expect(await readFile(original)).toEqual(source)
    await appendFile(original, zstdCompressSync('\n'))
    await expect(migrateSessionDirectory(root, true)).rejects.toThrow(/changed after migration/)
  } finally { for (const ctx of contexts) await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
