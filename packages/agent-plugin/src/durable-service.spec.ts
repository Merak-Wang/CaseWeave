import { createServer } from 'node:http'
import { mkdtemp, cp, rm, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { LlmAdapter, CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Skills from '@deepseek-ai/dsh-skill'
import { createPool } from 'mysql2/promise'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import type { TicketRetrievalProvider, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { foldRetrievalEvents } from '@retrieval-agent/domain'
import type { RetrievalRanker } from '@retrieval-agent/model-service-client/ranking'
import type { TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'
import { TaskHost, type TaskSnapshot } from '../../product-host/src/tasks.js'
import { TASK_WORKBENCH_HTML } from '../../product-host/src/workbench.js'
import { callReportModel } from './report-model.js'
import { exportCandidatesForAgent, parseExportCandidatesParams, readTicketDetailsForAgent, parseReadTicketDetailParams } from '../../product-host/src/index.js'
import { InMemoryExportAuditSink, InMemoryDetailReadAuditSink } from '@retrieval-agent/product-api'
import { readRetrievalSessionEvents } from '@retrieval-agent/dsh-compat'
import { DurableRetrievalAgentService } from './durable-service.js'
import { MySqlTaskStore, type TaskJob } from './task-store.js'
import { TicketPrincipalProviderService, TicketRetrievalProviderService } from './provider-services.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { installRetrievalTools } from './tools.js'
import { installRetrievalRuntimeBudget } from './context-budget.js'
import { ExpertCoordinator } from './experts.js'
import { installWorkingContext } from './working-context.js'
import { inject } from './index.js'
import { WikiLearningService } from './wiki-learning.js'
import { openWiki } from './wiki-store.js'
import { checkoutEntry, publishWiki } from './wiki-publisher.js'
import * as piAi from '@retrieval-agent/dsh-compat/opencode-pi-ai'

const enabled = process.env.RETRIEVAL_AGENT_DATABASE_TEST === '1'
const principal = (): TrustedPrincipalContext => ({ tenantId: 'phase2', subjectId: 'operator', entitlementVersion: 'v1', purpose: 'ticket_retrieval', attributes: {}, issuedAt: new Date().toISOString() })
const analyzer: TicketQueryAnalyzer = { analyze: async () => ({ protocolVersion: 'retrieval-agent.models.v1', requestId: 'fixture',
  analyzer: { engine: 'spacy', engineVersion: '1', pipeline: 'fixture', pipelineVersion: '1', lexiconVersion: '1', loaded: true, components: [] },
  language: 'zh', keywords: ['副卡'], candidates: [], tokens: [], entities: [], triples: [], elapsedMs: 0 }) }
const records = ['北京', '上海'].map((region, i) => normalizeFixtureTicket({ ticketId: `t${i + 1}`, displayId: `T-${i + 1}`, tenantId: 'phase2', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'fixture-v1', title: `副卡解绑 ${region}`, summary: `副卡解绑后仍共享流量，${region}工单`, problemDescription: '副卡解绑后仍共享流量', resolutionSteps: ['重新同步解绑状态后恢复'], conversationOrUpdates: [], errorCodes: [], piiRedactionStatus: 'not_applicable', region }))
class Provider extends TicketRetrievalProviderService {
  constructor(ctx: Context, public p: TicketRetrievalProvider) { super(ctx) }
  get providerId() { return this.p.providerId }
  resolve: TicketRetrievalProvider['resolve'] = request => this.p.resolve(request)
  openSnapshot: TicketRetrievalProvider['openSnapshot'] = (...a) => this.p.openSnapshot(...a)
  search: TicketRetrievalProvider['search'] = (...a) => this.p.search(...a)
  readEvidence: TicketRetrievalProvider['readEvidence'] = (...a) => this.p.readEvidence(...a)
  readDetails: TicketRetrievalProvider['readDetails'] = (...a) => this.p.readDetails(...a)
  status: TicketRetrievalProvider['status'] = (...a) => this.p.status(...a)
}
class Principal extends TicketPrincipalProviderService {
  revoked = false
  async resolve() { return { ...principal(), ...(this.revoked ? { entitlementVersion: 'revoked' } : {}) } }
}
class Adapter extends LlmAdapter {
  calls = 0
  readonly loopRequests: GenerateOptions[] = []
  reportCalls = 0
  rejectReport = false
  constructor(readonly ask = false, readonly broken = false) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.tools?.[0]?.name.startsWith('retrieval_report')) {
      this.reportCalls++
      const data = JSON.parse(options.messages[0]!.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(''))
      const name = options.tools[0].name
      const args = name === 'retrieval_report_review' ? { supported: !this.rejectReport, reason: '可见概览支持副卡解绑场景。' }
        : { paragraphs: [{ text: '已确认记录中的副卡解绑场景与本轮要求一致；应结合所列来源范围使用。', citations: [data.citations[0].id] }] }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`report-${this.reportCalls}`), name, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    this.calls++; this.loopRequests.push(options)
    const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
    const text = [...strings(options.messages), options.system ?? ''].join('\n')
    const headers = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)].map(m => JSON.parse(m[1]!))
    const header = headers.findLast(h => h.knowledgeState?.stateId)
    if (!header) throw new Error('missing current state')
    if (this.calls > 8) throw new Error('unexpected model repair loop')
    const ask = this.ask && this.calls === 1
    const shanghai = [...text.matchAll(/<untrusted_ticket_candidate>(.*?)<\/untrusted_ticket_candidate>/gu)].map(m => JSON.parse(m[1]!)).findLast(c => c.displayId === 'T-2')
    if (!shanghai) throw new Error('model was not given Shanghai evidence')
    const args = this.broken ? {} : { state_id: header.knowledgeState.stateId, judgments: ask ? [] : [{ candidate_alias: shanghai.alias, verdict: 'accept', evidence_aliases: [shanghai.alias], reason: '上海副卡解绑场景与用户补充一致。' }],
      semantic_gaps: ask ? [{ kind: 'ambiguity', status: 'open', evidence_aliases: ['c1', 'c2'], description: '地域需要用户确认' }] : [],
      action: ask ? { kind: 'clarify', question: '只看上海还是也包括北京？', candidate_aliases: ['c1', 'c2'], evidence_aliases: ['c1', 'c2'] }
        : { kind: 'finish', reason: 'satisfied', explanation: '上海副卡解绑工单已按可见摘要复核。', coverage: { checked: ['上海地域和副卡解绑摘要'], remaining: [], nextAction: '无其他个案要求', nextActionValue: 'none' } } }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`fixture-${this.calls}`), name: 'ticket_decide', arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 60 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
class DeliveryScaleAdapter extends LlmAdapter {
  calls = 0
  seen = new Set<string>()
  constructor(readonly count: number) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (++this.calls > 300) throw new Error('unexpected delivery scale loop')
    const text = options.messages.flatMap(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : [])).join('\n')
    const header = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)].map(m => JSON.parse(m[1]!)).at(-1).knowledgeState
    const visible = [...text.matchAll(/<untrusted_ticket_candidate>(.*?)<\/untrusted_ticket_candidate>/gu)].map(m => JSON.parse(m[1]!)).filter(c => !this.seen.has(c.alias))
    const fresh = [...new Map(visible.map(c => [c.alias, c])).values()]
    for (const c of fresh) this.seen.add(c.alias)
    const args = { state_id: header.stateId, judgments: fresh.map(c => ({ candidate_alias: c.alias, verdict: 'accept', evidence_aliases: [c.alias], reason: '受控概览明确描述副卡解绑场景。' })), semantic_gaps: [],
      action: this.seen.size >= this.count ? { kind: 'finish', reason: 'satisfied', explanation: '合成语料逐条通过当前概览复核。' } : header.history.accepted + fresh.length < header.retrievalObservation.cumulativeCandidateCount ? { kind: 'inspect', next_window: true } : { kind: 'search', continue_ranking: true } }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`delivery-scale-${this.calls}`), name: 'ticket_decide', arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 2000, outputTokens: 700 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
class RecoveringExpertAdapter extends LlmAdapter {
  calls = 0
  expertCalls = 0
  readonly turns = new Map<string, number>()
  constructor(readonly gate: Promise<void>, readonly assignments?: { domain_id: string; goal: string; scope: string; candidate_aliases: string[]; knowledge_ids: string[] }[]) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings)
      : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
    const text = options.messages.flatMap(m => strings(m.content)).join('\n')
    const state = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)].map(m => JSON.parse(m[1]!)).at(-1).knowledgeState
    const expert = options.tools?.some(t => t.name === 'ticket_expert')
    const step = (this.turns.get(options.sessionId!) ?? 0) + 1; this.turns.set(options.sessionId!, step)
    if (step > 3) throw new Error('unexpected recovery model loop')
    let args: unknown
    if (expert) {
      this.expertCalls++
      const knowledge = [...text.matchAll(/<untrusted_retrieval_knowledge>(.*?)<\/untrusted_retrieval_knowledge>/gu)].map(m => JSON.parse(m[1]!)).at(-1)
      expect(knowledge.assignedCandidateAliases).toEqual(['c1'])
      if (knowledge.scope === '范围确认') args = { action: 'report', judgments: [{ candidate_alias: 'c1', verdict: 'undetermined', evidence_aliases: ['c1'], reason: '地域范围需用户确认。' }],
        semantic_gaps: [{ kind: 'ambiguity', status: 'open', evidence_aliases: ['c1'], description: '是否仅查询上海？' }], question: '是否仅查询上海？', next_action: '由主 Agent 询问范围，独立来源核对继续。' }
      else if (step === 1) args = { action: 'inspect', candidate_aliases: ['c1'], fields: ['resolutionSteps'], judgments: [], semantic_gaps: [] }
      else {
        await this.gate
        args = { action: 'report', judgments: [{ candidate_alias: 'c1', verdict: 'undetermined', evidence_aliases: ['e1'], reason: '处理原文已核对，保留待用户确认的地域范围。' }], semantic_gaps: [], next_action: '来源核对已完成，等待用户确认范围。' }
      }
    } else {
      this.calls++
      args = { state_id: state.stateId, judgments: [], semantic_gaps: step === 1 ? [] : [{ kind: 'ambiguity', status: 'open', evidence_aliases: ['c1'], description: '专家请求确认地域范围。' }],
        action: step === 1 ? { kind: 'delegate', assignments: this.assignments ?? ['范围确认', '独立取证'].map(scope => ({ domain_id: 'general', goal: '核对副卡解绑记录', scope, candidate_aliases: ['c1'] })) }
          : { kind: 'clarify', question: '是否仅查询上海？', candidate_aliases: ['c1'], evidence_aliases: ['c1'] } }
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`recovery-${options.sessionId}-${step}`), name: expert ? 'ticket_expert' : 'ticket_decide', arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 60 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
class LearningAdapter extends Adapter {
  readonly requests: GenerateOptions[] = []
  readonly sourceTurns = new Map<string, number>()
  gate?: Promise<void>
  reject = false
  learnedId: string | undefined
  contradicts: string[] = []
  editedMarker?: string
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++; this.requests.push(options)
    const text = options.messages.flatMap(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : [])).join('\n')
    let name = 'ticket_decide', args: unknown
    if (options.tools?.[0]?.name === 'wiki_propose') {
      name = 'wiki_propose'; const data = JSON.parse(text)
      expect(data.input.sources[0].evidence[0].text).toContain('重新同步')
      expect(data.input.sources[0].verdict).toBe('accept')
      await this.gate
      args = { entries: [{ domain: 'general', title: '副卡解绑后的同步复核', scope: '副卡解绑后仍共享流量的有限复核场景。', keywords: ['副卡', '解绑'],
        observation: this.contradicts.length ? '处理原文记录重新同步后恢复；出现解绑字样不能证明故障仍持续，需核对处理结果。' : '已复核的场景提示检查处理记录中的解绑状态同步，用户标记无关不能代替原文核对。',
        evidenceChecklist: ['核对处理记录是否出现重新同步以及恢复结果。'],
        counterexamples: ['仅咨询流量共享规则、没有解绑处理记录的场景不适用。'], sourceKeys: ['s1'], contradicts: this.contradicts }], reason: '局部经验供后续证据检验。' }
    } else if (options.tools?.[0]?.name === 'wiki_validate') {
      name = 'wiki_validate'; args = { supported: !this.reject, reason: this.reject ? '模拟独立校验拒绝泛化。' : '给定来源支持局部检查步骤。', sourceKeys: ['s1'], contradictedKnowledgeIds: this.contradicts }
    } else {
      const header = [...text.matchAll(/<ticket_knowledge_context>(.*?)<\/ticket_knowledge_context>/gu)].map(m => JSON.parse(m[1]!)).at(-1).knowledgeState
      const isExpert = options.tools?.some(t => t.name === 'ticket_expert')
      const session = String(options.sessionId), step = (this.sourceTurns.get(session) ?? 0) + 1; this.sourceTurns.set(session, step)
      if (step > 8) throw new Error('unexpected learning fixture loop')
      if (isExpert) {
        name = 'ticket_expert'
        const knowledge = [...text.matchAll(/<untrusted_retrieval_knowledge>(.*?)<\/untrusted_retrieval_knowledge>/gu)].map(m => JSON.parse(m[1]!)).at(-1)
        expect(knowledge.entries.some((e: any) => e.id === this.learnedId && e.bodyMarkdown.includes('处理记录中的解绑状态同步'))).toBe(true)
        if (this.editedMarker) expect(knowledge.entries.find((e: any) => e.id === this.learnedId).bodyMarkdown).toContain(this.editedMarker)
        args = { action: 'report', judgments: [{ candidate_alias: 'c2', verdict: 'accept', evidence_aliases: ['c2'], reason: '可见摘要支持副卡场景，知识仍需当前来源检验。' }], semantic_gaps: [], next_action: '主 Agent 继续核对处理原文。' }
      } else if (step === 1 && this.learnedId) args = { state_id: header.stateId, judgments: [], semantic_gaps: [], action: {
        kind: 'delegate', assignments: [{ domain_id: 'general', goal: '核对副卡解绑同步', scope: '核对处理记录', candidate_aliases: ['c2'], knowledge_ids: [this.learnedId] }] } }
      else if (!text.includes('<untrusted_ticket_evidence>')) args = { state_id: header.stateId, judgments: [],
        semantic_gaps: [{ kind: 'depth', status: 'open', evidence_aliases: ['c2'], description: '需核对处理原文中的解绑恢复结果。' }],
        action: { kind: 'inspect', candidate_aliases: ['c2'], fields: ['resolutionSteps'] } }
      else args = { state_id: header.stateId, judgments: [{ candidate_alias: 'c2', verdict: 'accept', evidence_aliases: ['e1'], reason: '重新同步后恢复的来源支持副卡解绑场景，保留相关判断。' }], semantic_gaps: [],
        action: { kind: 'finish', reason: 'satisfied', explanation: '本次个案已读处理原文并复核。', coverage: { checked: ['处理原文与用户反馈'], remaining: [], nextAction: '无其他个案要求', nextActionValue: 'none' } } }
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`learning-${this.calls}`), name, arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 600, outputTokens: 150 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, timeout = 10000): Promise<T> {
  const started = Date.now(); let value: T
  do { value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)) } while (Date.now() - started < timeout)
  throw new Error(`Timed out: ${JSON.stringify(value)}`)
}

describe.skipIf(!enabled)('A5/A7/A8/A13 real MySQL task authority, HTTP and installed DSH loop', () => {
  let store: MySqlTaskStore
  let databaseName: string
  const adminUrl = process.env.RETRIEVAL_AGENT_MYSQL_URL ?? 'mysql://root@127.0.0.1:13306/retrieval_agent'
  beforeEach(async () => {
    databaseName = `ra_phase2_test_${randomUUID().replaceAll('-', '')}`
    const pool = createPool(adminUrl)
    try { await pool.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`) }
    finally { await pool.end() }
    const url = new URL(adminUrl); url.pathname = `/${databaseName}`
    store = new MySqlTaskStore(url.toString()); await store.ready
  })
  afterEach(async () => {
    await store?.close()
    // Workers from another scenario must never claim this scenario's pending recovery jobs.
    if (!/^ra_phase2_test_[a-f0-9]{32}$/u.test(databaseName)) throw new Error('unexpected test database identity')
    const pool = createPool(adminUrl)
    try { await pool.query(`DROP DATABASE ${databaseName}`) }
    finally { await pool.end() }
  })

  it('deduplicates commands, rejects changed payloads, fences expired owners, and persists retry limits', async () => {
    const id = randomUUID(); const p = principal()
    const first = await store.create(id, id, p, '副卡')
    expect(await store.create(id, id, p, '副卡')).toEqual(first)
    await expect(store.create(id, id, p, 'changed')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(store.submit(id, { ...p, subjectId: 'other' }, randomUUID(), { kind: 'cancel' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const original = (await store.claim('first', 70))!
    await new Promise(resolve => setTimeout(resolve, 90))
    const replacement = (await store.claim('second', 5000))!
    expect(replacement.id).toBe(original.id); expect(replacement.fence).toBeGreaterThan(original.fence)
    expect(await store.renew(original)).toBe(false)
    await expect(store.settle(original)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    await store.settle(replacement, 'network down', true)
    await store.pool.query('UPDATE ra_task_job SET available_at=CURRENT_TIMESTAMP(3) WHERE id=?', [replacement.id])
    const third = (await store.claim('third'))!
    await store.settle(third, 'network down', true)
    expect((await store.read(id))?.failure).toBe('network down')
    expect((await store.events(id)).map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('receives feedback while slow search runs; closes/reconnects streams without jobs; stale output cannot win', async () => {
    const f = await fixture(false, true)
    try {
      const id = randomUUID()
      const request = { operationId: id, kind: 'query', text: '找副卡解绑工单' }
      const created = await f.post('', request); expect(created.status).toBe(202)
      expect((await f.post('', request)).body).toEqual(created.body)
      await f.host.pump()
      await until(() => store.read(id), t => Boolean(t?.state_json?.snapshot))
      const feed = new AbortController()
      const stream = await fetch(`${f.url}/${id}/events?after=0`, { signal: feed.signal })
      expect(stream.status).toBe(200); feed.abort()
      const time = performance.now()
      const receipt = await f.post(`/${id}`, { operationId: 'hard-revision', kind: 'supplement', text: '只看上海的工单' })
      expect(receipt.status).toBe(202); expect(performance.now() - time).toBeLessThan(500)
      const saved = (await store.read(id))!
      expect(saved.state_json?.query.confirmedConstraints).toContainEqual({ field: 'region', op: 'eq', value: '上海' })
      expect(saved.state_json?.selectedCandidateRefs).toEqual([])
      f.release()
      const done = await until(async () => { await f.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped')
      expect(done?.state_json?.candidates.map(c => c.displayId)).toEqual(['T-2'])
      expect(done?.state_json?.termination, JSON.stringify(f.errors)).toBe('top_k_accepted')
      expect(f.adapter.calls).toBe(1)
      await until(() => store.rows<TaskJob>("SELECT * FROM ra_task_job WHERE task_id=? AND status IN ('queued','running')", [id]), jobs => jobs.length === 0)
      const state = (await store.read(id))!.state_json!
      const events = await store.domainEvents(id)
      expect(foldRetrievalEvents(events)?.stateId).toBe(state.stateId)
      const before = await store.rows<TaskJob>('SELECT * FROM ra_task_job WHERE task_id=?', [id])
      await f.host.snapshot(id); await f.host.snapshot(id)
      expect(await store.rows<TaskJob>('SELECT * FROM ra_task_job WHERE task_id=?', [id])).toEqual(before)
      f.principal.revoked = true
      await expect(f.host.snapshot(id)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    } finally { f.release(); await f.close() }
  })

  it('persists a real DSH question, binds answers to its identity, and reopens terminal feedback for review', async () => {
    const f = await fixture(true, false)
    try {
      const id = randomUUID(); await f.post('', { kind: 'query', operationId: id, text: '找副卡解绑工单' })
      const waiting = await until(async () => { await f.host.pump(); return f.host.snapshot(id) }, s => Boolean(s.question))
      expect(waiting.question?.question_json).toMatchObject({ question: '只看上海还是也包括北京？' })
      expect((await f.post(`/${id}`, { kind: 'answer', operationId: 'stale-answer', text: '上海', questionId: 'old-question' })).status).toBe(409)
      const reply = { kind: 'answer', operationId: 'correct-answer', text: '只看上海的工单', questionId: waiting.question!.id }
      expect((await f.post(`/${id}`, reply)).status).toBe(202)
      expect((await f.post(`/${id}`, reply)).status).toBe(202)
      const final = await until(async () => { await f.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped')
      expect(final?.state_json?.termination, JSON.stringify(f.errors)).toBe('top_k_accepted')
      expect(final?.state_json?.selectedCandidateRefs).toHaveLength(1)
      const resultRevision = final!.state_json!.frozenEvidence!.packId
      const ref = final!.state_json!.selectedCandidateRefs[0]!
      const marked = await f.post(`/${id}`, { kind: 'feedback', operationId: 'user-mark', text: '这个可能不相关，请复核。', candidateRef: ref, relevance: 'unrelated' })
      expect(marked.status).toBe(202)
      expect((await store.commands(id)).find(c => c.kind === 'feedback')).toMatchObject({
        kind: 'feedback', candidateRef: ref, relevance: 'unrelated', text: '这个可能不相关，请复核。' })
      expect((await store.read(id))?.state_json?.frozenEvidence).toBeUndefined()
      expect((await store.read(id))?.state_json?.selectedCandidateRefs).toEqual([])
      const reviewed = await until(async () => { await f.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped')
      expect(reviewed?.state_json?.frozenEvidence?.packId).not.toBe(resultRevision)
      expect(reviewed?.state_json?.selectedCandidateRefs).toEqual([ref])
      expect(f.adapter.calls).toBe(3)
      if (!(f.adapter instanceof Adapter)) throw new Error('Expected feedback fixture adapter')
      const resumedMessages = f.adapter.loopRequests[2]!.messages
      expect(resumedMessages.some(m => m.role === 'assistant')).toBe(false)
      expect(JSON.stringify(resumedMessages)).toContain('这个可能不相关，请复核。')
      const agent = await f.agentFor(id)
      expect(agent.session.events.some(e => e.type === 'assistant/message')).toBe(true)
    } finally { await f.close() }
  })

  it('restores a committed confirmed result into an empty DSH mirror without re-running the model or changing export identity', async () => {
    const id = randomUUID(); const first = await fixture(false, false)
    let revision: string
    try {
      await first.post('', { kind: 'query', operationId: id, text: '找上海副卡解绑工单' })
      await until(async () => { await first.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped')
      await until(() => store.rows<TaskJob>("SELECT * FROM ra_task_job WHERE task_id=? AND status IN ('queued','running')", [id]), jobs => jobs.length === 0)
      revision = (await store.read(id))!.state_json!.frozenEvidence!.packId
      const stored = (await store.rows<{ state_json: { candidates: unknown[] } }>('SELECT state_json FROM ra_task WHERE id=?', [id]))[0]!
      expect(stored.state_json.candidates[0]).toMatchObject({ $raArtifact: { kind: 'candidate' } })
      expect((await store.rows<{ n: number }>('SELECT COUNT(*) n FROM ra_task_candidate WHERE task_id=?', [id]))[0]!.n).toBeGreaterThan(0)
      expect((await store.rows<{ n: number }>('SELECT COUNT(*) n FROM ra_task_context WHERE task_id=?', [id]))[0]!.n).toBeGreaterThan(0)
      expect((await first.exportCsv(id, revision)).status).toBe(200)
    } finally { await first.close() }
    const restarted = await fixture(false, false)
    try {
      const restored = await restarted.host.snapshot(id)
      expect(restored.node?.result?.resultRevision).toBe(revision!)
      await restarted.host.pump(); expect(restarted.adapter.calls).toBe(0)
      const agent = await restarted.agentFor(id)
      await Promise.all([restarted.application.mirror(agent), restarted.application.mirror(agent)])
      const domain = await store.domainEvents(id)
      expect(readRetrievalSessionEvents(agent.session).map(e => e.eventId)).toEqual(domain.map(e => e.eventId))
      expect(await store.domainEvents(id, store.pool, domain.length - 3)).toEqual(domain.slice(-2))
      await restarted.application.mirror(agent)
      expect(readRetrievalSessionEvents(agent.session).map(e => e.eventId)).toEqual(domain.map(e => e.eventId))
      expect(domain.filter(e => e.type === 'retrieval/exported')).toHaveLength(1)
      const exported = await restarted.exportCsv(id, revision!)
      expect(exported.status).toBe(200)
      expect(exported.body.receipt).toMatchObject({ rowCount: 1, resultRevision: revision! })
      const current = (await store.read(id))!.state_json!
      expect(foldRetrievalEvents(await store.domainEvents(id))?.stateId).toBe(current.stateId)
      expect(current.frozenEvidence?.packId).toBe(revision!)
      const newer = randomUUID()
      await store.create(newer, id, principal(), '新的宽带查询')
      try {
        expect((await restarted.host.snapshot(id)).node?.result?.resultRevision).toBe(revision!)
        expect((await restarted.exportCsv(id, revision!)).status).toBe(200)
        expect((await store.forSession(id))?.id).toBe(newer)
      } finally { await store.submit(newer, principal(), 'cancel-unused', { kind: 'cancel' }) }
      const newerBefore = await store.read(newer)
      expect((await restarted.post(`/${id}`, { kind: 'supplement', operationId: 'review-history', text: '请结合解绑后的流量情况复核' })).status).toBe(202)
      const reviewed = await until(async () => { await restarted.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped')
      expect(reviewed?.state_json?.frozenEvidence?.packId).not.toBe(revision!)
      expect(reviewed?.state_json?.selectedCandidateRefs).toEqual(current.selectedCandidateRefs)
      expect(await store.read(newer)).toEqual(newerBefore)
      expect(restarted.adapter.calls).toBe(1)
    } finally { await restarted.close() }
  })

  it('keeps independent result pages moving while the decision branch waits for its question', async () => {
    const f = await fixture(true, false, true)
    try {
      const id = randomUUID(); await f.post('', { kind: 'query', operationId: id, text: '找副卡解绑工单' })
      const waiting = await until(async () => { await f.host.pump(); return f.host.snapshot(id) }, s => Boolean(s.question))
      const filled = await until(async () => { await f.host.pump(); return f.host.snapshot(id) }, s => s.node?.candidates.length === 3)
      expect(filled.question?.id).toBe(waiting.question!.id)
      expect((await store.read(id))?.state_json?.phase).toBe('awaiting_clarification')
      expect(f.adapter.calls).toBe(1)
      expect((await store.rows<TaskJob>('SELECT * FROM ra_task_job WHERE task_id=? AND kind=?', [id, 'agent']))[0]?.status).toBe('waiting')
      expect(foldRetrievalEvents(await store.domainEvents(id))?.candidates).toHaveLength(3)
      await f.post(`/${id}`, { kind: 'cancel', operationId: 'cancel-wait' })
    } finally { await f.close() }
  })

  it('resumes an independent expert after host replacement without rerunning the waiting main or losing its question', async () => {
    const first = await fixture(false, false, false, true)
    const id = randomUUID()
    let questionId: string | undefined; let firstChild: string | undefined; let resumedTaskId: string | undefined
    try {
      expect((await first.post('', { kind: 'query', operationId: id, text: '查找副卡解绑工单并复核地域范围' })).status).toBe(202)
      await until(async () => { await first.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'awaiting_clarification' && t.state_json.expertTasks?.some(e => e.scope === '独立取证' && e.actionsUsed === 1) === true)
        .catch(async error => {
          await mkdir('output/orchestration', { recursive: true })
          await writeFile('output/orchestration/recovery-failure.json', JSON.stringify({ error: String(error), task: await store.read(id), events: await store.events(id), errors: first.errors }, null, 2))
          throw new Error(`Question did not arrive: ${JSON.stringify(first.errors)}`)
        })
      const before = (await store.read(id))!.state_json!
      questionId = (await store.question(id))!.id
      const independent = before.expertTasks!.find(e => e.scope === '独立取证')!
      firstChild = independent.childSessionId; resumedTaskId = independent.id
      expect(independent.status).toBe('running')
      const closing = first.host.close()
      await until(() => store.rows<TaskJob>('SELECT * FROM ra_task_job WHERE task_id=? AND kind=?', [id, 'agent']), jobs => jobs[0]?.status === 'queued')
      first.release(); await closing
      expect((await store.read(id))!.state_json!.expertTasks!.find(e => e.id === resumedTaskId)!.status).toBe('running')
    } finally { first.release(); await first.close() }
    const restarted = await fixture(false, false, false, true); restarted.release()
    try {
      const done = await until(async () => { await restarted.host.pump(); return store.read(id) }, t => t?.state_json?.expertTasks?.every(e => e.status === 'completed') === true)
      const current = done!.state_json!
      expect(current.phase).toBe('awaiting_clarification')
      expect((await restarted.host.snapshot(id)).question?.id).toBe(questionId)
      expect(restarted.adapter.calls).toBe(0)
      expect(current.expertTasks?.find(e => e.id === resumedTaskId)?.childSessionId).not.toBe(firstChild)
      expect(current.promotedEvidence).toHaveLength(1)
      const expertResponse = await fetch(restarted.url + '/' + id + '/experts/' + resumedTaskId)
      expect(expertResponse.status).toBe(200)
      const expertView = await expertResponse.json() as any
      expect(expertView).toMatchObject({ id: resumedTaskId, status: 'completed', scope: '独立取证', judgmentCount: 1 })
      expect(expertView.judgments[0].evidenceRefs).toEqual([current.promotedEvidence[0]!.evidenceId])
      expect(expertView.candidates[0].ref).toBe(expertView.judgments[0].candidateRef)
      expect(current.contextManifests?.some(m => m.roleId === resumedTaskId && m.measurement === 'dsh_request' && m.evidenceIds.length === 1)).toBe(true)
      expect(foldRetrievalEvents(await store.domainEvents(id))?.expertTasks).toEqual(current.expertTasks)
      await until(() => store.rows<TaskJob>('SELECT * FROM ra_task_job WHERE task_id=? AND kind=?', [id, 'agent']), jobs => jobs[0]?.status === 'waiting')
      expect(restarted.errors).toEqual([])
    } finally { await restarted.post(`/${id}`, { kind: 'cancel', operationId: 'stop-recovery-fixture' }); await restarted.close() }
  }, 25000)

  it('ends repeated invalid model decisions as a durable resource interruption without confirming candidates', async () => {
    const f = await fixture(false, false, false, false, true)
    try {
      const id = randomUUID()
      expect((await f.post('', { kind: 'query', operationId: id, text: '找副卡解绑工单' })).status).toBe(202)
      const stopped = await until(async () => { await f.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped')
      const state = stopped!.state_json!
      expect(state.termination).toBe('budget_exhausted')
      expect(state.stopExplanation).toContain('连续 3 次')
      expect(state.selectedCandidateRefs).toEqual([])
      expect(f.adapter.calls).toBe(3)
      expect(state.budget.consecutiveToolErrors).toBe(3)
      expect((await f.host.snapshot(id)).node).toBeDefined()
      await until(() => store.rows<TaskJob>("SELECT * FROM ra_task_job WHERE task_id=? AND status IN ('queued','running')", [id]), jobs => jobs.length === 0)
      expect(foldRetrievalEvents(await store.domainEvents(id))?.termination).toBe('budget_exhausted')
      expect((await f.post(`/${id}`, { kind: 'supplement', operationId: 'retry-invalid-model', text: '请重新核对原始工单' })).status).toBe(202)
      expect((await store.read(id))?.state_json?.budget.consecutiveToolErrors).toBe(0)
      await until(async () => { await f.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped')
      expect(f.adapter.calls).toBe(6)
      expect((await store.read(id))?.state_json?.termination).toBe('budget_exhausted')
    } finally { await f.close() }
  })

  it('A9 UI: public orchestration exposes parallel work and pinned knowledge with actual request citations', async () => {
    const f = await fixture(false, false, false, true, false, undefined, 0, path.resolve('wiki'))
    const id = randomUUID(), completionFile = `output/orchestration/browser-finished-${id}`
    try {
      await f.post('', { operationId: id, kind: 'query', text: '界面验收：核对副卡业务边界与原文，地域范围需要补充。' })
      f.host.start()
      await until(() => store.read(id), t => t?.state_json?.expertTasks?.filter(e => e.status === 'running' && e.actionsUsed > 0).length === 2
        && t.state_json.expertTasks.some(e => e.status === 'completed')
        && t.state_json.expertTasks.every(e => t.state_json!.contextManifests?.some(m => m.roleId === e.id && m.measurement === 'dsh_request')))
      const snapshot = await (await fetch(f.url + '/' + id)).json() as any
      expect(snapshot.orchestration.experts).toHaveLength(3)
      expect(snapshot.orchestration.stage).toBe('experts')
      expect(snapshot.orchestration.experts.filter((e: any) => e.status === 'running')).toHaveLength(2)
      expect(snapshot.orchestration.experts.every((e: any) => e.knowledge.some((k: any) => k.used))).toBe(true)
      expect(JSON.stringify(snapshot.orchestration)).not.toContain('system-prompt')
      const catalogResponse = await fetch(f.url + '/' + id + '/knowledge')
      expect(catalogResponse.status).toBe(200)
      const catalog = await catalogResponse.json() as any
      const entry = catalog.domains[0].entries[0]
      const detailResponse = await fetch(f.url + '/' + id + '/knowledge/' + entry.id)
      const detail = await detailResponse.json() as any
      expect(detailResponse.status).toBe(200)
      expect(detail.entry.reference).toBe(entry.reference)
      expect(detail.entry.bodyMarkdown.length).toBeGreaterThan(20)
      expect(detail.entry.isTicketEvidence).toBe(false)
      expect((await fetch(f.url + '/' + id + '/knowledge/not-in-this-release')).status).toBe(400)
      await mkdir('output/orchestration', { recursive: true })
      await writeFile('output/orchestration/public-entry.json', JSON.stringify({ url: f.url.replace('/api/retrieval-agent/tasks', '/retrieval') + '?task=' + id,
        completionFile, snapshot, catalog, detail }, null, 2))
      if (process.env.RETRIEVAL_AGENT_ORCHESTRATION_BROWSER === '1') await until(async () => { try { return await readFile(completionFile, 'utf8') } catch { return '' } }, s => s === 'done', 900000)
      f.release()
      await until(() => store.read(id), t => t?.state_json?.expertTasks?.every(e => e.status === 'completed') === true)
      const complete = await (await fetch(f.url + '/' + id)).json() as any
      expect(complete.orchestration.counts.completedExperts).toBe(3)
      expect(foldRetrievalEvents(await store.domainEvents(id))?.expertTasks).toEqual((await store.read(id))!.state_json!.expertTasks)
      await f.post('/' + id, { operationId: randomUUID(), kind: 'cancel' })
      const stopped = await (await fetch(f.url + '/' + id)).json() as any
      expect(stopped.orchestration).toMatchObject({ terminal: true, outcome: 'cancelled' })
      expect(stopped.orchestration.experts).toHaveLength(3)
      await f.post('/' + id, { operationId: randomUUID(), kind: 'supplement', text: '仅查询上海地区。' })
      const revised = await (await fetch(f.url + '/' + id)).json() as any
      expect(revised.orchestration.inputGeneration).toBeGreaterThan(stopped.orchestration.inputGeneration)
      expect(revised.orchestration.experts).toEqual([])
      f.principal.revoked = true
      expect((await fetch(f.url + '/' + id + '/knowledge/' + entry.id)).status).not.toBe(200)
    } catch (error) {
      const state = (await store.read(id))?.state_json
      await mkdir('output/orchestration', { recursive: true })
      await writeFile('output/orchestration/failure.json', JSON.stringify({ error: String(error).slice(0, 400), errors: f.errors,
        experts: state?.expertTasks, manifests: state?.contextManifests?.map(m => ({ role: m.roleId, measurement: m.measurement, knowledgeRefs: m.knowledgeRefs })) }, null, 2))
      throw error
    } finally { f.release(); await f.close() }
  }, 930000)

  it('A11: HTTP feedback review publishes asynchronously, next DSH expert consumes it, and new input withdraws the old observation', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ra-wiki-http-')), root = path.join(temp, 'wiki')
    await cp('wiki', root, { recursive: true })
    await store.close(); const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`
    store = new MySqlTaskStore(databaseUrl.toString(), true)
    const adapter = new LearningAdapter()
    const f = await fixture(false, false, false, false, false, { root, adapter })
    try {
      const id = randomUUID()
      await f.post('', { operationId: id, kind: 'query', text: '找副卡解绑工单' })
      await until(async () => { await f.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped')
      // Marking feedback starts a new evidence review; the model may retain its supported judgment.
      expect((await store.read(id))!.state_json!.termination, JSON.stringify(f.errors)).toBe('top_k_accepted')
      const candidateRef = (await store.read(id))!.state_json!.candidates[1]!.ref
      await f.post(`/${id}`, { operationId: 'feedback', kind: 'feedback', text: '这个可能不相关，请核对处理原文。', candidateRef, relevance: 'unrelated' })
      let release!: () => void; adapter.gate = new Promise(resolve => { release = resolve })
      await until(async () => { await f.host.pump(); return store.read(id) }, t => t?.input_revision === 2 && t.state_json?.phase === 'stopped')
      expect((await store.read(id))!.state_json!.termination, JSON.stringify(f.errors)).toBe('top_k_accepted')
      await until(async () => { await f.host.pump(); return store.learningStatus(id) }, s => s?.status === 'running')
      const state = (await store.read(id))!.state_json!
      expect((await f.exportCsv(id, state.frozenEvidence!.packId)).status).toBe(200)
      release()
      await until(async () => { await f.host.pump(); const status = await store.learningStatus(id);
        if (status?.status === 'failed') throw new Error(JSON.stringify(f.errors)); return status }, s => s?.status === 'published')
      const record = (await store.learningRecords(id))[0]!
      const learnedId = (record.details_json.entryIds as string[])[0]!
      let wiki = await openWiki(root)
      expect(wiki.read(learnedId).bodyMarkdown).toContain('不代表普遍业务规则')
      expect(JSON.stringify(wiki.read(learnedId))).not.toContain(candidateRef)
      expect((record.details_json.input as any).sources[0].feedback[0].relevance).toBe('unrelated')
      const edited = await checkoutEntry(root, learnedId)
      adapter.editedMarker = '文件补充：将问题描述与处理结果分别核对。'
      edited.changes[0]!.entry!.bodyMarkdown += `\n\n${adapter.editedMarker}`
      await publishWiki(root, edited)
      wiki = await openWiki(root)
      adapter.learnedId = learnedId
      const nextId = randomUUID()
      await f.post('', { operationId: nextId, kind: 'query', text: '找副卡解绑工单' })
      await until(async () => { await f.host.pump(); return store.read(nextId) }, t => t?.state_json?.phase === 'stopped')
      expect((await store.read(nextId))!.state_json!.termination, JSON.stringify(f.errors)).toBe('top_k_accepted')
      expect((await store.read(nextId))!.state_json!.contextManifests?.some(m => m.measurement === 'dsh_request' && m.roleId !== 'main'
        && m.knowledgeRefs.includes(wiki.read(learnedId).reference))).toBe(true)
      // Stop the second task before it learns another copy; new input invalidates the source task's old release.
      await f.post(`/${nextId}`, { operationId: 'cancel-next', kind: 'cancel' })
      adapter.learnedId = undefined
      // Simulate the recoverable file/SQL crash window: validated IDs persisted before file commit,
      // but the transaction recording release_id was lost. New input still retracts those IDs.
      await store.pool.query("UPDATE ra_wiki_learning SET status='validated',release_id=NULL WHERE task_id=? AND input_revision=2", [id])
      await f.post(`/${id}`, { operationId: 'cancel-source', kind: 'cancel' })
      await until(async () => { await f.host.pump(); return openWiki(root) }, w => !w.catalog().flatMap(d => d.knowledgeRefs).includes(learnedId))
      expect((await openWiki(root, { releaseId: wiki.releaseId! })).read(learnedId).reference).toBe(wiki.read(learnedId).reference)
      expect(f.errors).toEqual([])
    } finally { await f.close(); await rm(temp, { recursive: true, force: true }) }
  }, 30000)

  it('A11: the durable source scanner withdraws learned knowledge when the provider source changes', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ra-wiki-source-')), root = path.join(temp, 'wiki')
    await cp('wiki', root, { recursive: true })
    await store.close(); const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`
    store = new MySqlTaskStore(databaseUrl.toString(), true)
    const adapter = new LearningAdapter()
    const f = await fixture(false, false, false, false, false, { root, adapter })
    try {
      const id = randomUUID()
      await f.post('', { operationId: id, kind: 'query', text: '找副卡解绑工单' })
      await until(async () => { await f.host.pump(); return store.learningStatus(id) }, s => s?.status === 'published')
      const learned = ((await store.learningRecords(id))[0]!.details_json.entryIds as string[])[0]!
      const before = await openWiki(root)
      // A new snapshot with the same source identity must keep the observation.
      await store.scheduleSourceChecks()
      await until(async () => { await f.host.pump(); return store.rows<{ status: string }>("SELECT status FROM ra_task_job WHERE task_id=? AND kind='source_check'", [id]) }, r => r[0]?.status === 'completed')
      expect((await store.learningRecords(id))[0]!.status).toBe('published')
      const calls = adapter.requests.length
      f.replaceSource()
      // Advance only the scheduler's deadline, leaving source/state identities untouched.
      await store.pool.query("UPDATE ra_task_job SET available_at=CURRENT_TIMESTAMP(3) WHERE task_id=? AND kind='source_check'", [id])
      await store.scheduleSourceChecks()
      await until(async () => { await f.host.pump(); return store.learningRecords(id) }, r => r[0]?.status === 'invalidated')
      expect(() => (before.read(learned))).not.toThrow()
      expect((await openWiki(root)).catalog().flatMap(d => d.knowledgeRefs)).not.toContain(learned)
      expect(adapter.requests.length).toBe(calls)
      expect(f.errors).toEqual([])
    } finally { await f.close(); await rm(temp, { recursive: true, force: true }) }
  }, 30000)

  it('A11: a replacement Host resumes the leased learner without reopening the result or repeating the retrieval', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ra-wiki-recovery-')), root = path.join(temp, 'wiki')
    await cp('wiki', root, { recursive: true })
    await store.close(); const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`
    store = new MySqlTaskStore(databaseUrl.toString(), true)
    const firstAdapter = new LearningAdapter()
    let release!: () => void; firstAdapter.gate = new Promise(resolve => { release = resolve })
    const first = await fixture(false, false, false, false, false, { root, adapter: firstAdapter })
    let replacement: Awaited<ReturnType<typeof fixture>> | undefined
    let firstClosed = false
    try {
      const id = randomUUID()
      await first.post('', { operationId: id, kind: 'query', text: '找副卡解绑工单' })
      await until(async () => { await first.host.pump(); return firstAdapter.requests }, r => r.some(o => o.tools?.[0]?.name === 'wiki_propose'))
      const resultRevision = (await store.read(id))!.state_json!.frozenEvidence!.packId
      const closed = first.close(); release(); await closed; firstClosed = true
      const adapter = new LearningAdapter()
      replacement = await fixture(false, false, false, false, false, { root, adapter })
      await until(async () => { await replacement!.host.pump(); return store.learningStatus(id) }, s => s?.status === 'published')
      expect(adapter.sourceTurns.size).toBe(0)
      expect((await store.read(id))!.state_json!.frozenEvidence!.packId).toBe(resultRevision)
      expect((await replacement.exportCsv(id, resultRevision)).status).toBe(200)
      expect((await store.rows<{ attempts: number }>("SELECT attempts FROM ra_task_job WHERE task_id=? AND kind='learn'", [id]))[0]!.attempts).toBe(2)
      expect(replacement.errors).toEqual([])
    } finally { release(); if (!firstClosed) await first.close(); await replacement?.close(); await rm(temp, { recursive: true, force: true }) }
  }, 30000)

  it('A11: an evidence-backed counterexample automatically replaces an incorrect prior', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ra-wiki-correction-')), root = path.join(temp, 'wiki')
    await cp('wiki', root, { recursive: true })
    const draft = await checkoutEntry(root, 'primary-secondary-card-suspension')
    draft.changes[0]!.entry!.bodyMarkdown = '错误测试先验：只要出现副卡解绑字样就代表故障仍持续。'
    const wrong = await publishWiki(root, draft)
    await store.close(); const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`
    store = new MySqlTaskStore(databaseUrl.toString(), true)
    const adapter = new LearningAdapter(); adapter.contradicts = ['primary-secondary-card-suspension']
    const f = await fixture(false, false, false, false, false, { root, adapter })
    try {
      const id = randomUUID()
      await f.post('', { operationId: id, kind: 'query', text: '找副卡解绑工单' })
      await until(async () => { await f.host.pump(); return store.learningStatus(id) }, s => s?.status === 'published')
      const learned = ((await store.learningRecords(id))[0]!.details_json.entryIds as string[])[0]!
      const wiki = await openWiki(root)
      expect(wiki.read(learned).supersedes).toEqual(['primary-secondary-card-suspension'])
      expect(wiki.read(learned).bodyMarkdown).toContain('不能证明故障仍持续')
      expect(() => wiki.read('primary-secondary-card-suspension')).toThrow()
      expect((await openWiki(root, { releaseId: wrong.releaseId })).read('primary-secondary-card-suspension').bodyMarkdown).toContain('错误测试先验')
      expect(f.errors).toEqual([])
    } finally { await f.close(); await rm(temp, { recursive: true, force: true }) }
  }, 30000)

  it('A11: stale learner output cannot publish; rejected validation leaves downloads available', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ra-wiki-stale-')), root = path.join(temp, 'wiki')
    await cp('wiki', root, { recursive: true })
    const base = (await openWiki(root)).releaseId
    await store.close(); const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`
    store = new MySqlTaskStore(databaseUrl.toString(), true)
    const adapter = new LearningAdapter()
    let release!: () => void; adapter.gate = new Promise(resolve => { release = resolve })
    const f = await fixture(false, false, false, false, false, { root, adapter })
    try {
      const id = randomUUID()
      await f.post('', { operationId: id, kind: 'query', text: '找副卡解绑工单' })
      await until(async () => { await f.host.pump(); return adapter.requests }, r => r.some(o => o.tools?.[0]?.name === 'wiki_propose'))
      const previous = (await store.read(id))!.state_json!.frozenEvidence!.packId
      const response = await f.post(`/${id}`, { operationId: 'new-input', kind: 'supplement', text: '请再次核对处理结论。' })
      expect(response.status).toBe(202)
      expect((await f.exportCsv(id, previous)).status).toBe(409)
      adapter.reject = true; release()
      await until(async () => { await f.host.pump(); return store.learningStatus(id) }, s => s?.status === 'rejected')
      expect((await openWiki(root)).releaseId).toBe(base)
      const current = (await store.read(id))!
      expect(current.failure).toBeNull()
      expect((await f.exportCsv(id, current.state_json!.frozenEvidence!.packId)).status).toBe(200)
      expect((await store.rows<{ status: string }>("SELECT status FROM ra_task_job WHERE task_id=? AND kind='learn' AND input_revision=1", [id]))[0]!.status).toBe('superseded')
    } finally { release(); await f.close(); await rm(temp, { recursive: true, force: true }) }
  }, 30000)

  it.skipIf(process.env.RETRIEVAL_AGENT_WIKI_REAL_MODEL !== '1')('A11 real configured DSH model: public source review, feedback and knowledge publication', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ra-wiki-real-')), root = path.join(temp, 'wiki')
    await mkdir(root)
    await store.close(); const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`
    store = new MySqlTaskStore(databaseUrl.toString(), true)
    const f = await fixture(false, false, false, false, false, { root, adapter: new LearningAdapter(), live: true })
    const taskIds: string[] = []
    try {
      const id = randomUUID(); taskIds.push(id)
      await f.post('', { operationId: id, kind: 'query', text: '只需找1条副卡解绑后仍共享流量的工单，请读取处理记录，再根据原文确认。' })
      await until(async () => { await f.host.pump(); return store.read(id) }, t => t?.state_json?.phase === 'stopped' || t?.state_json?.phase === 'awaiting_clarification', 180000)
      const first = (await store.read(id))!.state_json!
      expect(first.termination, JSON.stringify({ reason: first.stopExplanation, errors: f.errors })).toBe('top_k_accepted')
      expect(first.selectedCandidateRefs).toHaveLength(1)
      await f.post(`/${id}`, { operationId: 'real-feedback', kind: 'feedback', candidateRef: first.selectedCandidateRefs[0], relevance: 'unrelated',
        text: '处理记录说重新同步后恢复了，是否还符合我的查询？请根据原文复核这个相关性标记。' })
      await until(async () => {
        await f.host.pump()
        const snapshot = await (await fetch(`${f.url}/${id}`)).json() as TaskSnapshot
        if (snapshot.question) await f.post(`/${id}`, { operationId: 'real-scope-answer', kind: 'answer', questionId: snapshot.question.id,
          text: '查询历史上报过这一问题的工单，已处理恢复的也包括，只需1条。请引用原文复核。' })
        return store.learningStatus(id)
      }, s => !!s && ['published', 'skipped', 'rejected', 'failed'].includes(s.status), 240000)
      const state = (await store.read(id))!.state_json!
      expect(state.termination).toBe('top_k_accepted')
      expect((await f.exportCsv(id, state.frozenEvidence!.packId)).status).toBe(200)
      expect((await store.learningStatus(id))?.status, JSON.stringify(f.errors)).toBe('published')
      const next = randomUUID(); taskIds.push(next)
      await f.post('', { operationId: next, kind: 'query', text: '请让领域专家协助查找1条副卡解绑后共享流量异常的工单，结合可用的检索经验读取处理原文并复核。' })
      await until(async () => { await f.host.pump(); return store.read(next) }, t => t?.state_json?.phase === 'stopped' || t?.state_json?.phase === 'awaiting_clarification', 180000)
      const after = (await store.read(next))!.state_json!
      expect(after.termination, JSON.stringify(f.errors)).toBe('top_k_accepted')
      expect(after.contextManifests?.some(m => m.measurement === 'dsh_request' && m.roleId !== 'main' && m.knowledgeRefs.some(r => r.includes('learned-')))).toBe(true)
    } finally {
      await mkdir('output/phase4-wiki', { recursive: true })
      await writeFile('output/phase4-wiki/real-model.json', JSON.stringify({ scope: 'Synthetic ticket Provider and analyzer; actual configured DSH semantic model. No business recall claim.',
        tasks: await Promise.all(taskIds.map(async id => ({ id, task: await store.read(id), learning: await store.learningRecords(id) }))), errors: f.errors }, null, 2))
      await f.close(); await rm(temp, { recursive: true, force: true })
    }
  }, 660000)

  it('A14 phase5: public report, controlled full JSONL, durable recovery, revision and grant fences', async () => {
    const f = await fixture(true, false)
    f.host.start()
    try {
      const id = randomUUID()
      await f.post('', { operationId: id, kind: 'query', text: '找副卡解绑工单' })
      const ask = await until(() => f.host.snapshot(id), s => Boolean(s.question))
      await f.post('/' + id, { operationId: randomUUID(), kind: 'answer', text: '只看上海', questionId: ask.question!.id })
      const done = await until(() => f.host.snapshot(id), s => Boolean(s.node?.result))
      const revision = done.node!.result!.resultRevision
      const get = async (suffix: string) => { const r = await fetch(f.url + '/' + id + suffix); return { status: r.status, body: await r.json() } }
      const window = await get('/candidates?view=confirmed&limit=1')
      expect(window.body.total).toBe(1); expect(window.body.items[0].displayId).toBe('T-2')
      const evidence = await get('/evidence?candidateRef=' + encodeURIComponent(window.body.items[0].ref))
      expect(evidence.status).toBe(200)
      expect(evidence.body).toMatchObject({ displayId: 'T-2', judgment: { verdict: 'accept' } })
      expect(evidence.body.citationCount).toBeGreaterThan(0)
      expect((await get('/evidence?candidateRef=forged')).status).toBe(400)
      const reads = await Promise.all(Array.from({ length: 3 }, () => fetch(f.url.replace('/tasks', '/detail'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, retrievalId: id,
          candidateRefs: [window.body.items[0].ref], fields: ['problemDescription'] }),
      })))
      expect(reads.map(r => r.status)).toEqual([200, 200, 200])
      expect((await f.host.snapshot(id)).node!.result!.resultRevision).toBe(revision)
      const spec = { operationId: randomUUID(), kind: 'jsonl', template: 'full', audience: 'operator', resultRevision: revision }
      const created = await f.post('/' + id + '/artifacts', spec)
      expect(created.status).toBe(202)
      expect((await f.post('/' + id + '/artifacts', spec)).body.id).toBe(created.body.id)
      expect((await f.post('/' + id + '/artifacts', { ...spec, kind: 'csv' })).status).toBe(400)
      expect((await f.post('/' + id + '/artifacts', { ...spec, candidateRefs: ['unconfirmed'] })).status).toBe(400)
      const ready = await until(() => get('/artifacts/' + created.body.id), r => r.body.status === 'ready')
      const response = await fetch(f.url + '/' + id + '/artifacts/' + created.body.id + '/content')
      expect(response.status).toBe(200)
      const content = await response.text(), row = JSON.parse(content)
      expect(row.ticketId).toBe('T-2'); expect(row.resultRevision).toBe(revision)
      expect(row.fields.resolutionSteps).toEqual(['重新同步解绑状态后恢复'])
      expect(row.fields).not.toHaveProperty('source.raw')
      expect(createHash('sha256').update(content).digest('hex')).toBe(ready.body.contentSha256)
      const request = await f.post('/' + id + '/artifacts', { ...spec, operationId: randomUUID(), kind: 'report', audience: 'handoff' })
      await until(() => get('/artifacts/' + request.body.id), r => r.body.status === 'ready')
      const narrative = await get('/report?resultRevision=' + revision + '&audience=handoff')
      expect(narrative.status, JSON.stringify(narrative.body)).toBe(200)
      expect(narrative.body.narrative.status).toBe('model'); expect(narrative.body.confirmedCount).toBe(1)
      expect(narrative.body.examples.map((e: any) => e.displayId)).toEqual(['T-2'])
      expect((f.adapter as Adapter).reportCalls).toBe(2)
      const manifest = await get('/artifacts/' + created.body.id + '/manifest')
      expect(manifest.body.report.confirmedCount).toBe(1)
      // The stored body must survive a new Host/store facade, with a new access check.
      const restored = new TaskHost(store, f.host.options)
      try {
        expect((await restored.deliveries!.get(id, String(created.body.id))).content_sha256).toBe(ready.body.contentSha256)
      } finally { await restored.close() }
      await f.post('/' + id, { operationId: randomUUID(), kind: 'supplement', text: '再核对处理记录' })
      expect((await get('/artifacts/' + created.body.id + '/content')).status).toBe(409)
      expect((await get('/report?resultRevision=' + revision)).status).toBe(409)
      const again = await until(() => f.host.snapshot(id), s => Boolean(s.node?.result) && s.node!.result!.resultRevision !== revision)
      const denied = await f.post('/' + id + '/artifacts', { ...spec, operationId: randomUUID(), resultRevision: again.node!.result!.resultRevision })
      await until(() => get('/artifacts/' + denied.body.id), r => r.body.status === 'ready')
      f.principal.revoked = true
      expect((await get('/artifacts/' + denied.body.id + '/content')).status).not.toBe(200)
      expect((await get('/evidence?candidateRef=' + encodeURIComponent(window.body.items[0].ref))).status).not.toBe(200)
    } finally { await f.close() }
  }, 45000)

  it('A14 phase5: interrupted staging fences old writers; invalid narrative falls back; saved chunks reject corruption and expiration', async () => {
    const f = await fixture(false, false)
    try {
      const id = randomUUID(); await f.post('', { operationId: id, kind: 'query', text: '找上海副卡解绑工单' })
      f.host.start()
      const done = await until(() => f.host.snapshot(id), s => Boolean(s.node?.result))
      await f.host.close()
      const restored = new TaskHost(store, f.host.options), deliveries = restored.deliveries!
      try {
        const d = await deliveries.request(id, { operationId: randomUUID(), kind: 'csv', template: 'summary', resultRevision: done.node!.result!.resultRevision })
        const first = (await deliveries.store.claim('dead-host', 70))!
        await deliveries.store.append(first, 'partial', 0)
        await new Promise(resolve => setTimeout(resolve, 90))
        const replacement = (await deliveries.store.claim('replacement', 5000))!
        expect(replacement.fence).toBeGreaterThan(first.fence)
        await expect(deliveries.store.append(first, 'late', 1)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
        await deliveries.store.release(replacement)
        restored.start()
        const ready = await until(() => deliveries.store.read(d.id), r => r?.status === 'ready')
        expect(ready!.row_count).toBe(1)
        const savedChunks: Buffer[] = []; for await (const chunk of deliveries.store.chunks(ready!)) savedChunks.push(chunk)
        expect(Buffer.concat(savedChunks).toString()).not.toContain('partial')
        // Explicitly exercise failed independent prose validation through DSH.
        ;(f.adapter as Adapter).rejectReport = true
        const report = await deliveries.request(id, { operationId: randomUUID(), kind: 'report', resultRevision: done.node!.result!.resultRevision })
        const completed = await until(() => deliveries.store.read(report.id), r => r?.status === 'ready')
        expect(completed!.meta_json!.report.narrative.status).toBe('structured')
        expect(completed!.meta_json!.report.narrative.reason).toContain('校验')
        await store.pool.query('UPDATE ra_delivery_chunk SET body=? WHERE delivery_id=?', [Buffer.from('corrupt'), d.id])
        const res = { writeHead() { throw new Error('bytes must not escape') } } as any
        await expect(deliveries.content(ready!, res)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
        await store.pool.query('UPDATE ra_delivery SET expires_at=? WHERE id=?', [new Date(Date.now() - 1000), d.id])
        await expect(deliveries.get(id, d.id)).rejects.toThrow('到期')
      } finally { await restored.close() }
    } finally { await f.close() }
  }, 45000)

  it('A13 phase5: a queued task can subscribe before its first source snapshot exists', async () => {
    const f = await fixture(false, false), abort = new AbortController()
    try {
      const id = randomUUID(); await f.post('', { operationId: id, kind: 'query', text: '找副卡解绑工单' })
      const response = await fetch(f.url + '/' + id + '/events?after=0', { signal: abort.signal })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader(); let content = ''
      while (!content.includes('event: change') && !content.includes('access-error')) content += new TextDecoder().decode((await reader.read()).value)
      expect(content).toContain('event: change'); expect(content).not.toContain('access-error')
      expect(content).not.toContain('副卡'); expect((await store.read(id))?.state_json).toBeNull()
    } finally { abort.abort(); await f.close() }
  })

  it.skipIf(process.env.RETRIEVAL_AGENT_PHASE5_REAL_MODEL !== '1')('A14 phase5 real configured DSH source review and independently validated narrative', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ra-report-real-'))
    const f = await fixture(false, false, false, false, false, { root, adapter: new LearningAdapter(), live: true })
    const id = randomUUID(); let artifactId: string | undefined
    f.host.start()
    try {
      await f.post('', { operationId: id, kind: 'query', text: '查找历史上副卡解绑后仍共享流量的工单，处理后已恢复的也包括，不限制地区，只需1条。请读取处理原文再确认。' })
      const done = await until(async () => {
        const response = await fetch(f.url + '/' + id)
        if (response.status === 503) return undefined
        expect(response.status).toBe(200); const snapshot = await response.json() as TaskSnapshot
        if (snapshot.question) await f.post('/' + id, { operationId: `answer-${snapshot.question.id}`.slice(0, 64), kind: 'answer', questionId: snapshot.question.id,
          text: '历史发生过这一问题就包括，处理后已恢复也包括，不限制地区，只需1条。' })
        return snapshot
      }, s => Boolean(s?.node?.result), 240000)
      expect(done?.node?.result?.stoppingReason, JSON.stringify(f.errors)).toBe('top_k_accepted')
      expect(done!.node!.collectionWindow!.confirmed).toBe(1)
      const request = await f.post('/' + id + '/artifacts', { operationId: randomUUID(), kind: 'report', audience: 'handoff', resultRevision: done!.node!.result!.resultRevision })
      artifactId = String(request.body.id)
      const artifact = await until(() => f.host.deliveries!.store.read(artifactId!), d => d?.status === 'ready' || d?.status === 'failed', 240000)
      expect(artifact!.status, JSON.stringify(artifact)).toBe('ready')
      expect(artifact!.meta_json!.report.narrative.status, JSON.stringify(artifact!.meta_json!.report.narrative)).toBe('model')
      const response = await fetch(f.url + '/' + id + '/artifacts/' + artifactId + '/content')
      expect(response.status).toBe(200)
      const content = await response.text()
      await mkdir('output/phase5', { recursive: true }); await writeFile('output/phase5/real-report.md', content)
      expect(createHash('sha256').update(content).digest('hex')).toBe(artifact!.content_sha256)
    } finally {
      await mkdir('output/phase5', { recursive: true })
      await writeFile('output/phase5/real-model.json', JSON.stringify({ scope: 'Two synthetic tickets, actual configured DSH model, real MySQL, public HTTP. Not business Recall or target 27B quality.',
        task: await store.read(id), artifact: artifactId ? await f.host.deliveries!.store.read(artifactId) : undefined,
        traces: artifactId ? await store.rows('SELECT stage,data_json FROM ra_delivery_trace WHERE delivery_id=?', [artifactId]) : [], errors: f.errors }, null, 2))
      await f.close(); await rm(root, { recursive: true, force: true })
    }
  }, 510000)

  it.skipIf(process.env.RETRIEVAL_AGENT_PHASE5_SCALE !== '1')('A14 phase5 scale: public DSH confirms 1234 and streams every row beyond UI window', async () => {
    const f = await fixture(false, false, false, false, false, undefined, 1234)
    f.host.start()
    const monitoring = new AbortController(), samples: { tab: number; ms: number; status: number; bytes: number }[] = [], feeds: Promise<unknown>[] = []
    try {
      const id = randomUUID(); await f.post('', { operationId: id, kind: 'query', text: '查找全部副卡工单' })
      if (process.env.RETRIEVAL_AGENT_PHASE5_LOAD === '1') for (let tab = 0; tab < 3; tab++) {
        feeds.push((async () => {
          const response = await fetch(`${f.url}/${id}/events?after=0`, { signal: monitoring.signal })
          if (!response.ok) throw new Error(`SSE ${response.status}`)
          for await (const _chunk of response.body!) { /* drain the subscription as a connected tab does */ }
        })().catch(e => { if (!monitoring.signal.aborted) throw e }))
        feeds.push((async () => {
          while (!monitoring.signal.aborted) {
            const started = performance.now()
            const response = await fetch(`${f.url}/${id}`, { signal: monitoring.signal })
            const bytes = (await response.arrayBuffer()).byteLength
            samples.push({ tab, ms: performance.now() - started, status: response.status, bytes })
            await new Promise(resolve => setTimeout(resolve, 1500))
          }
        })().catch(e => { if (!monitoring.signal.aborted) throw e }))
      }
      await mkdir('output/phase5', { recursive: true }); await writeFile('output/phase5/scale-browser.json', JSON.stringify({ url: f.url.replace('/api/retrieval-agent/tasks', '/retrieval') + '?task=' + id }))
      // Observe only the terminal marker while the scripted DSH reviews each visible window.
      // Repeated full snapshot hydration is a separate load test, not needed to validate complete delivery.
      await until(async () => {
        await new Promise(resolve => setTimeout(resolve, 400))
        return (await store.rows<{ phase: string; failure: string | null }>("SELECT JSON_UNQUOTE(JSON_EXTRACT(state_json,'$.phase')) AS phase,failure FROM ra_task WHERE id=?", [id]))[0]
      }, s => s?.phase === 'stopped' || Boolean(s?.failure), 1800000)
      const responseSnapshot = await fetch(f.url + '/' + id)
      expect(responseSnapshot.status).toBe(200)
      const done = await responseSnapshot.json() as TaskSnapshot
      expect(done.node!.collectionWindow!.confirmed).toBe(1234)
      expect(done.node!.candidates.length).toBeLessThanOrEqual(30)
      let cursor: string | undefined; const ids: string[] = []
      do {
        const response = await fetch(f.url + '/' + id + '/candidates?view=confirmed&limit=100' + (cursor ? '&cursor=' + cursor : ''))
        expect(response.status).toBe(200)
        const page = await response.json() as any; ids.push(...page.items.map((c: any) => c.displayId)); cursor = page.nextCursor
      } while (cursor)
      expect(new Set(ids).size).toBe(1234)
      const spec = { operationId: randomUUID(), kind: 'jsonl', template: 'full', resultRevision: done.node!.result!.resultRevision }
      const request = await f.post('/' + id + '/artifacts', spec)
      expect(request.status, JSON.stringify(request.body)).toBe(202)
      const artifact = await until(() => f.host.deliveries!.store.read(String(request.body.id)), d => d?.status === 'ready', 120000)
      const response = await fetch(f.url + '/' + id + '/artifacts/' + artifact!.id + '/content')
      expect(response.status, response.status === 200 ? '' : await response.text()).toBe(200)
      const content = await response.text(), rows = content.trim().split('\n').map(line => JSON.parse(line))
      expect(rows.map(r => r.ticketId).sort()).toEqual(ids.sort())
      expect(rows.every(r => r.fields.resolutionSteps.includes('重新同步解绑状态后恢复'))).toBe(true)
      expect(createHash('sha256').update(content).digest('hex')).toBe(artifact!.content_sha256)
      await mkdir('output/phase5', { recursive: true })
      await writeFile('output/phase5/scale.json', JSON.stringify({ taskId: id, count: rows.length, calls: (f.adapter as DeliveryScaleAdapter).calls,
        snapshotBytes: Buffer.byteLength(JSON.stringify(done)), resultRevision: spec.resultRevision, hash: artifact!.content_sha256, bytes: artifact!.byte_count, parts: artifact!.part_count, errors: f.errors }, null, 2))
      if (process.env.RETRIEVAL_AGENT_PHASE5_BROWSER === '1') {
        await writeFile('output/phase5/scale-browser.json', JSON.stringify({ url: f.url.replace('/api/retrieval-agent/tasks', '/retrieval') + '?task=' + id }))
        await until(async () => { try { return await readFile('output/phase5/scale-browser-finished', 'utf8') } catch { return '' } }, s => s === 'done', 600000)
      }
    } finally {
      monitoring.abort(); const subscribers = await Promise.allSettled(feeds)
      await mkdir('output/github-acceptance', { recursive: true })
      await writeFile('output/github-acceptance/scale-load.json', JSON.stringify({ samples, subscribers }, null, 2))
      await f.close()
      expect(subscribers.every(r => r.status === 'fulfilled')).toBe(true)
      expect(samples.filter(s => s.status !== 200)).toEqual([])
    }
  }, 2500000)

  it.skipIf(process.env.RETRIEVAL_AGENT_PHASE5_BROWSER !== '1')('A14 phase5 browser fixture through public DSH task entry', async () => {
    const f = await fixture(true, false)
    const completionFile = `output/phase5/browser-finished-${randomUUID()}`
    try {
      f.host.start(); await mkdir('output/phase5', { recursive: true })
      await writeFile('output/phase5/browser-fixture.json', JSON.stringify({ url: f.url.replace('/api/retrieval-agent/tasks', '/retrieval'), completionFile }))
      await until(async () => { try { return await readFile(completionFile, 'utf8') } catch { return '' } }, s => s === 'done', 900000)
      await writeFile('output/phase5/browser-fixture-diagnostics.json', JSON.stringify({ calls: f.adapter.calls, errors: f.errors.map(e => String(e)) }))
    } finally { await f.close() }
  }, 920000)

  async function fixture(ask: boolean, slow: boolean, extraPage = false, experts = false, broken = false, learning?: { root: string; adapter: LearningAdapter; live?: boolean }, deliveryScale = 0, expertWikiRoot?: string) {
    let liveSelection: { provider: string; model: string } | undefined
    let liveConfig: Parameters<typeof piAi.apply>[1] | undefined
    let credentialRef: string | undefined, previousCredential: string | undefined
    if (learning?.live) {
      // Reuse the selected DSH route in memory. Never print, copy to an artifact, or modify credential files.
      const requireRuntime = createRequire(await realpath(path.resolve('.cache/retrieval-agent-local/runtime/dsh-runner/node_modules/@deepseek-ai/dsh/package.json')))
      const yaml = requireRuntime('js-yaml') as { load(text: string): any }
      const settings = yaml.load(await readFile('.cache/retrieval-agent-local/dsh-home/settings.yaml', 'utf8'))
      const credentials = yaml.load(await readFile('.cache/retrieval-agent-local/dsh-home/.credentials.yaml', 'utf8'))
      liveSelection = settings['agent-default-model']
      liveConfig = settings['llm-pi-ai']
      credentialRef = (liveConfig as any).providers[liveSelection!.provider].apiKeyEnv
      if (credentialRef) {
        previousCredential = process.env[credentialRef]
        const value = previousCredential ?? credentials.refs[credentialRef]
        if (typeof value !== 'string' || !value) throw new Error('Configured model credential unavailable')
        process.env[credentialRef] = value
      }
    }
    const ctx = new Context(); const errors: unknown[] = []
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const ranker: RetrievalRanker = { profileVersion: 'phase2-fixture-v1', capabilities: { keyword: true, dense: true, fusion: true, reranker: false }, rank: async (documents, query) => {
      if (++calls === 1 && slow) await gate // Deliberately ignores cancellation: exercise fencing, not just AbortSignal.
      return { hits: documents.map((d, i) => ({ documentId: d.id, rank: i + 1, score: 1, channels: [{ channel: 'keyword', rank: i + 1, score: 1 }] })),
        execution: { requestedMode: query.mode, executedMode: query.mode, strategyVersion: 'fixture', channels: [{ channel: 'keyword', implementation: 'fixture', version: '1', resultCount: documents.length, elapsedMs: 0 }, { channel: 'vector', implementation: 'fixture', version: '1', resultCount: documents.length, elapsedMs: 0 }] }, scanned: documents.length, keywordEligible: documents.length, rankedHits: documents.length, warnings: [] }
    } }
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime)
    if (liveConfig) await ctx.plugin(piAi, liveConfig)
    await ctx.plugin(SystemPrompt); await ctx.plugin(TokenMeter)
    if (experts || learning) { await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); await ctx.plugin(Skills) }
    const scaleRecords = Array.from({ length: Math.max(0, deliveryScale - 2) }, (_, i) => normalizeFixtureTicket({ ...records[0]!, ticketId: `scale-${i}`, displayId: `S-${i}`, title: `副卡解绑 ${i}`, summary: `副卡解绑后仍共享流量 ${i}` }))
    const additional = extraPage ? [{ ...records[0]!, ticketId: 't3' as typeof records[0]['ticketId'], displayId: 'T-3', contentHash: 'third-fixture' }] : []
    const p = new Principal(ctx); let provider = new LocalTicketProvider([...records, ...additional, ...scaleRecords], {
      ranker, defaultMode: 'hybrid', ...(deliveryScale ? { snapshotTtlMs: 3600000 } : {}) }); const providerPort = new Provider(ctx, provider)
    const replaceSource = () => { provider = new LocalTicketProvider(records.map(r => normalizeFixtureTicket({ ...r,
      sourceVersion: 'fixture-v2', problemDescription: '来源已修订：该问题不能沿用此前工单判断。' })), { ranker, defaultMode: 'hybrid' }); providerPort.p = provider }
    const application = new DurableRetrievalAgentService(ctx, { ...(extraPage ? { searchTopK: 2 } : {}), ...(broken ? { maxConsecutiveToolErrors: 3 } : {}) }, store)
    if (experts || learning) {
      await ctx.plugin({ name: 'durable-expert-scope', inject, apply(scope: Context) { new ExpertCoordinator(scope, application, learning?.root ?? expertWikiRoot) } })
      installWorkingContext(ctx, application)
    }
    if (deliveryScale) installWorkingContext(ctx, application)
    if (learning) new WikiLearningService(ctx, application, learning.root)
    installAutomaticRetrievalStart(ctx, application, { analyzer }); installRetrievalTools(ctx, application); installRetrievalRuntimeBudget(ctx, application)
    ctx.on('tools/result', (_exec, result) => { if (result.isError) errors.push(result.content) })
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    const assignments = expertWikiRoot ? (await openWiki(expertWikiRoot)).catalog().slice(0, 3).map((d, i) => ({ domain_id: d.id,
      goal: '核对' + d.title + '的业务边界与处理记录', scope: i === 0 ? '范围确认' : '独立取证', candidate_aliases: ['c1'], knowledge_ids: [d.knowledgeRefs[0]!] })) : undefined
    const adapter = deliveryScale ? new DeliveryScaleAdapter(deliveryScale) : learning?.adapter ?? (experts ? new RecoveringExpertAdapter(gate, assignments) : new Adapter(ask, broken)); ctx.llm.registerAdapter(['phase2-fixture'], adapter)
    const agents = new Map<string, Promise<Agent>>(); const disposers: (() => Promise<void>)[] = []
    const agentFor = (id: string): Promise<Agent> => {
      if (!agents.has(id)) agents.set(id, (async () => {
        const saved = await store.forSession(id)
        if (saved?.state_json?.snapshot) provider.restoreSnapshot(principal(), saved.state_json.snapshot)
        const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: liveSelection ?? { provider: 'phase2-fixture', model: 'scripted-acceptance' } })
        disposers.push(handle.dispose); return handle.agent
      })())
      return agents.get(id)!
    }
    const host = new TaskHost(store, { agentFor, applicationFor: () => ctx.retrievalAgent as DurableRetrievalAgentService, analyzer,
      providerFor: () => provider, reportModel: (agent, id, stage, input, signal, trace) => callReportModel(ctx, agent, id, stage, input, signal, trace),
      onError: (_job, error) => { errors.push(String(error)) } })
    const audit = new InMemoryExportAuditSink()
    const exportContext = { agentPresets: { serviceFor: (_agent: Agent, name: string) => name === 'retrievalAgent' ? application : provider } } as unknown as Context
    const server = createServer((request, response) => { void (async () => {
      if (request.url?.startsWith('/retrieval?') || request.url === '/retrieval') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(TASK_WORKBENCH_HTML); return }
      if (request.url === '/retrieval/workbench-client.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(await readFile('packages/product-host/lib/workbench-client.js')); return }
      if (request.url === '/api/retrieval-agent/detail') {
        try {
          const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const params = parseReadTicketDetailParams(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          const result = await readTicketDetailsForAgent(exportContext, await agentFor(params.sessionId), params, new InMemoryDetailReadAuditSink())
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
        } catch (e) { response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: String(e) })) }
        return
      }
      if (request.url !== '/api/retrieval-agent/export') { await host.handle(request, response); return }
      try {
        const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const params = parseExportCandidatesParams(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const agent = await agentFor(params.sessionId); await application.loadTask(agent)
        const result = await exportCandidatesForAgent(exportContext, agent, params, audit)
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
      } catch (error) { response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: String(error) })) }
    })() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/api/retrieval-agent/tasks`
    const post = async (path: string, body: unknown) => { const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, unknown> } }
    const exportCsv = async (id: string, resultRevision: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/retrieval-agent/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, retrievalId: id, resultRevision }) })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    return { host, adapter, url, errors, principal: p, post, release, application, agentFor, exportCsv, replaceSource, close: async () => {
      await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const dispose of disposers) await dispose(); await ctx.fiber.dispose()
      if (credentialRef) { if (previousCredential === undefined) delete process.env[credentialRef]; else process.env[credentialRef] = previousCredential }
    } }
  }
})
