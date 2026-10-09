import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { assetFingerprint, ensureAssets, createStartupStageClock, resolveWebReadinessTarget, waitForWebReadiness } from './local-app.mjs'

const temporaryRoots = []
afterEach(async () => {
  for (const directory of temporaryRoots.splice(0)) {
    const child = relative(resolve(tmpdir()), resolve(directory))
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
    // 保留测试夹具；没有调用永久删除作为清理。
  }
})

async function fixture({ data = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'caseweave-startup-'))
  temporaryRoots.push(root)
  const bundleRoot = join(root, 'bundle')
  await mkdir(join(bundleRoot, 'presets', 'retrieval-agent'), { recursive: true })
  await writeFile(join(bundleRoot, 'presets', 'retrieval-agent', 'agent.cordis.yml'), 'synthetic-preset', 'utf8')
  if (data) {
    await mkdir(join(root, 'data', 'tickets'), { recursive: true })
    await writeFile(join(root, 'data', 'manifest.json'), JSON.stringify({
      defaultTicketProfile: 'synthetic', ticketProfiles: { synthetic: { paths: ['tickets/synthetic.jsonl'] } },
    }), 'utf8')
    await writeFile(join(root, 'data', 'tickets', 'synthetic.jsonl'), '{"synthetic":1}\n', 'utf8')
  }
  return { root, bundleRoot, dshHome: join(root, 'home') }
}

test('mysql fingerprint never reads data manifest or JSONL, while retaining presets', async () => {
  const paths = await fixture()
  const reads = []
  const readAsset = async (path, encoding) => {
    const child = relative(join(paths.root, 'data'), path)
    assert.ok(child.startsWith('..') || isAbsolute(child), 'database mode must not read a data asset')
    reads.push(path)
    return readFile(path, encoding)
  }
  const environment = { RETRIEVAL_AGENT_STORAGE: 'mysql_milvus' }
  const first = await assetFingerprint(paths, environment, readAsset)
  assert.equal(reads.length, 1)
  await writeFile(reads[0], 'changed-synthetic-preset', 'utf8')
  assert.notEqual(await assetFingerprint(paths, environment, readAsset), first)
})

test('jsonl hashes full content even when size and mtime are preserved', async () => {
  const paths = await fixture({ data: true })
  const target = join(paths.root, 'data', 'tickets', 'synthetic.jsonl')
  const before = await stat(target)
  const first = await assetFingerprint(paths, { RETRIEVAL_AGENT_STORAGE: 'jsonl' })
  await writeFile(target, '{"synthetic":2}\n', 'utf8')
  await utimes(target, before.atime, before.mtime)
  assert.equal((await stat(target)).size, before.size)
  assert.notEqual(await assetFingerprint(paths, { RETRIEVAL_AGENT_STORAGE: 'jsonl' }), first)
})

test('installer flags and receipt files isolate database and jsonl scope', async () => {
  const paths = await fixture({ data: true })
  const calls = []
  const install = async (_command, args) => {
    calls.push(args)
    await mkdir(join(paths.dshHome, '.agent-presets', 'retrieval-agent'), { recursive: true })
    await writeFile(join(paths.dshHome, '.agent-presets', 'retrieval-agent', 'agent.cordis.yml'), 'synthetic', 'utf8')
    await mkdir(join(paths.dshHome, 'retrieval-agent', 'workspace'), { recursive: true })
    if (!args.includes('--skip-data')) {
      await mkdir(join(paths.dshHome, 'retrieval-agent', 'data'), { recursive: true })
      await writeFile(join(paths.dshHome, 'retrieval-agent', 'data', 'manifest.json'), '{}', 'utf8')
    }
  }
  const database = { RETRIEVAL_AGENT_STORAGE: 'mysql_milvus' }
  const jsonl = { RETRIEVAL_AGENT_STORAGE: 'jsonl' }
  assert.equal(await ensureAssets(paths, database, install), true)
  assert.equal(await ensureAssets(paths, database, install), false)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('--skip-data'))
  const databaseReceiptPath = join(paths.dshHome, 'retrieval-agent', 'local-source-install.mysql_milvus.json')
  assert.equal(JSON.parse(await readFile(databaseReceiptPath, 'utf8')).profileScope, 'mysql_milvus')
  assert.equal(await ensureAssets(paths, jsonl, install), true)
  assert.equal(calls.length, 2)
  assert.ok(!calls[1].includes('--skip-data'))
  const jsonlReceipt = JSON.parse(await readFile(join(paths.dshHome, 'retrieval-agent', 'local-source-install.jsonl.json'), 'utf8'))
  assert.equal(jsonlReceipt.profileScope, 'jsonl')
  assert.equal(jsonlReceipt.schemaVersion, 2)
  assert.notEqual(jsonlReceipt.assetFingerprint, JSON.parse(await readFile(databaseReceiptPath, 'utf8')).assetFingerprint)
  const stale = { ...jsonlReceipt, schemaVersion: 1 }
  await writeFile(databaseReceiptPath, JSON.stringify(stale), 'utf8')
  assert.equal(await ensureAssets(paths, database, install), true)
  assert.equal(calls.length, 3)
})

test('stage clock records elapsed durations and failures without exception content', async () => {
  let time = 10
  const events = []
  const clock = createStartupStageClock({ now: () => time, onMeasurement: event => events.push(event) })
  for (const [stage, duration] of [['setup', 11], ['model', 17], ['index', 23], ['listen_ready', 31]]) {
    await clock.measure(stage, async () => { time += duration })
  }
  assert.deepEqual(events.map(event => [event.stage, event.elapsedMs, event.status]), [
    ['setup', 11, 'completed'], ['model', 17, 'completed'], ['index', 23, 'completed'], ['listen_ready', 31, 'completed'],
  ])
  assert.equal(events.at(-1).totalElapsedMs, 82)
  await assert.rejects(clock.measure('listen_ready', async () => { time += 2; throw new Error('fixture-secret-do-not-emit') }))
  assert.equal(events.at(-1).status, 'failed')
  assert.ok(!JSON.stringify(events).includes('fixture-secret-do-not-emit'))
})

test('readiness target follows forwarded host/port and translates wildcard binds', () => {
  assert.equal(resolveWebReadinessTarget(['--host', '0.0.0.0', '--port', '3092']).port, '3092')
  assert.equal(resolveWebReadinessTarget(['--host=::1', '--port=3093']).hostname, '[::1]')
  assert.equal(resolveWebReadinessTarget(['--host=0.0.0.0']).hostname, '127.0.0.1')
  assert.equal(resolveWebReadinessTarget(['--host=::']).hostname, '[::1]')
  assert.throws(() => resolveWebReadinessTarget(['--port']), /requires/u)
  assert.throws(() => resolveWebReadinessTarget(['--port=0']), /between/u)
  assert.throws(() => resolveWebReadinessTarget(['--host=user:password@example.invalid']), /invalid/u)
})

test('spawn alone is not ready; HTTP readiness follows an initial unavailable response', async () => {
  let time = 0
  let calls = 0
  const child = { exitCode: null, signalCode: null }
  await waitForWebReadiness(resolveWebReadinessTarget(), child, {
    timeoutMs: 1000, now: () => time, pause: async duration => { time += duration },
    fetcher: async () => ({ ok: ++calls >= 2 }),
  })
  assert.equal(calls, 2)
  assert.equal(time, 250)
})

test('HTTP success cannot mark an exited child ready', async () => {
  let calls = 0
  await assert.rejects(waitForWebReadiness(resolveWebReadinessTarget(), { exitCode: 1, signalCode: null }, {
    fetcher: async () => { calls += 1; return { ok: true } },
  }), /exited/u)
  assert.equal(calls, 0)
})

test('unavailable endpoint expires explicitly instead of reporting process started as success', async () => {
  let time = 0
  await assert.rejects(waitForWebReadiness(resolveWebReadinessTarget(), { exitCode: null, signalCode: null }, {
    timeoutMs: 500, now: () => time, pause: async duration => { time += duration }, fetcher: async () => ({ ok: false }),
  }), /timed out/u)
  assert.equal(time, 500)
})
