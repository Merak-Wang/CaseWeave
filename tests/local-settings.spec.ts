import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

interface LocalSettingsModule {
  readonly seedModelSettings: (
    paths: { readonly dshHome: string },
    environment: Record<string, string>,
  ) => Promise<boolean>
}

let settings: LocalSettingsModule

beforeAll(async () => {
  settings = await import(pathToFileURL(join(process.cwd(), 'scripts/local-settings.mjs')).href) as LocalSettingsModule
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'retrieval-agent-settings-'))
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
    expect(document['retrieval-llm-pi-ai'].providers['local-provider']).toMatchObject({
      apiKeyEnv: 'LOCAL_MODEL_API_KEY',
      baseURL: 'http://127.0.0.1:8000/v1',
    })
  })

  it('can reseed the YAML written by DSH while preserving unrelated configuration', async () => {
    const dshHome = await fixture()
    await writeFile(join(dshHome, 'settings.yaml'), 'custom:\n  keep: true\nllm-pi-ai:\n  providers:\n    other-provider:\n      models:\n        - id: other-model\n', 'utf8')

    await expect(settings.seedModelSettings({ dshHome }, environment)).resolves.toBe(true)
    const document = JSON.parse(await readFile(join(dshHome, 'settings.yaml'), 'utf8'))
    expect(document.custom).toEqual({ keep: true })
    expect(document['retrieval-llm-pi-ai'].providers['other-provider'].models).toEqual([{ id: 'other-model' }])
    document['agent-default-model'] = { provider: 'other-provider', model: 'other-model' }
    await writeFile(join(dshHome, 'settings.yaml'), JSON.stringify(document), 'utf8')
    await expect(settings.seedModelSettings({ dshHome }, environment)).resolves.toBe(false)
    const repeated = JSON.parse(await readFile(join(dshHome, 'settings.yaml'), 'utf8'))
    expect(repeated['agent-default-model']).toEqual({ provider: 'other-provider', model: 'other-model' })
    expect(repeated['retrieval-llm-pi-ai'].providers['local-provider'].models).toEqual([{ id: 'local-model' }])
  })

  it('preserves the persisted selection after DSH imports the seed file', async () => {
    const dshHome = await fixture()
    await settings.seedModelSettings({ dshHome }, environment)
    const settingsPath = join(dshHome, 'settings.yaml')
    await rename(settingsPath, settingsPath + '.imported')
    await expect(settings.seedModelSettings({ dshHome }, environment)).resolves.toBe(false)
    await expect(readFile(settingsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps both production providers and the selected model when startup has no bootstrap override', async () => {
    const dshHome = await fixture()
    const patchPath = join(dshHome, 'cordis.patch.yml')
    const credentialsPath = join(dshHome, '.credentials.yaml')
    const patch = JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'production-qwen', model: 'Qwen3.5-27b' } },
      { id: 'retrieval-llm-pi-ai', config: { providers: {
        'production-qwen': { apiKeyEnv: 'QWEN_KEY', models: [{ id: 'Qwen3.5-27b' }] },
        'production-flash': { apiKeyEnv: 'FLASH_KEY', models: [{ id: 'deepseek-v4.1-flash', reasoningEfforts: { off: null } }] },
      } } },
    ])
    const credentials = 'refs:\n  QWEN_KEY: fixture-qwen\n  FLASH_KEY: fixture-flash\n'
    await writeFile(patchPath, patch, 'utf8')
    await writeFile(credentialsPath, credentials, 'utf8')
    // 配置由 DSH 持久层管理时，启动不再写入单模型种子覆盖目录。
    for (let restart = 0; restart < 2; restart++) {
      await expect(settings.seedModelSettings({ dshHome }, {})).resolves.toBe(false)
      expect(await readFile(patchPath, 'utf8')).toBe(patch)
      expect(await readFile(credentialsPath, 'utf8')).toBe(credentials)
    }
  })

  it.each(['custom: [broken', 'custom: 1\ncustom: 2\n', '- array-root\n'])('never overwrites malformed or non-mapping settings: %s', async (original) => {
    const dshHome = await fixture()
    const settingsPath = join(dshHome, 'settings.yaml')
    await writeFile(settingsPath, original, 'utf8')

    await expect(settings.seedModelSettings({ dshHome }, environment)).rejects.toThrow(/refusing to overwrite/u)
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(original)
  })
})
