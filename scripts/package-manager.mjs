import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Windows 优先直接运行 pnpm 的 Node 入口，启动和发布检查共用同一选择逻辑。 */
export function packageManager() {
  const installed = process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs') : undefined
  const cli = process.env.npm_execpath?.endsWith('.cjs')
    ? process.env.npm_execpath : installed && existsSync(installed) ? installed : undefined
  return cli
    ? { command: process.execPath, prefix: [cli] }
    : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] }
}
