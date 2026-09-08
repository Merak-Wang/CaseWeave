import { createServer, request } from 'node:http'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workbenchGateway } from './container-web.mjs'

test('container gateway forwards product streaming and enforces its host, origin and route boundary', async () => {
  let calls = 0
  const upstream = createServer((req, res) => { calls++; res.setHeader('content-type', 'application/json'); res.write(JSON.stringify({ host: req.headers.host, origin: req.headers.origin, url: req.url })); res.end() })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const gateway = workbenchGateway(upstream.address().port)
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
  const base = 'http://127.0.0.1:' + gateway.address().port
  try {
    const response = await fetch(base + '/api/retrieval-agent/tasks', { method: 'POST', headers: { origin: base }, body: '{}' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { host: '127.0.0.1:' + upstream.address().port, origin: 'http://127.0.0.1:' + upstream.address().port, url: '/api/retrieval-agent/tasks' })
    assert.equal((await fetch(base + '/retrieval/workbench-client.js')).status, 200)
    assert.equal((await fetch(base + '/api/terminal')).status, 404)
    assert.equal((await fetch(base + '/')).status, 404)
    assert.equal((await fetch(base + '/retrieval', { headers: { origin: 'https://other.invalid' } })).status, 403)
    const hostileHost = await new Promise((resolve, reject) => { const req = request(base + '/retrieval', { headers: { host: 'other.invalid' } }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', reject); req.end() })
    assert.equal(hostileHost, 403)
    assert.equal(calls, 2)
  } finally {
    gateway.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))])
  }
})
