import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { expect, it } from 'vitest'
import * as preset from '../../bundle/src/preset.js'

it('mounts a native persona through the actual DSH 0.2 registry and bundle module root', async () => {
  const ctx = new Context(), directory = resolve('.cache/semantic-operators/preset-probes')
  await mkdir(directory, { recursive: true })
  const file = resolve(directory, `${randomUUID()}.yml`)
  await writeFile(file, '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n    prefix: "真实预设回归"\n    includeRuntimeContext: false\n', 'utf8')
  ctx.baseUrl = pathToFileURL(process.cwd()+'/').href
  try {
    await ctx.plugin(Loader); await ctx.plugin(SessionProjection)
    const bundleRequire = createRequire(new URL('../../bundle/package.json', import.meta.url))
    const promptPath = createRequire(bundleRequire.resolve('@deepseek-ai/dsh-persona')).resolve('@deepseek-ai/dsh-system-prompt')
    await ctx.plugin((await import(pathToFileURL(promptPath).href)).default, { prefix: '部署默认' })
    await ctx.plugin(AgentPresets, { default: 'retrieval-agent' })
    await ctx.plugin(preset, { path: file })
    const actual = await ctx.agentPresets.resolve('retrieval-agent')
    expect(actual.id).toBe('retrieval-agent')
    expect(actual).not.toHaveProperty('error')
    const agentScope = createScope(ctx, {})
    const mounted = await ctx.agentPresets.mount(agentScope.ctx, 'retrieval-agent')
    expect(mounted.id).toBe('retrieval-agent')
    expect(ctx.agentPresets.composedPreset(agentScope.ctx)).toBe('retrieval-agent')
  } finally { await ctx.fiber.dispose() }
}, 30000)
