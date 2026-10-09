import { readFile, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = resolve(root, 'packages')
const contract = JSON.parse(await readFile(resolve(root, 'architecture', 'workspace.json'), 'utf8'))

for (const entry of contract.packages) {
  const target = resolve(packagesRoot, entry.directory, 'lib')
  const relativeTarget = relative(packagesRoot, target)
  if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === '..' || !relativeTarget.endsWith(`${sep}lib`)) {
    throw new Error(`refusing to clean unexpected build path: ${target}`)
  }
  try { await access(target) } catch { continue }
  // 生成目录同样进入系统回收站；不可用时保留，由编译器覆盖现有产物。
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName Microsoft.VisualBasic; try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CASEWEAVE_BUILD_TRASH_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException) } catch { exit 1 }'],
      { windowsHide: true, env: { ...process.env, CASEWEAVE_BUILD_TRASH_TARGET: target }, stdio: 'ignore' })
    : spawnSync('gio', ['trash', target], { stdio: 'ignore' })
  if (result.error || result.status !== 0) console.warn(`回收站不可用，保留生成目录：${target}`)
}

console.log('生成目录清理检查完成；未成功移入回收站的目录已保留。')
