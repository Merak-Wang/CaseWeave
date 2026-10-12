import { spawnSync } from 'node:child_process'
import { resolve, relative, sep } from 'node:path'

/** 仅回收本次创建的临时目录；回收站失败时保留目录供排查。 */
export function recycleTemporaryDirectory(target, temporaryRoot, prefix) {
  const absolute = resolve(target), parent = resolve(temporaryRoot), child = relative(parent, absolute)
  if (!child || child.startsWith(`..${sep}`) || child === '..' || !child.startsWith(prefix) || child.includes(sep)) throw new Error(`refusing to recycle unexpected temporary directory ${absolute}`)
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName Microsoft.VisualBasic; try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CASEWEAVE_TEMP_TRASH_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException) } catch { exit 1 }'], { windowsHide: true, env: { ...process.env, CASEWEAVE_TEMP_TRASH_TARGET: absolute }, stdio: 'ignore' })
    : spawnSync('gio', ['trash', absolute], { stdio: 'ignore' })
  if (result.error || result.status !== 0) console.warn(`回收站不可用，保留验证临时目录：${absolute}`)
  else console.log(`验证临时目录已移入回收站：${absolute}`)
}
