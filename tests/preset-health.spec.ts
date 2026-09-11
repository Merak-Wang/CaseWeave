import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

interface PresetRecord {
  readonly id: string
  readonly broken?: string
}

interface AgentPresetsModule {
  readonly scanRoot: (root: { readonly path: string; readonly trust: 'shipped' }, harnessBase: string) => Promise<readonly PresetRecord[]>
}

let agentPresets: AgentPresetsModule
let bundleAgentEntry: string

beforeAll(async () => {
  const requireFromHost = createRequire(resolve('packages/product-host/package.json'))
  const entry = requireFromHost.resolve('@deepseek-ai/dsh-agent-presets')
  agentPresets = await import(pathToFileURL(entry).href) as AgentPresetsModule
  bundleAgentEntry = createRequire(resolve('package.json')).resolve('@retrieval-agent/bundle/agent')
})

describe('shipped CaseWeave preset', () => {
  it('is healthy in the exact DSH preset YAML dialect', async () => {
    const presets = await agentPresets.scanRoot({
      path: resolve('packages/bundle/presets'),
      trust: 'shipped',
    }, pathToFileURL(resolve('packages/bundle') + '/').href)
    const retrievalAgent = presets.find(preset => preset.id === 'retrieval-agent')

    expect(retrievalAgent).toBeDefined()
    expect(retrievalAgent?.broken).toBeUndefined()
    expect(bundleAgentEntry.replaceAll('\\', '/')).toMatch(/packages\/bundle\/lib\/agent\.js$/u)
    await expect(import(pathToFileURL(bundleAgentEntry).href)).resolves.toMatchObject({
      apply: expect.any(Function),
    })
  })
})
