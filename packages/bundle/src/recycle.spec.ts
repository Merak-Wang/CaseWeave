import { beforeEach, expect, it, vi } from 'vitest'
import { parse, resolve } from 'node:path'
import { uninstallLocalProductAssets } from './startup.js'
import { recycleDirectory } from './recycle.js'

const mocked = vi.hoisted(() => ({ exists: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: mocked.spawn }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: mocked.exists }))
beforeEach(() => { mocked.exists.mockReset().mockReturnValue(true); mocked.spawn.mockReset().mockReturnValue({ status: 0, stderr: '' }) })

it('sends only the two resolved product-owned directories to system trash', async () => {
  const home = resolve('synthetic-dsh-home'), result = await uninstallLocalProductAssets(home)
  expect(result).toEqual({ presetPath: resolve(home, '.agent-presets/retrieval-agent'), productRoot: resolve(home, 'retrieval-agent') })
  expect(mocked.spawn).toHaveBeenCalledTimes(2)
  const targets = mocked.spawn.mock.calls.map(([command, args, options]) => {
    if (process.platform === 'win32') {
      expect(command).toBe('powershell.exe'); expect(args.at(-1)).toContain('SendToRecycleBin')
      expect(options.windowsHide).toBe(true)
      return options.env.CASEWEAVE_ASSET_TRASH_TARGET
    }
    expect(command).toBe('gio'); expect(args[0]).toBe('trash'); return args[1]
  })
  expect(targets).toEqual([result.presetPath, result.productRoot])
})

it('keeps the original item and reports the reason without a permanent-delete fallback', async () => {
  mocked.spawn.mockReturnValue({ status: 1, stderr: 'trash unavailable' })
  await expect(uninstallLocalProductAssets(resolve('synthetic-dsh-home'))).rejects.toThrow(/保留原项.*trash unavailable/)
  expect(mocked.spawn).toHaveBeenCalledTimes(1)
})

it('ignores absent assets and refuses a filesystem root before invoking trash', () => {
  mocked.exists.mockReturnValue(false); recycleDirectory(resolve('absent-fixture'))
  expect(mocked.spawn).not.toHaveBeenCalled()
  expect(() => recycleDirectory(parse(process.cwd()).root)).toThrow(/filesystem root/)
  expect(mocked.spawn).not.toHaveBeenCalled()
})
