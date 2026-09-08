import { createServer, request } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const root = process.cwd(), port = Number(process.env.WORKBENCH_PREVIEW_PORT || 3088)
const upstream = new URL(process.env.WORKBENCH_UPSTREAM || 'http://127.0.0.1:3086')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) || upstream.protocol !== 'http:') throw Error('Preview upstream must be local HTTP')
const templatePath = path.join(root, 'packages/product-host/lib/workbench.js')
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/retrieval') {
      const version = (await stat(templatePath)).mtimeMs
      const { TASK_WORKBENCH_HTML } = await import(pathToFileURL(templatePath).href + '?build=' + version)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(TASK_WORKBENCH_HTML); return
    }
    if (url.pathname === '/retrieval/workbench-client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(await readFile(path.join(root, 'packages/product-host/lib/workbench-client.js'))); return
    }
    if (!url.pathname.startsWith('/api/retrieval-agent/')) { res.writeHead(404); res.end(); return }
    // Preserve the browser's public authority so the Host can enforce same-origin checks.
    const proxy = request(new URL(url.pathname + url.search, upstream), { method: req.method, headers: req.headers }, result => {
      res.writeHead(result.statusCode, result.headers); result.pipe(res)
    })
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: '暂时无法连接检索服务' })) })
    res.on('close', () => proxy.destroy()); req.pipe(proxy)
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Preview build unavailable') }
}).listen(port, '127.0.0.1', () => console.log('Workbench preview: http://127.0.0.1:' + port + '/retrieval; API: ' + upstream.origin))
