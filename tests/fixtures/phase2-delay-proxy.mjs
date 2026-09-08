// Acceptance-only fault injection. Real query parsing, Qwen inference and Milvus remain downstream.
import { createServer } from 'node:http'
const port = Number(process.env.PHASE2_PROXY_PORT ?? 8023)
const delayMs = Number(process.env.PHASE2_EMBED_DELAY_MS ?? 15000)
const upstream = new URL('http://127.0.0.1:8012')
let embeddings = 0
const server = createServer(async (request, response) => {
  if (request.url === '/__acceptance/status') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ embeddings, delayMs })); return }
  const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (request.url === '/v1/embeddings') { embeddings++; await new Promise(resolve => setTimeout(resolve, delayMs)) }
  try {
    const result = await fetch(new URL(request.url, upstream), { method: request.method, headers: { 'content-type': 'application/json' },
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Buffer.concat(chunks) }) })
    response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/json' })
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch { response.writeHead(502); response.end('acceptance upstream unavailable') }
})
server.listen(port, '127.0.0.1', () => console.log(`Acceptance proxy: http://127.0.0.1:${port}; embeddings delayed ${delayMs} ms`))
