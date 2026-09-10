import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Config as ProviderConfig, supportedProtocols, type PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { RetrievalError } from '@retrieval-agent/contracts'

const NS = settingsNamespace('llm-pi-ai')
const ENDPOINT = '/api/retrieval-agent/models'
const invalid = (message: string): never => { throw new RetrievalError('INVALID_REQUEST', message) }

/** The product configuration surface shares DSH's provider registry, validation and credential store. */
export class WorkbenchModels {
  private readonly selections = new WeakMap<Agent, ModelSelectionRef>()
  constructor(readonly ctx: Context) {}
  bind(agent: Agent): ModelSelectionRef {
    let selection = this.selections.get(agent)
    if (selection) return selection
    let saved: ModelSelection | undefined
    for (const e of agent.session.events) {
      if (e.type !== 'user/message' || e.data.source.kind !== 'plugin' || e.data.source.plugin !== 'retrieval-agent-models' || e.data.source.form !== 'snapshot') continue
      const section = e.data.source.sections.find(s => s.name === 'model-selection')
      if (section) saved = JSON.parse(section.text) as ModelSelection
    }
    const header = agent.session.requestHeader()?.config
    selection = { current: saved ?? (header?.provider && header.model ? { provider: header.provider, model: header.model,
      ...(header.reasoningEffort ? { reasoningEffort: header.reasoningEffort } : {}) } : this.ctx.agentDefaultModel.currentSelection()), assembled: undefined }
    this.selections.set(agent, selection)
    installModelSelection(agent.ctx, selection)
    return selection
  }
  private descriptor() {
    const descriptor = this.ctx.settings.describe().find(d => d.ns === NS)
    if (!descriptor) throw new RetrievalError('PROVIDER_UNAVAILABLE', '模型设置服务尚未就绪。', { retryable: true })
    return descriptor
  }
  async view(agent?: Agent) {
    const descriptor = this.descriptor()
    const profiles = (descriptor.value as { providers: Record<string, PiAiProviderProfile> }).providers
    const configured = await Promise.all(Object.entries(profiles).map(async ([id, profile]) => ({
      id, name: profile.displayName ?? id, baseURL: profile.baseURL ?? '', api: profile.api ?? '',
      hasCredential: Boolean(profile.apiKeyEnv && (await this.ctx.credentials.describe(credentialRef(profile.apiKeyEnv))).configured),
      models: await Promise.all((await this.ctx.llm.listModels(id)).map(async m => {
        const info = await this.ctx.llm.resolveModelInfo(id, m.id)
        return { id: m.id, name: m.name, contextWindow: info.context?.contextWindow,
          maxTokens: profile.models?.find(entry => entry.id === m.id)?.maxTokens, reasoningEfforts: info.reasoning?.efforts }
      })),
    })))
    return { revision: descriptor.revision, selected: agent ? this.bind(agent).current : this.ctx.agentDefaultModel.currentSelection(), configured,
      providers: this.ctx.llm.listConfigurableProviders().map(p => ({ id: p.provider, name: p.displayName })),
      protocols: supportedProtocols() }
  }
  async update(raw: unknown, agent?: Agent) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('模型设置需要 JSON 对象。')
    const v = raw as Record<string, unknown>
    if (!['save', 'select', 'discover'].includes(String(v.action))) invalid('未知模型设置操作。')
    if (Object.keys(v).some(k => !['action', 'provider', 'model', 'api', 'baseURL', 'apiKey', 'contextWindow', 'maxTokens', 'reasoningEffort', 'revision'].includes(k))) invalid('模型设置包含未知字段。')
    if (typeof v.provider !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(v.provider)) invalid('供应商标识只能包含小写字母、数字和连字符。')
    const provider = v.provider as string
    if (v.baseURL !== undefined && v.baseURL !== '') {
      let url: URL
      try { url = new URL(String(v.baseURL)) } catch { return invalid('请输入完整 API 地址。') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('API 地址必须为 HTTP(S)，且不能包含凭据、查询参数或片段。')
    }
    if (v.api !== undefined && v.api !== '' && !supportedProtocols().includes(String(v.api))) invalid('此 API 协议不在当前 DSH 支持列表中。')
    if (v.apiKey !== undefined && (typeof v.apiKey !== 'string' || /[\r\n]/.test(v.apiKey) || v.apiKey.length > 8192)) invalid('API 密钥格式无效。')
    if (v.action === 'discover') {
      return { models: await this.ctx.llm.discoverModels(NS, { provider,
        ...(v.baseURL ? { baseURL: String(v.baseURL) } : {}), ...(v.api ? { api: String(v.api) } : {}),
        ...(v.apiKey ? { apiKey: String(v.apiKey) } : {}), signal: AbortSignal.timeout(20000) }) }
    }
    if (typeof v.model !== 'string' || !v.model.trim() || v.model.length > 256) invalid('请输入模型 ID。')
    const model = (v.model as string).trim()
    if (v.action === 'save') {
      const descriptor = this.descriptor()
      if (!Number.isSafeInteger(v.revision) || v.revision !== descriptor.revision) invalid('模型配置已更新，请重新打开设置后保存。')
      const profiles = (descriptor.value as { providers: Record<string, PiAiProviderProfile> }).providers
      const previous = profiles[provider] ?? {}
      const modelEntry = { ...(previous.models?.find(m => m.id === model) ?? {}), id: model }
      for (const key of ['contextWindow', 'maxTokens'] as const) {
        if (v[key] !== undefined) {
          if (!Number.isSafeInteger(v[key]) || Number(v[key]) < 1024 || Number(v[key]) > 10000000) invalid('Token 容量需要填写 1024–10000000 的整数。')
          modelEntry[key] = Number(v[key])
        }
      }
      const ref = previous.apiKeyEnv ?? `RETRIEVAL_MODEL_${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`
      // pi-ai requires a nonempty OpenAI key even for Ollama; Ollama ignores this documented placeholder.
      const apiKey = v.apiKey ? String(v.apiKey) : provider === 'ollama' && !previous.apiKeyEnv ? 'ollama' : undefined
      const profile: PiAiProviderProfile = { ...previous,
        ...(v.baseURL ? { baseURL: String(v.baseURL) } : {}), ...(v.api ? { api: String(v.api) } : {}),
        ...(apiKey ? { apiKeyEnv: ref } : {}),
        models: [...(previous.models ?? []).filter(m => m.id !== model), modelEntry] }
      // Validate the same complete provider declaration DSH will consume, before storing credentials.
      ProviderConfig(structuredClone({ providers: { ...profiles, [provider]: profile } }))
      if (apiKey) await this.ctx.credentials.set(credentialRef(ref), apiKey)
      await this.ctx.settings.update(NS, { providers: { [provider]: profile } }, descriptor.revision)
    }
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    const effort = v.reasoningEffort ? String(v.reasoningEffort) : undefined
    if (effort && !info.reasoning?.efforts.some(e => e.id === effort)) invalid('该模型不支持此推理档位。')
    const selection = { provider, model, ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}) }
    if (agent) {
      agent.session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent-models', form: 'snapshot',
        sections: [{ name: 'model-selection', text: JSON.stringify(selection) }] },
        content: [{ type: 'text', text: `后续检索步骤使用模型 ${provider}/${model}，继续遵循当前任务要求。` }] }), { surfaceOp: 'append' })
      this.bind(agent).current = selection
    } else await this.ctx.agentDefaultModel.saveSelection(selection)
    return this.view(agent)
  }
}

export function installWorkbenchModels(ctx: Context, models: WorkbenchModels, taskAgent: (id: string) => Promise<Agent>): void {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ENDPOINT, handler: async (req, res) => {
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    try {
      const origin = `http://${req.headers.host}`
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname) || (req.headers.origin && req.headers.origin !== origin)
        || req.headers['sec-fetch-site'] === 'cross-site') { send(403, { message: '模型设置只允许从本机同源工作台访问。' }); return }
      const id = new URL(req.url!, origin).searchParams.get('task')
      if (id && !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) invalid('任务引用无效。')
      const agent = id ? await taskAgent(id) : undefined
      if (req.method === 'GET') { send(200, await models.view(agent)); return }
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) { send(405, { message: '此操作需要 JSON POST。' }); return }
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 16384) invalid('模型配置过大。'); chunks.push(b) }
      let input: unknown
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { message: 'JSON 格式无效。' }) }
      send(200, await models.update(input, agent))
    } catch (e) {
      // Adapter exceptions can contain upstream payloads or draft credentials. They never cross this surface.
      if (!(e instanceof RetrievalError) && e instanceof Error) ctx.logger.warn('model settings failure: %s', e.stack?.split('\n').slice(1, 6).join('\n'))
      send(400, { message: e instanceof RetrievalError ? e.publicMessage : '模型配置或连接未通过 DSH 校验，请检查地址、协议、模型 ID 和密钥。' })
    }
  } }))
}
