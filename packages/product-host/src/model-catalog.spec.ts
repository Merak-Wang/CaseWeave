import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WorkbenchModels } from './models.js'

it('shows the configured model catalog without retired probability notices', async () => {
  const selection = { provider: 'production-qwen', model: 'Qwen3.5-27b' }
  const ctx = {
    settings: { describe: () => [{ ns: 'retrieval-llm-pi-ai', revision: 1, value: { providers: {
      'production-qwen': { apiKeyEnv: 'QWEN_KEY', models: [{ id: 'Qwen3.5-27b' }] },
      'production-flash': { apiKeyEnv: 'FLASH_KEY', models: [{ id: 'deepseek-v4.1-flash' }] },
    } } }] },
    credentials: { describe: async () => ({ configured: true }) },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      listModels: async (provider: string) => [{ id: provider === 'production-qwen' ? 'Qwen3.5-27b' : 'deepseek-v4.1-flash' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 32000 } }),
      listConfigurableProviders: () => [],
    },
  } as unknown as Context
  const view = await new WorkbenchModels(ctx).view()
  expect(view.selected).toEqual(selection)
  expect(view.configured.map(profile => profile.id)).toEqual(['production-qwen', 'production-flash'])
  expect(view.configured.every(profile => profile.hasCredential)).toBe(true)
  expect(view.notice).toBeUndefined()
})
