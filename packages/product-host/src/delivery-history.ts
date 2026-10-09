import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

interface DeliveryFile { kind: string; format: string; path: string; bytes: number; sha256: string }
interface Delivery { id: string; query: string; model: string; source_provider: string; result_revision: string; positive_count: number; files: DeliveryFile[] }
interface Manifest { entries: Delivery[] }
const endpoint = '/api/retrieval-agent/deliveries'
const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** 原任务只读交付：由固定清单选文件，读取原字节，不创建或恢复任务。 */
export async function handleDeliveryHistory(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
  try {
    const manifest = JSON.parse(await readFile(resolve(root, 'deliveries/manifest.json'), 'utf8')) as Manifest
    if (path === '/retrieval/deliveries') {
      const rows = manifest.entries.map(d => `<tr><td>${escape(d.query)}</td><td>${escape(d.model)}</td><td>${d.positive_count}</td><td><a href="${endpoint}/${encodeURIComponent(d.id)}/report">原报告 JSON</a> · <a href="${endpoint}/${encodeURIComponent(d.id)}/xlsx">原 XLSX</a><details><summary>原始身份</summary><p>任务 ${escape(d.id)}<br>来源 ${escape(d.source_provider)}<br>版本 ${escape(d.result_revision)}</p></details></td></tr>`).join('')
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已交付结果</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#20252b}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:16px;border-bottom:1px solid #ddd}details p{overflow-wrap:anywhere}a{color:#a62938}.table{overflow:auto}</style><body><a href="/retrieval">返回检索工作台</a><h1>已交付结果</h1><p>原模型任务的只读报告与结果文件。保留原来源和结果版本，不代表当前数据库任务，不可续跑；新查询请返回工作台。</p><div class="table"><table><thead><tr><th>原问题</th><th>模型</th><th>结果数</th><th>原文件</th></tr></thead><tbody>${rows}</tbody></table></div></body></html>`)
      return
    }
    if (path === endpoint) {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ entries: manifest.entries.map(({ files, ...entry }) => ({
        ...entry, files: files.map(({ path: _path, ...file }) => ({ ...file, href: `${endpoint}/${entry.id}/${file.kind}` })),
      })) })); return
    }
    const [id, kind] = path.slice(endpoint.length + 1).split('/')
    const entry = manifest.entries.find(d => d.id === id)
    const file = entry?.files.find(f => f.kind === kind)
    if (!file) { response.writeHead(404); response.end(); return }
    const absolute = resolve(root, file.path)
    if (!absolute.startsWith(resolve(root) + sep)) { response.writeHead(404); response.end(); return }
    const bytes = await readFile(absolute)
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256 || bytes.length !== file.bytes) throw new Error('原交付文件与清单不一致。')
    response.setHeader('content-type', file.kind === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json; charset=utf-8')
    response.setHeader('content-disposition', `attachment; filename="${entry!.id}.${file.format}"`)
    response.setHeader('x-result-revision', entry!.result_revision)
    response.end(bytes)
  } catch {
    response.writeHead(503); response.end('已交付文件暂不可读。')
  }
}

export function installDeliveryHistory(ctx: Context): void {
  const root = process.env.RETRIEVAL_AGENT_DELIVERY_ROOT
  if (!root) return
  for (const path of ['/retrieval/deliveries', endpoint]) ctx.effect(() => ctx.webServer.register({
    kind: path === endpoint ? 'prefix' : 'exact', path,
    handler: (request, response) => handleDeliveryHistory(root, request, response),
  }))
}
