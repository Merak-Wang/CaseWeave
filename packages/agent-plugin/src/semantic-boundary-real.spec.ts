import SessionProjection from '@deepseek-ai/dsh-session-projection'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Skills from '@deepseek-ai/dsh-skill'
import { parse } from 'yaml'
import { createPool } from 'mysql2/promise'
import { expect, it } from 'vitest'
import { TicketDatabase, DatabaseTicketProvider, MilvusClient } from '@retrieval-agent/provider-database'
import { ModelServiceClient } from '@retrieval-agent/model-service-client'
import { SpacyQueryAnalyzer } from '@retrieval-agent/query-understanding'
import type { TicketRetrievalProvider, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import * as piAi from '@retrieval-agent/dsh-compat/opencode-pi-ai'
import { TaskHost, type TaskSnapshot } from '../../product-host/src/tasks.js'
import { MySqlTaskStore } from './task-store.js'
import { DurableRetrievalAgentService } from './durable-service.js'
import { TicketPrincipalProviderService, TicketRetrievalProviderService } from './provider-services.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { installRetrievalTools } from './tools.js'
import { installRetrievalRuntimeBudget } from './context-budget.js'
import { installWorkingContext } from './working-context.js'
import { ExpertCoordinator } from './experts.js'
import { inject } from './index.js'

const enabled = process.env.RETRIEVAL_AGENT_BOUNDARY_REAL_MODEL === '1'
const principal = (): TrustedPrincipalContext => ({ tenantId: 'demo', subjectId: 'independent-boundary-eval', entitlementVersion: 'v1',
  purpose: 'ticket_retrieval', attributes: { group: ['admin'], role: ['administrator'], environment: ['development'] }, issuedAt: new Date().toISOString() })
class Principal extends TicketPrincipalProviderService { async resolve() { return principal() } }
class Provider extends TicketRetrievalProviderService {
  constructor(ctx: Context, readonly p: TicketRetrievalProvider) { super(ctx) }
  get providerId() { return this.p.providerId }
  resolve: TicketRetrievalProvider['resolve'] = request => this.p.resolve(request)
  openSnapshot: TicketRetrievalProvider['openSnapshot'] = (...a) => this.p.openSnapshot(...a)
  search: TicketRetrievalProvider['search'] = (...a) => this.p.search(...a)
  readEvidence: TicketRetrievalProvider['readEvidence'] = (...a) => this.p.readEvidence(...a)
  readDetails: TicketRetrievalProvider['readDetails'] = (...a) => this.p.readDetails(...a)
  status: TicketRetrievalProvider['status'] = (...a) => this.p.status(...a)
}

// Opt-in, production HTTP -> TaskHost -> DSH -> real SQL/Milvus/source/model.
// The fresh task database isolates workers from the user's running 3086 tasks.
// IDs bound the source-review scope; expected verdicts remain only below.
it.skipIf(!enabled)('A3 real model: distinguishes completed operations and the remaining issue through public tasks', async () => {
  const modelUrl = process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:28012'
  const sourceUrl = process.env.RETRIEVAL_AGENT_MYSQL_URL ?? 'mysql://root@127.0.0.1:23306/retrieval_agent'
  const taskDatabase = `ra_boundary_${randomUUID().replaceAll('-', '')}`
  const admin = createPool(sourceUrl)
  await admin.query(`CREATE DATABASE ${taskDatabase} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  const taskUrl = new URL(sourceUrl); taskUrl.pathname = '/' + taskDatabase
  const store = new MySqlTaskStore(taskUrl.href), db = new TicketDatabase(sourceUrl), ctx = new Context()
  const output = process.env.RETRIEVAL_AGENT_BOUNDARY_OUTPUT ?? 'output/independent-experience-review/semantic-live'
  await mkdir(output, { recursive: true })
  let keyName: string | undefined, previousKey: string | undefined
  const disposers: (() => Promise<void>)[] = [], records: unknown[] = [], errors: string[] = []
  let host: TaskHost | undefined, server: ReturnType<typeof createServer> | undefined
  try {
    const dshHome = process.env.RETRIEVAL_AGENT_BOUNDARY_DSH_HOME ?? '.cache/retrieval-agent-local/dsh-home'
    const settings = parse(await readFile(dshHome + '/settings.yaml', 'utf8'))
    const credentials = parse(await readFile(dshHome + '/.credentials.yaml', 'utf8'))
    const selection = { ...settings['agent-default-model'],
      ...(process.env.RETRIEVAL_AGENT_BOUNDARY_MODEL ? { model: process.env.RETRIEVAL_AGENT_BOUNDARY_MODEL } : {}),
      ...(process.env.RETRIEVAL_AGENT_BOUNDARY_REASONING ? { reasoningEffort: process.env.RETRIEVAL_AGENT_BOUNDARY_REASONING } : {}) }
    const config = settings['llm-pi-ai']
    const preset = parse(await readFile(new URL('../../bundle/presets/retrieval-agent/agent.cordis.yml', import.meta.url), 'utf8'),
      { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }) as { id: string; config: { prefix: string; complete?: boolean; includeRuntimeContext?: boolean } }[]
    const persona = preset.find(row => row.id === 'persona')!.config
    if (process.env.RETRIEVAL_AGENT_BOUNDARY_MODEL) {
      const discovery = await fetch(process.env.RETRIEVAL_AGENT_BOUNDARY_DISCOVERY_URL ?? 'http://127.0.0.1:3086/api/retrieval-agent/models',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'discover', provider: selection.provider }) })
      expect(discovery.status).toBe(200)
      const discovered = await discovery.json() as { models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] }
      const descriptor = discovered.models.find(m => m.id === selection.model)
      if (!descriptor?.contextWindow || !descriptor.maxTokens) throw new Error('Model comparison requires discovered context and output capacities')
      config.providers[selection.provider].models = [...(config.providers[selection.provider].models ?? []).filter((m: { id: string }) => m.id !== selection.model), descriptor]
      await writeFile(`${output}/model-discovery.json`, JSON.stringify({ provider: selection.provider, model: descriptor }, null, 2))
    }
    keyName = config.providers[selection.provider].apiKeyEnv
    if (keyName) {
      previousKey = process.env[keyName]
      const key = previousKey ?? credentials.refs[keyName]
      if (typeof key !== 'string' || !key) throw new Error('Configured model credential unavailable')
      process.env[keyName] = key
    }
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
    await ctx.plugin(piAi, config); await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
    if (process.env.RETRIEVAL_AGENT_BOUNDARY_EXPERT === '1') {
      await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); await ctx.plugin(Skills)
    }
    new Principal(ctx)
    const model = new ModelServiceClient({ baseUrl: modelUrl, embeddingModel: 'Qwen/Qwen3-Embedding-0.6B',
      embeddingRevision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3', embeddingDimensions: 1024 })
    const provider = new DatabaseTicketProvider(db, new MilvusClient(process.env.RETRIEVAL_AGENT_MILVUS_URL ?? 'http://127.0.0.1:29530'), model, 'esft-development')
    new Provider(ctx, provider)
    const analyzer = new SpacyQueryAnalyzer({ baseUrl: modelUrl })
    const application = new DurableRetrievalAgentService(ctx, {}, store)
    if (process.env.RETRIEVAL_AGENT_BOUNDARY_EXPERT === '1') await ctx.plugin({ name: 'boundary-expert-scope', inject,
      apply(scope: Context) { new ExpertCoordinator(scope, application) } })
    installAutomaticRetrievalStart(ctx, application, { analyzer }); installWorkingContext(ctx, application)
    installRetrievalTools(ctx, application); installRetrievalRuntimeBudget(ctx, application)
    ctx.on('tools/result', (_exec, result) => { if (result.isError) errors.push(JSON.stringify(result.content)) })
    await ctx.plugin(SessionProjection); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    const agents = new Map<string, Promise<Agent>>()
    const agentFor = (id: string): Promise<Agent> => {
      if (!agents.has(id)) agents.set(id, (async () => {
        const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: selection, setup: async agentCtx => {
          agentCtx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: persona.prefix, complete: persona.complete ?? false })
          if (persona.includeRuntimeContext === false) agentCtx.systemPrompt.suppressRuntimeContext()
        } })
        disposers.push(handle.dispose); return handle.agent
      })())
      return agents.get(id)!
    }
    host = new TaskHost(store, { agentFor, applicationFor: () => application, analyzer, providerFor: () => provider,
      onError: (_job, error) => errors.push(String(error)) })
    server = createServer((request, response) => { void host!.handle(request, response) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable')
    const url = `http://127.0.0.1:${address.port}/api/retrieval-agent/tasks`
    host.start()
    const base = '是否属于“主副卡解绑仍受阻”的范围。仅确认这一范围：包含无法到厅导致解绑受阻；不纳入套餐或关系已解除后仅剩独立合账取消的诉求。请读取原始对话核实。'
    const sourceCases = [
      { name: 'completed-operation-negative', query: '检查工单 ESFT-SUMMARY-TRAIN-007111 ' + base, ids: [] },
      { name: 'blocked-operation-positive', query: '检查工单 ESFT-SUMMARY-TRAIN-024783 ' + base, ids: ['ESFT-SUMMARY-TRAIN-024783'] },
      { name: 'remaining-issue-positive', query: '检查工单 ESFT-SUMMARY-TRAIN-007111 是否属于“套餐解除后仍需取消合账”的范围。只确认这种后续合账诉求，读取原始对话核实。', ids: ['ESFT-SUMMARY-TRAIN-007111'] },
    ]
    const cases = process.env.RETRIEVAL_AGENT_BOUNDARY_CASE === 'broad-topics'
      ? [{ name: 'broad-topics', query: '查找副卡与跨域有关的工单', ids: undefined }]
      : sourceCases
    for (const example of cases) {
      const startedAt = Date.now(), errorOffset = errors.length, id = randomUUID()
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: id, kind: 'query', text: example.query }) })
      expect(response.status).toBe(202)
      let snapshot: TaskSnapshot | undefined
      do {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const response = await fetch(url + '/' + id)
        if (response.status === 503) continue
        expect(response.status).toBe(200); snapshot = await response.json() as TaskSnapshot
        if (snapshot.question || snapshot.failure) break
      } while (!snapshot?.node?.result && Date.now() - startedAt < 240000)
      const task = await store.read(id), agent = await agentFor(id)
      const actual = task?.state_json?.candidates.filter(c => task.state_json!.selectedCandidateRefs.includes(c.ref)).map(c => c.displayId).sort() ?? []
      const record = { name: example.name, taskId: id, baseUrl: url, query: example.query, expectedIds: example.ids, actualIds: actual,
        provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort, elapsedMs: Date.now() - startedAt,
        state: task?.state_json, snapshot, errors: errors.slice(errorOffset) }
      records.push(record)
      await writeFile(`${output}/${example.name}.json`, JSON.stringify(record, null, 2))
      await writeFile(`${output}/${example.name}-events.json`, JSON.stringify(agent.session.snapshotEvents(), null, 2))
      expect.soft(agent.session.deriveMessages().filter(m => m.role === 'system').flatMap(m => m.content.map(b => b.type === 'text' ? b.text : '')).join('\n')).toContain('默认采用标题与摘要优先')
      expect.soft(agent.session.deriveMessages().filter(m => m.role === 'system').flatMap(m => m.content.map(b => b.type === 'text' ? b.text : '')).join('\n')).toContain('用户已回答的口径持续有效')
      expect.soft(snapshot?.question, JSON.stringify(snapshot?.question)).toBeUndefined()
      expect.soft(snapshot?.failure).toBeNull()
      expect.soft(task?.state_json?.phase).toBe('stopped')
      if (example.ids) {
        expect.soft(actual, example.name).toEqual(example.ids)
        expect.soft(task?.state_json?.contextManifests?.some(m => m.measurement === 'dsh_request' && m.evidenceIds.length)).toBe(true)
      } else expect.soft(actual.length, 'Broad topic task should return a useful confirmed set without clarification').toBeGreaterThan(0)
      if (task?.state_json?.phase !== 'stopped') await fetch(url + '/' + id, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: randomUUID(), kind: 'cancel' }) })
    }
  } finally {
    await writeFile(`${output}/run.json`, JSON.stringify({ scope: 'Isolated public source-review tasks, original 19587-ticket SQL/Milvus publication and configured DSH model; no claim of whole-corpus semantic quality.', records, errors }, null, 2))
    await host?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    for (const dispose of disposers) await dispose()
    await ctx.fiber.dispose(); await store.close(); await db.close()
    await admin.query(`DROP DATABASE ${taskDatabase}`); await admin.end()
    if (keyName) { if (previousKey === undefined) delete process.env[keyName]; else process.env[keyName] = previousKey }
  }
}, 780000)
