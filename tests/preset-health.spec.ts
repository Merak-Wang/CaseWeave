import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

describe('shipped CaseWeave preset', () => {
  it('is healthy in the exact DSH preset YAML dialect', async () => {
    const requireFromHost = createRequire(resolve('packages/product-host/package.json'))
    const entry = requireFromHost.resolve('@deepseek-ai/dsh-agent-preset-registry')
    const { entryListProblem } = await import(pathToFileURL(entry).href)
    const plugins = parse(await readFile(resolve('packages/bundle/presets/retrieval-agent/agent.cordis.yml'), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
    })
    expect(entryListProblem(plugins)).toBeUndefined()
    expect(plugins.some((row: { id: string }) => row.id === 'retrieval-product')).toBe(true)
    const bundleAgentEntry = createRequire(resolve('package.json')).resolve('@retrieval-agent/bundle/agent')
    expect(bundleAgentEntry.replaceAll('\\', '/')).toMatch(/packages\/bundle\/lib\/agent\.js$/u)
    await expect(import(pathToFileURL(bundleAgentEntry).href)).resolves.toMatchObject({
      apply: expect.any(Function),
    })
  })
})
