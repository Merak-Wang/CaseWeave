import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

interface LocalSettingsModule {
  readonly seedModelSettings: (
    paths: { readonly dshHome: string },
    environment: Record<string, string>,
  ) => Promise<boolean>
}

const createdDirectories: string[] = []
let settings: LocalSettingsModule

beforeAll(async () => {
  settings = await import(pathToFileURL(join(process.cwd(), 'scripts/local-settings.mjs')).href) as LocalSettingsModule
})

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'retrieval-agent-settings-'))
  createdDirectories.push(directory)
  return directory
}

const environment = {
  RETRIEVAL_AGENT_BROWSER_LLM_PROVIDER: 'local-provider',
  RETRIEVAL_AGENT_BROWSER_LLM_MODEL: 'local-model',
  RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL: 'http://127.0.0.1:8000/v1',
  RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV: 'LOCAL_MODEL_API_KEY',
}

describe('persistent local DSH settings', () => {
  it('seeds the requested Agent LLM while preserving launcher-managed JSON sections', async () => {
    const dshHome = await fixture()
    await writeFile(join(dshHome, 'settings.yaml'), JSON.stringify({ custom: { keep: true } }), 'utf8')

    await expect(settings.seedModelSettings({ dshHome }, environment)).resolves.toBe(true)

    const document = JSON.parse(await readFile(join(dshHome, 'settings.yaml'), 'utf8'))
    expect(document.custom).toEqual({ keep: true })
    expect(document['agent-default-model']).toMatchObject({ provider: 'local-provider', model: 'local-model' })
    expect(document['llm-pi-ai'].providers['local-provider']).toMatchObject({
      apiKeyEnv: 'LOCAL_MODEL_API_KEY',
      baseURL: 'http://127.0.0.1:8000/v1',
    })
  })

  it('never overwrites a YAML settings document it cannot safely merge', async () => {
    const dshHome = await fixture()
    const settingsPath = join(dshHome, 'settings.yaml')
    await writeFile(settingsPath, 'custom:\n  keep: true\n', 'utf8')

    await expect(settings.seedModelSettings({ dshHome }, environment)).rejects.toThrow(/refusing to overwrite/u)
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe('custom:\n  keep: true\n')
  })
})
