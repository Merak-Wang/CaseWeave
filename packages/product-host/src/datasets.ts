import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatasetService, getDatabaseResources } from '@retrieval-agent/provider-database'
import { DATASET_SETTINGS_HTML, DATASET_STYLES } from './workbench-datasets-layout.js'

const endpoint = '/api/retrieval-agent/datasets'
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) { const part = Buffer.from(chunk); size += part.length; if (size > 65536) throw new TypeError('导入配置过大。'); chunks.push(part) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export async function installDatasetHost(ctx: Context, tenantId: () => Promise<string>) {
  const resources = getDatabaseResources({}); await resources.ready
  const service = new DatasetService({ ...resources, tenantId })
  const client = await readFile(new URL('./dataset-client.js', import.meta.url))
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数据连接 · 络寻</title><style>body{margin:0;background:#faf8f8;font-family:system-ui,sans-serif;color:#302d2d}button,a{cursor:pointer}button{padding:10px 16px;border:1px solid #ddd;border-radius:8px}.primary{background:#583f3f;color:#fff}.muted{color:#777}${DATASET_STYLES}</style></head><body>${DATASET_SETTINGS_HTML}<script type="module" src="/retrieval/dataset-client.js"></script></body></html>`
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/retrieval/datasets', handler: (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html) } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/retrieval/dataset-client.js', handler: (_req, res) => { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(client) } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: endpoint, handler: async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, { message: '请求来源不受信任。' })
      const parts = new URL(req.url!, 'http://localhost').pathname.slice(endpoint.length).split('/').filter(Boolean)
      if (req.method === 'GET' && !parts.length) return send(200, { ...await service.list(), defaultDatasetId: process.env.RETRIEVAL_AGENT_DATASET_ID ?? 'esft-development' })
      if (req.method === 'GET' && parts.length === 1) return send(200, await service.get(parts[0]!))
      if (req.method !== 'POST') return send(405, { message: '此操作需要 JSON POST。' })
      if (parts[0] === 'preview') {
        const body = await readJson(req), abort = new AbortController()
        res.once('close', () => { if (!res.writableEnded) abort.abort() })
        return send(200, await service.preview(body, abort.signal))
      }
      if (!parts.length) return send(202, await service.start(await readJson(req)))
      if (parts.length === 2 && parts[1] === 'cancel') return send(200, await service.cancel(parts[0]!))
      send(404, { message: '数据操作不存在。' })
    } catch (error) { if (!res.destroyed) send(400, { message: error instanceof TypeError ? error.message : '数据连接或构建失败，请检查配置后重试。' }) }
  } }))
  ctx.effect(() => async () => { await service.close(); await resources.close() })
  return service
}
