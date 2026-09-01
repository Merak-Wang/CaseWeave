import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

export async function seedModelSettings(paths, environment) {
  const provider = environment.RETRIEVAL_AGENT_BROWSER_LLM_PROVIDER?.trim()
  const model = environment.RETRIEVAL_AGENT_BROWSER_LLM_MODEL?.trim()
  const baseURL = environment.RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL?.trim()
  const apiKeyEnv = environment.RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV?.trim()
  if ([provider, model, baseURL, apiKeyEnv].every(value => value === undefined)) return false
  if ([provider, model, baseURL, apiKeyEnv].some(value => value === undefined || value.length === 0)) {
    throw new Error('browser Agent LLM setup requires provider, model, base URL, and API-key environment name together')
  }

  const settingsPath = join(paths.dshHome, 'settings.yaml')
  let existing = {}
  if (existsSync(settingsPath)) {
    try {
      const text = await readFile(settingsPath, 'utf8')
      existing = text.trim().length === 0 ? {} : record(JSON.parse(text))
    } catch {
      throw new Error(`refusing to overwrite non-JSON DSH settings at ${settingsPath}; configure the Agent LLM in the Web UI instead`)
    }
  }
  const existingAdapter = record(existing['llm-pi-ai'])
  const existingProviders = record(existingAdapter.providers)
  const existingProvider = record(existingProviders[provider])
  const models = Array.isArray(existingProvider.models) ? existingProvider.models : []
  const previousModel = record(models.find(entry => record(entry).id === model))
  const settings = {
    ...existing,
    'agent-default-model': {
      ...record(existing['agent-default-model']),
      provider,
      model,
      reasoningEffort: environment.RETRIEVAL_AGENT_BROWSER_LLM_REASONING?.trim() || 'off',
    },
    'llm-pi-ai': {
      ...existingAdapter,
      providers: {
        ...existingProviders,
        [provider]: {
          ...existingProvider,
          displayName: environment.RETRIEVAL_AGENT_BROWSER_LLM_DISPLAY_NAME?.trim() || provider,
          apiKeyEnv,
          baseURL,
          models: [...models.filter(entry => record(entry).id !== model), { ...previousModel, id: model }],
        },
      },
    },
    'ui-onboarding': existing['ui-onboarding'] ?? { welcomeNoticeVersion: '2026-08-13.1' },
  }
  await writeFile(settingsPath, `${JSON.stringify(settings, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return true
}
