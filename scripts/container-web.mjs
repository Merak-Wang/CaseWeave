import { createServer, request as proxyRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// DSH stays on loopback. Expose only the product surface through Docker's loopback-published port.
export function workbenchGateway(upstreamPort) {
  return createServer((req, res) => {
    const fail = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message })) }
    let incoming
    try { incoming = new URL('http://' + req.headers.host) } catch { fail(400, 'Invalid host'); return }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(incoming.hostname)) { fail(403, 'Loopback host required'); return }
    if (req.headers.origin && req.headers.origin !== incoming.origin) { fail(403, 'Same-origin request required'); return }
    const url = new URL(req.url ?? '/', incoming)
    if (url.origin !== incoming.origin || !['GET', 'HEAD', 'POST'].includes(req.method) || !/^\/(?:retrieval(?:\/|$)|api\/retrieval-agent(?:\/|$))/u.test(url.pathname)) {
      fail(404, 'Use /retrieval. Configure the model in the private container environment.'); return
    }
    const target = '127.0.0.1:' + upstreamPort
    const headers = { ...req.headers, host: target, ...(req.headers.origin ? { origin: 'http://' + target } : {}) }
    for (const name of Object.keys(headers)) if (name.startsWith('x-forwarded-') || name === 'forwarded') delete headers[name]
    const upstream = proxyRequest({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: url.pathname + url.search, headers }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) fail(503, 'Application is starting or unavailable'); else res.destroy() })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const upstreamPort = 3081, server = workbenchGateway(upstreamPort)
  const child = spawn(process.execPath, ['scripts/database-web.mjs', '--host', '127.0.0.1', '--port', String(upstreamPort), '--no-open'],
    { stdio: 'inherit', env: process.env, windowsHide: true })
  server.on('error', error => { console.error(error.message); child.kill('SIGTERM'); process.exitCode = 1 })
  server.listen(3080, '0.0.0.0')
  const stop = () => { server.close(); child.kill('SIGTERM') }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  child.on('error', error => { console.error(error.message); server.close(); process.exitCode = 1 })
  child.on('exit', code => { server.close(); server.closeAllConnections(); process.exitCode = code ?? 1 })
}
