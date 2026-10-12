import { createDatasetUI } from './workbench-datasets.js'
async function api(path, body, signal) {
  const response = await fetch(path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(60000) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.message ?? '数据连接或构建失败，请检查配置。')
  return result
}
createDatasetUI({ api })
