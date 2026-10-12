import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { parse, resolve } from 'node:path'

/** 将已确定的产品目录交给系统回收站；失败保留原项，不改用永久删除。 */
export function recycleMigrationPath(target: string): void {
  const absolute = resolve(target)
  if (absolute === parse(absolute).root) throw new Error('refusing to recycle a filesystem root')
  if (!existsSync(absolute)) return
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName Microsoft.VisualBasic; try { [Microsoft.VisualBasic.FileIO.FileSystem]::${statSync(absolute).isDirectory() ? 'DeleteDirectory' : 'DeleteFile'}($env:CASEWEAVE_ASSET_TRASH_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`],
    { windowsHide: true, env: { ...process.env, CASEWEAVE_ASSET_TRASH_TARGET: absolute }, encoding: 'utf8' })
    : spawnSync('gio', ['trash', absolute], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`回收站操作失败，保留原项 ${absolute}：${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`)
}
