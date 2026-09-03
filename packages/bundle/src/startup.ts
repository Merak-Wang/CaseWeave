import { existsSync, readFileSync } from 'node:fs'
import { appendFile, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface DataManifest {
  readonly schemaVersion: string
  readonly defaultTicketProfile: string
  readonly sourcePolicy: {
    readonly authoritativeSource: string
    readonly runtimeTicketSources: readonly string[]
    readonly fallbackSources: readonly string[]
  }
  readonly ticketProfiles: Readonly<Record<string, {
    readonly recordCount: number
    readonly paths: readonly string[]
    readonly sha256: readonly string[]
  }>>
}

export interface InstallReceipt {
  readonly presetRoot: string
  readonly dataPath: string
  readonly dataRoot: string
  readonly workspacePath: string
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
  return bundledDefaultTicketPaths()[0]!
}

export function bundledFixtureRoot(requestedDataRoot?: string): string {
  if (requestedDataRoot !== undefined) {
    const explicitDataRoot = resolve(requestedDataRoot)
    if (!existsSync(resolve(explicitDataRoot, 'manifest.json'))) {
      throw new Error(`retrieval-agent ESFT data manifest is unavailable under ${explicitDataRoot}`)
    }
    return explicitDataRoot
  }
  const workspaceData = resolve(packageRoot, '..', '..', 'data')
  if (existsSync(resolve(workspaceData, 'manifest.json'))) return workspaceData
  throw new Error('retrieval-agent ESFT data is unavailable; pass an explicit data root when installing the package')
}

function dataManifest(dataRoot = bundledFixtureRoot()): DataManifest {
  const value = JSON.parse(readFileSync(resolve(dataRoot, 'manifest.json'), 'utf8')) as DataManifest
  if (value.schemaVersion !== 'retrieval-agent.data.v1' || typeof value.defaultTicketProfile !== 'string') {
    throw new Error('retrieval-agent data manifest is invalid')
  }
  const profileNames = Object.keys(value.ticketProfiles)
  if (
    value.sourcePolicy?.authoritativeSource !== 'deepseek-ai/ESFT'
    || value.sourcePolicy.runtimeTicketSources.length !== 1
    || value.sourcePolicy.runtimeTicketSources[0] !== 'deepseek-ai/ESFT'
    || value.sourcePolicy.fallbackSources.length !== 0
    || profileNames.length !== 1
    || profileNames[0] !== value.defaultTicketProfile
  ) {
    throw new Error('retrieval-agent data manifest must expose exactly one ESFT runtime profile and no fallback source')
  }
  return value
}

export function bundledDefaultTicketPaths(requestedDataRoot?: string): string[] {
  const dataRoot = bundledFixtureRoot(requestedDataRoot)
  const manifest = dataManifest(dataRoot)
  const profile = manifest.ticketProfiles[manifest.defaultTicketProfile]
  if (profile === undefined || profile.paths.length === 0 || !Number.isInteger(profile.recordCount)) {
    throw new Error(`default ticket profile ${manifest.defaultTicketProfile} is invalid`)
  }
  return profile.paths.map(path => {
    if (!path.replaceAll('\\', '/').startsWith('tickets/esft/')) {
      throw new Error(`runtime ticket data must be stored below data/tickets/esft: ${path}`)
    }
    const absolute = resolve(dataRoot, path)
    const child = relative(dataRoot, absolute)
    if (child.length === 0 || child.startsWith('..') || isAbsolute(child)) {
      throw new Error(`ticket data path escaped data root: ${path}`)
    }
    return absolute
  })
}

/** Explicit installer for the local DSH profile; never runs as an import side effect. */
export async function installLocalProductAssets(
  dshHome: string,
  overwrite = false,
  requestedDataRoot?: string,
): Promise<InstallReceipt> {
  const { home, presetPath, productRoot } = localAssetTargets(dshHome)
  const presetRoot = resolve(home, '.agent-presets')
  const dataRoot = resolve(productRoot, 'data')
  const dataPath = resolve(dataRoot, 'default.jsonl')
  const workspacePath = resolve(productRoot, 'workspace')
  const sourceDataRoot = bundledFixtureRoot(requestedDataRoot)
  const manifest = dataManifest(sourceDataRoot)
  const sourcePaths = bundledDefaultTicketPaths(sourceDataRoot)
  const sourceProfile = manifest.ticketProfiles[manifest.defaultTicketProfile]!
  await mkdir(presetRoot, { recursive: true })
  await mkdir(dataRoot, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  await cp(bundledPresetPath(), presetPath, { recursive: true, force: overwrite, errorOnExist: !overwrite })
  await cp(sourcePaths[0]!, dataPath, { force: overwrite, errorOnExist: !overwrite })
  for (const sourcePath of sourcePaths.slice(1)) {
    await appendFile(dataPath, await readFileSync(sourcePath))
  }
  await writeFile(resolve(dataRoot, 'manifest.json'), `${JSON.stringify({
    ...manifest,
    ticketProfiles: {
      [manifest.defaultTicketProfile]: {
        ...sourceProfile,
        paths: ['default.jsonl'],
      },
    },
    installedTicketProfile: manifest.defaultTicketProfile,
    installedTicketPaths: ['default.jsonl'],
  }, undefined, 2)}\n`, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' })
  return { presetRoot, dataPath, dataRoot, workspacePath }
}

/** Remove only the two exact product-owned asset directories under an explicit DSH home. */
export async function uninstallLocalProductAssets(dshHome: string): Promise<UninstallReceipt> {
  const { presetPath, productRoot } = localAssetTargets(dshHome)
  await rm(presetPath, { recursive: true, force: true })
  await rm(productRoot, { recursive: true, force: true })
  return { presetPath, productRoot }
}
