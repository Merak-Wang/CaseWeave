import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containerConfig, assertExternalEtcd } from './model-container.mjs'
import { ensureModelService } from './local-app.mjs'

test('database startup never starts an external etcd against an embedded owner', () => {
  assert.throws(() => assertExternalEtcd({ Config: { Env: ['ETCD_USE_EMBED=true'] } }), /Existing Milvus still owns embedded etcd/)
  assert.doesNotThrow(() => assertExternalEtcd({ Config: { Env: ['ETCD_USE_EMBED=false', 'ETCD_ENDPOINTS=etcd:2379'] } }))
  assert.doesNotThrow(() => assertExternalEtcd(undefined))
})

test('CPU has no GPU reservation override; GPU must be explicitly selected', () => {
  const cpu = containerConfig({})
  assert.equal(cpu.device, 'cpu')
  assert.ok(!cpu.args.some(arg => arg.endsWith('compose.gpu.yml')))
  assert.ok(containerConfig({ RETRIEVAL_AGENT_MODEL_CONTAINER_DEVICE: 'gpu' }).args.some(arg => arg.endsWith('compose.gpu.yml')))
  assert.throws(() => containerConfig({ RETRIEVAL_AGENT_MODEL_CONTAINER_DEVICE: 'auto' }), /cpu or gpu/)
  assert.throws(() => containerConfig({ RETRIEVAL_AGENT_MODEL_SERVICE_URL: 'http://example.com' }), /loopback/)
  assert.throws(() => containerConfig({ RETRIEVAL_AGENT_MODEL_PORT: '8013', RETRIEVAL_AGENT_MODEL_SERVICE_URL: 'http://localhost:8012' }), /disagree/)
})

test('external unavailable service fails before model filesystem access or host uv execution', async () => {
  const server = createServer((_request, response) => { response.writeHead(503); response.end('{}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await assert.rejects(ensureModelService({ root: '/does-not-exist', modelServiceBaseUrl: `http://127.0.0.1:${address.port}` },
      { RETRIEVAL_AGENT_MODEL_SERVICE_MODE: 'external', RETRIEVAL_AGENT_UV_COMMAND: 'must-never-run' }), /fallback is disabled/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('external ready service is reused without process ownership', async () => {
  const server = createServer((_request, response) => { response.end(JSON.stringify({ ready: true })) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    assert.deepEqual(await ensureModelService({ root: '/does-not-exist', modelServiceBaseUrl: `http://127.0.0.1:${server.address().port}` },
      { RETRIEVAL_AGENT_MODEL_SERVICE_MODE: 'external', RETRIEVAL_AGENT_UV_COMMAND: 'must-never-run' }), { child: undefined, owned: false })
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('container mode cannot silently fall back to host Python when Docker cannot execute', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'retrieval-container-path-'))
  try {
    await assert.rejects(ensureModelService({ root: empty, modelServiceBaseUrl: 'http://127.0.0.1:18012' },
      { PATH: empty, RETRIEVAL_AGENT_MODEL_SERVICE_MODE: 'container', RETRIEVAL_AGENT_UV_COMMAND: 'must-never-run' }), /docker|ENOENT/)
  } finally { await rm(empty, { recursive: true }) }
})
