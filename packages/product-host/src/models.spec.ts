import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CredentialProvider, type CredentialRef, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, it, expect } from 'vitest'
import * as compatibility from '../../dsh-compat/src/opencode-pi-ai.js'
import { WorkbenchModels } from './models.js'
import { inject as hostInject } from './index.js'

class Settings extends SettingsProvider {
  readonly writable = true
  readonly saved: Record<string, unknown> = {}
  protected async load() { return this.saved }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>) { this.saved[ns] = section }
}
class Credentials extends CredentialProvider {
  private values = new Map<string, string>()
  async resolve(ref: CredentialRef) { const value = this.values.get(ref); return value ? { value, source: 'fixture' } : undefined }
  async describe(ref: CredentialRef) { return { configured: this.values.has(ref), writable: true } }
  async set(ref: CredentialRef, value: string) { this.values.set(ref, value) }
  async unset(ref: CredentialRef) { this.values.delete(ref) }
  async readRecord() { return undefined }
  async describeRecord() { return { configured: false, writable: true } }
  async listRecords() { return [] }
  async modifyRecord(): Promise<CredentialRecord | undefined> { return undefined }
  async deleteRecord() {}
}

describe('workbench settings through native DSH provider configuration', () => {
  it('saves and live-selects a provider, keeps headers, refuses stale writes and never returns keys', async () => {
    const received: { authorization: string | undefined; session: string | undefined; custom: string | undefined }[] = []
    const server = createServer((req, res) => {
      req.resume(); req.once('end', () => {
        received.push({ authorization: req.headers.authorization, session: req.headers['x-opencode-session'] as string, custom: req.headers['x-custom'] as string })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    const ctx = new Context()
    try {
      await ctx.plugin(Settings); await ctx.plugin(Credentials); await ctx.plugin(LlmRuntime)
      await ctx.plugin(DefaultModel, { provider: 'opencode-test', model: 'fixture' })
      await ctx.plugin(compatibility, { providers: { 'opencode-test': { baseURL, api: 'openai-completions', headers: { 'x-custom': 'kept' }, models: [{ id: 'fixture', contextWindow: 8192, maxTokens: 1024 }] } } })
      for (const name of ['webServer', 'agents', 'agentPresets', 'workspaceRegistry']) ctx.reflect.provide(name as never, {} as never)
      let models!: WorkbenchModels
      await ctx.plugin({ name: 'model-settings-host-scope', inject: hostInject, apply(scope: Context) { models = new WorkbenchModels(scope) } })
      const before = await models.view()
      const after = await models.update({ action: 'save', provider: 'opencode-test', model: 'fixture', baseURL, api: 'openai-completions', apiKey: 'fixture-secret', revision: before.revision })
      if (!('selected' in after) || !after.selected) throw new Error('Saved model selection missing')
      expect(JSON.stringify(after)).not.toContain('fixture-secret')
      expect(after).toMatchObject({ selected: { provider: 'opencode-test', model: 'fixture' }, configured: [{ hasCredential: true }] })
      expect(JSON.stringify((ctx.settings as Settings).saved)).not.toContain('fixture-secret')
      await expect(models.update({ action: 'save', provider: 'opencode-test', model: 'changed', revision: before.revision })).rejects.toThrow('配置已更新')
      const request = { ...after.selected, sessionId: SessionId('model-settings-session'), messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text' as const, text: 'hello' }] })] }
      const chunks = []; for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(received).toEqual([{ authorization: 'Bearer fixture-secret', custom: 'kept', session: compatibility.openCodeSessionId('model-settings-session') }])
      const ollama = await models.update({ action: 'save', provider: 'ollama', model: 'local', baseURL, api: 'openai-completions', contextWindow: 8192, maxTokens: 1024, revision: after.revision })
      if (!('selected' in ollama) || !ollama.selected) throw new Error('Ollama selection missing')
      const local = []; for await (const chunk of ctx.llm.stream({ ...request, ...ollama.selected })) local.push(chunk)
      expect(local.at(-1), JSON.stringify(local)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(received.at(-1)?.session).toBeUndefined()
    } finally { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
  })
})
