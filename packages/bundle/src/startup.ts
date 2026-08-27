import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface InstallReceipt {
  readonly presetRoot: string
  readonly dataPath: string
}

export interface UninstallReceipt {
  readonly presetPath: string
  readonly productRoot: string
}

function localAssetTargets(dshHome: string): { readonly home: string; readonly presetPath: string; readonly productRoot: string } {
  const home = resolve(dshHome)
  if (home === parse(home).root) throw new Error('refusing to manage assets in a filesystem root')
  const presetPath = resolve(home, '.agent-presets', 'retrieval-agent')
  const productRoot = resolve(home, 'retrieval-agent')
  for (const target of [presetPath, productRoot]) {
    const child = relative(home, target)
    if (child.length === 0 || child.startsWith('..') || isAbsolute(child)) {
      throw new Error(`asset target escaped DSH home: ${target}`)
    }
  }
  return { home, presetPath, productRoot }
}

export function bundledPresetRoot(): string {
  return resolve(packageRoot, 'presets')
}

export function bundledPresetPath(): string {
  return resolve(bundledPresetRoot(), 'retrieval-agent')
}

export function bundledFixturePath(): string {
  return resolve(packageRoot, 'fixtures', 'tickets.jsonl')
}

/** Explicit installer for the local DSH profile; never runs as an import side effect. */
export async function installLocalProductAssets(dshHome: string, overwrite = false): Promise<InstallReceipt> {
  const { home, presetPath, productRoot } = localAssetTargets(dshHome)
  const presetRoot = resolve(home, '.agent-presets')
  const dataPath = resolve(productRoot, 'data', 'tickets.jsonl')
  await mkdir(presetRoot, { recursive: true })
  await mkdir(dirname(dataPath), { recursive: true })
  await cp(bundledPresetPath(), presetPath, { recursive: true, force: overwrite, errorOnExist: !overwrite })
  await cp(bundledFixturePath(), dataPath, { force: overwrite, errorOnExist: !overwrite })
  return { presetRoot, dataPath }
}

/** Remove only the two exact product-owned asset directories under an explicit DSH home. */
export async function uninstallLocalProductAssets(dshHome: string): Promise<UninstallReceipt> {
  const { presetPath, productRoot } = localAssetTargets(dshHome)
  await rm(presetPath, { recursive: true, force: true })
  await rm(productRoot, { recursive: true, force: true })
  return { presetPath, productRoot }
}
