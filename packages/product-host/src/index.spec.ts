import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createScope } from '@deepseek-ai/dsh-scope'
import { InMemoryDetailReadAuditSink, InMemoryExportAuditSink } from '@retrieval-agent/product-api'
import { callReportModel } from '@retrieval-agent/agent-plugin'
import { RetrievalId, TicketCandidateRef } from '@retrieval-agent/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  apply as applyProductHost,
  inject as productHostInject,
  continueRetrievalForAgent,
  exportCandidatesForAgent,
  parseContinueRetrievalParams,
  parseExportCandidatesParams,
  parseReadTicketDetailParams,
  readTicketDetailsForAgent,
  parseReadRetrievalParams,
  readRetrievalForAgent,
} from './index.js'

const ISOLATED_SERVICES_FIXTURE = `
const candidateRef = 'candidate-isolated-1'
const state = {
  retrievalId: 'retrieval-isolated-1',
  stateId: 'state-isolated-1',
  revision: 1,
  termination: 'top_k_accepted',
  accessValidation: 'current',
  phase: 'stopped',
  task: { target: 'ranked_cases', countPolicy: 'adaptive' },
  gaps: [],
  query: { original: '隔离服务导出', confirmedConstraints: [] },
  snapshot: {
    snapshotId: 'snapshot-isolated-1', shortId: 'snap-isolated',
    fieldCatalog: [
      { key: 'summary', label: '摘要', valueKind: 'text', accessLevel: 'L1' },
      { key: 'problemDescription', label: '问题描述', valueKind: 'text', accessLevel: 'L2' },
      { key: 'source.raw_dialogue', label: '完整对话', valueKind: 'text', accessLevel: 'L3' },
      { key: 'source.raw', label: '原始载荷', valueKind: 'raw_json', accessLevel: 'L3' },
    ],
    capabilities: { detailRead: true, exportRead: true },
  },
  candidates: [{
    ref: candidateRef,
    rank: 1,
    displayId: 'TKT-ISO-1',
    sourceVersion: 'fixture-v1',
    contentHash: 'fixture-content-hash',
    evidenceLevel: 'L2',
    title: '隔离 preset 中的工单',
    summary: '隔离 preset 工单摘要',
    l0: { status: 'resolved', priority: 'high' },
    matchFragments: [],
  }],
  candidateHistory: [],
  selectedCandidateRefs: [candidateRef], excludedCandidateRefs: [],
  promotedEvidence: [],
  lastPage: { completeness: 'bounded' },
}
const principal = {
  tenantId: 'demo',
  subjectId: 'development-admin',
  entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval',
  attributes: { role: ['administrator'] },
  issuedAt: '2026-08-28T00:00:00.000Z',
}
const retrievalAgent = {
  currentOrUndefined: () => state,
  authorizePresentation: async () => state,
  continueRanking: async () => ({
    ...state,
    candidates: [...state.candidates, { ...state.candidates[0], ref: 'candidate-isolated-2', rank: 2 }],
    lastPage: { completeness: 'bounded', nextCursor: 'provider-cursor-2' },
  }),
  principal: async () => principal,
  recordDetailRead: () => undefined,
  recordExport: () => undefined,
}
const ticketRetrievalProvider = {
  providerId: 'isolated-fixture-v1',
  status: async () => ({
    providerId: 'isolated-fixture-v1', ready: true, readOnly: true,
    snapshotValid: true, warnings: [],
  }),
  readDetails: async (_principal, request) => ({
    snapshotId: request.snapshotId,
    details: request.candidateRefs.map(ref => ({
      candidateRef: ref,
      displayId: 'TKT-ISO-1',
      sourceVersion: 'fixture-v1',
      title: '隔离 preset 中的工单',
      summary: '隔离 preset 工单摘要',
      l0: { status: 'resolved', priority: 'high' },
      fields: Object.fromEntries(request.fields.map(field => [field, ['数据库返回的详细问题描述']])),
      unavailableFields: [],
    })),
    rejectedCandidateRefs: [],
    warnings: [],
  }),
}

export const name = 'product-host-isolated-services-fixture'
export function apply(ctx) {
  ctx.effect(() => ctx.reflect.provide('retrievalAgent', retrievalAgent), 'fixture retrievalAgent')
  ctx.effect(() => ctx.reflect.provide('ticketRetrievalProvider', ticketRetrievalProvider), 'fixture ticketRetrievalProvider')
}
`

async function isolatedPresetHarness(): Promise<{
  readonly ctx: Context
  readonly agent: Agent
  readonly unjoinedAgent: Agent
  readonly root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'retrieval-product-host-'))
  const presetDir = join(root, 'isolated-export')
  const fixturePath = join(root, 'isolated-services.mjs')
  await mkdir(presetDir)
  await writeFile(fixturePath, ISOLATED_SERVICES_FIXTURE, 'utf8')
  await writeFile(join(presetDir, 'agent.cordis.yml'), [
    '- id: isolated-export-services',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    retrievalAgent: true',
    '    ticketRetrievalProvider: true',
    '  config:',
    '    - id: fixture-services',
    `      name: ${JSON.stringify(fixturePath)}`,
    '',
  ].join('\n'), 'utf8')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${process.cwd()}/`).href
  await ctx.plugin(Loader)
  await ctx.plugin(SessionProjection)
  ctx.loader.builtins.group = Group
  await ctx.plugin(AgentPresets, {
    default: 'isolated-export',
    roots: [{ path: root, trust: 'user' }],
    includeUserRoot: false,
    includeShippedRoot: false,
  })
  const joined = createScope(ctx, { productHostTest: 'joined' })
  const unjoined = createScope(ctx, { productHostTest: 'unjoined' })
  await ctx.agentPresets.mount(joined.ctx, 'isolated-export')
  return {
    ctx,
    agent: { ctx: joined.ctx } as Agent,
    unjoinedAgent: { ctx: unjoined.ctx } as Agent,
    root,
  }
}

describe('DSH product Host adapter', () => {
  it('can invoke the report model from the declared Cordis product Host scope', async () => {
    const ctx = new Context()
    const invoked = vi.fn()
    for (const name of ['webServer', 'agents', 'agentPresets', 'workspaceRegistry', 'settings', 'credentials', 'agentDefaultModel']) ctx.reflect.provide(name as never, {} as never)
    await ctx.plugin({ name: 'report-model-provider', apply(provider: Context) {
      provider.reflect.provide('llm', { async *stream() {
        invoked()
        yield { type: 'block-end', block: { type: 'tool-call', name: 'retrieval_report', arguments: JSON.stringify({ paragraphs: [{ text: '有原文依据。', citations: ['ref-1'] }] }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } } as never)
    } })
    const agent = { session: { requestContext: () => ({ provider: 'fixture', model: 'fixture', contextWindow: 32000 }) } } as unknown as Agent
    const invoke = (inject: typeof productHostInject) => new Promise<unknown>((resolve, reject) => {
      void Promise.resolve(ctx.plugin({ name: 'product-host-report-scope', inject, async apply(scope: Context) {
        try { resolve(await callReportModel(scope, agent, 'report-scope', 'write', {}, new AbortController().signal, async () => {})) }
        catch (error) { reject(error) }
      } })).catch(reject)
    })
    try {
      await expect(invoke(productHostInject.filter(name => name !== 'llm'))).rejects.toThrow('without inject')
      await expect(invoke(productHostInject)).resolves.toEqual({ paragraphs: [{ text: '有原文依据。', citations: ['ref-1'] }] })
      expect(invoked).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

  it('serves confirmed-only downloads through the actual registered HTTP route', async () => {
    const harness = await isolatedPresetHarness()
    try {
      const service = harness.ctx.agentPresets.serviceFor(harness.agent, 'retrievalAgent')!
      const current = service.currentOrUndefined(harness.agent)!
      const pending = { ...current.candidates[0]!, ref: TicketCandidateRef('pending-http'), displayId: 'PENDING-HTTP' }
      vi.spyOn(service, 'currentOrUndefined').mockReturnValue({ ...current, candidates: [...current.candidates, pending] })
      await harness.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      harness.ctx.effect(() => harness.ctx.reflect.provide('agents', { get: () => harness.agent }), 'HTTP test Agent lookup')
      await applyProductHost(harness.ctx)
      const url = `http://127.0.0.1:${harness.ctx.webServer.port}/api/retrieval-agent/export`
      const payload = { sessionId: 'session-isolated-1', retrievalId: current.retrievalId, resultRevision: current.stateId }
      const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const response = await post(payload)
      expect(response.status).toBe(200)
      const exported = await response.json() as { contentUtf8: string; receipt: { rowCount: number; resultRevision: string } }
      expect(exported.receipt).toMatchObject({ rowCount: 1, resultRevision: current.stateId })
      expect(exported.contentUtf8).toContain('TKT-ISO-1')
      expect(exported.contentUtf8).not.toContain('PENDING-HTTP')
      const forged = await post({ ...payload, candidateRefs: [pending.ref] })
      expect(forged.status).toBe(400)
      expect(await forged.json()).toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
      const stale = await post({ ...payload, resultRevision: 'old-result' })
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ code: 'INVALID_TRANSITION' })
      // Follow the fields advertised to the UI, rather than supplying a hand-picked L2 field.
      const identity = { sessionId: payload.sessionId, retrievalId: payload.retrievalId }
      const request = (endpoint: string, body: unknown) => fetch(url.replace('/export', endpoint), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const presentation = await request('/presentation', identity)
      expect(presentation.status).toBe(200)
      const { node } = await presentation.json() as { node: { detailFields: { key: string }[] } }
      const fields = node.detailFields.map(field => field.key)
      expect(fields).toEqual(['summary', 'problemDescription', 'source.raw_dialogue'])
      const detail = await request('/detail', { ...identity, candidateRefs: [current.candidates[0]!.ref], fields })
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({ details: [{ fields: {
        summary: ['数据库返回的详细问题描述'], 'source.raw_dialogue': ['数据库返回的详细问题描述'],
      } }] })
      const raw = await request('/detail', { ...identity, candidateRefs: [current.candidates[0]!.ref], fields: ['source.raw'] })
      expect(raw.status).toBe(400)
      expect(await raw.json()).toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
    } finally {
      await harness.ctx.fiber.dispose()
      await rm(harness.root, { recursive: true, force: true })
    }
  })

  it('accepts only the explicit wire contract', () => {
    expect(parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', resultRevision: 'result-1', candidateRefs: ['candidate-1'],
    })).toMatchObject({ sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1'] })
    expect(() => parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: [], principal: { tenantId: 'attacker' },
    })).toThrow(/未知字段/u)
    expect(parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', resultRevision: 'result-1',
    })).not.toHaveProperty('candidateRefs')
    expect(() => parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1'],
    })).toThrow(/引用无效/u)
  })

  it('accepts only one opaque candidate per explicit detail wire request', () => {
    expect(parseReadTicketDetailParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1'], fields: ['problemDescription'],
    })).toMatchObject({ candidateRefs: ['candidate-1'], fields: ['problemDescription'] })
    expect(() => parseReadTicketDetailParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1', 'candidate-2'], fields: [],
    })).toThrow(/一个候选/u)
    expect(() => parseReadTicketDetailParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1'], fields: [], ticketId: 'TKT-ISO-1',
    })).toThrow(/未知字段/u)
  })

  it('accepts only the live retrieval identity for cursor continuation', () => {
    expect(parseContinueRetrievalParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1',
    })).toMatchObject({ sessionId: 'session-1', retrievalId: 'retrieval-1' })
    expect(() => parseContinueRetrievalParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', cursor: 'attacker-cursor',
    })).toThrow(/未知字段/u)
  })

  it('exports through the public preset lookup while the real isolate hides both services', async () => {
    const harness = await isolatedPresetHarness()
    try {
      expect(harness.ctx.get('retrievalAgent')).toBeUndefined()
      expect(harness.agent.ctx.get('retrievalAgent')).toBeUndefined()
      expect(harness.ctx.agentPresets.serviceFor(harness.agent, 'retrievalAgent')).toBeDefined()
      expect(harness.ctx.agentPresets.serviceFor(harness.agent, 'ticketRetrievalProvider')).toBeDefined()

      const params = parseExportCandidatesParams({
        sessionId: 'session-isolated-1',
        retrievalId: 'retrieval-isolated-1',
        resultRevision: 'state-isolated-1',
        candidateRefs: ['candidate-isolated-1'],
      })
      const audit = new InMemoryExportAuditSink()
      const response = await exportCandidatesForAgent(harness.ctx, harness.agent, params, audit)

      expect(response.contentUtf8).toContain('TKT-ISO-1')
      expect(response.receipt.rowCount).toBe(1)
      expect(audit.records).toHaveLength(1)

      await expect(exportCandidatesForAgent(harness.ctx, harness.unjoinedAgent, params, audit))
        .rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
          publicMessage: expect.stringMatching(/未加载工单检索能力/u),
        })
    } finally {
      await harness.ctx.fiber.dispose()
      await rm(harness.root, { recursive: true, force: true })
    }
  })

  it('reads detail through the isolated Provider and hands its receipt and evidence to authoritative state', async () => {
    const harness = await isolatedPresetHarness()
    try {
      const params = parseReadTicketDetailParams({
        sessionId: 'session-isolated-1',
        retrievalId: 'retrieval-isolated-1',
        candidateRefs: ['candidate-isolated-1'],
        fields: ['problemDescription'],
      })
      const audit = new InMemoryDetailReadAuditSink()
      const record = vi.spyOn(harness.ctx.agentPresets.serviceFor(harness.agent, 'retrievalAgent')!, 'recordDetailRead')
      const response = await readTicketDetailsForAgent(harness.ctx, harness.agent, params, audit)

      expect(response.details).toHaveLength(1)
      expect(response.details[0]?.displayId).toBe('TKT-ISO-1')
      expect(response.details[0]?.fields.problemDescription).toEqual(['数据库返回的详细问题描述'])
      expect(response.receipt).toMatchObject({
        retrievalId: 'retrieval-isolated-1',
        snapshotShortId: 'snap-isolated',
        candidateRefs: ['candidate-isolated-1'],
        fields: ['problemDescription'],
      })
      expect(audit.records).toHaveLength(1)
      expect(record).toHaveBeenCalledWith(harness.agent, response.receipt, expect.objectContaining({ details: response.details }))
    } finally {
      await harness.ctx.fiber.dispose()
      await rm(harness.root, { recursive: true, force: true })
    }
  })

  it('rejects stale versions and a result revision changed while Provider work is in flight', async () => {
    const harness = await isolatedPresetHarness()
    try {
      const service = harness.ctx.agentPresets.serviceFor(harness.agent, 'retrievalAgent')!
      const source = harness.ctx.agentPresets.serviceFor(harness.agent, 'ticketRetrievalProvider')!
      const state = service.currentOrUndefined(harness.agent)!
      let current = state
      vi.spyOn(service, 'currentOrUndefined').mockImplementation(() => current)
      const audit = new InMemoryExportAuditSink()
      const record = vi.spyOn(service, 'recordExport')
      const params = parseExportCandidatesParams({ sessionId: 'session-isolated-1',
        retrievalId: state.retrievalId, resultRevision: state.stateId })
      await expect(exportCandidatesForAgent(harness.ctx, harness.agent, { ...params, resultRevision: 'stale' }, audit))
        .rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
      const read = source.readDetails.bind(source)
      vi.spyOn(source, 'readDetails').mockImplementation(async (...args) => {
        const response = await read(...args)
        current = { ...state, phase: 'assessed', termination: 'active', selectedCandidateRefs: [] }
        return response
      })
      await expect(exportCandidatesForAgent(harness.ctx, harness.agent, params, audit))
        .rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
      expect(audit.records).toEqual([])
      expect(record).not.toHaveBeenCalled()
    } finally {
      await harness.ctx.fiber.dispose()
      await rm(harness.root, { recursive: true, force: true })
    }
  })

  it('requires fresh presentation authorization through the isolated live service and propagates revocation', async () => {
    const harness = await isolatedPresetHarness()
    try {
      const params = parseReadRetrievalParams({ sessionId: 'session-isolated-1', retrievalId: 'retrieval-isolated-1' })
      const service = harness.ctx.agentPresets.serviceFor(harness.agent, 'retrievalAgent')!
      const authorize = vi.spyOn(service, 'authorizePresentation')
      const response = await readRetrievalForAgent(harness.ctx, harness.agent, params)
      expect(response.node.candidates[0]?.displayId).toBe('TKT-ISO-1')
      expect(authorize).toHaveBeenCalledWith(harness.agent, params.retrievalId, undefined)
      authorize.mockRejectedValueOnce(new Error('当前身份已被撤销'))
      await expect(readRetrievalForAgent(harness.ctx, harness.agent, params)).rejects.toThrow('当前身份已被撤销')
      expect(() => parseReadRetrievalParams({ ...params, principal: { subjectId: 'forged' } })).toThrow(/未知字段/u)
    } finally {
      await harness.ctx.fiber.dispose()
      await rm(harness.root, { recursive: true, force: true })
    }
  })

  it('does not return retained historical content when authorization could not complete', async () => {
    const harness = await isolatedPresetHarness()
    try {
      const params = parseReadRetrievalParams({ sessionId: 'session-isolated-1', retrievalId: 'retrieval-isolated-1' })
      const service = harness.ctx.agentPresets.serviceFor(harness.agent, 'retrievalAgent')!
      const state = service.currentOrUndefined(harness.agent)!
      vi.spyOn(service, 'authorizePresentation').mockResolvedValueOnce({
        ...state, accessValidation: 'required', termination: 'backend_error', phase: 'stopped',
      })
      await expect(readRetrievalForAgent(harness.ctx, harness.agent, params)).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE', publicMessage: expect.stringContaining('重新授权'),
      })
    } finally {
      await harness.ctx.fiber.dispose()
      await rm(harness.root, { recursive: true, force: true })
    }
  })

  it('continues through the isolated retrieval service without accepting a browser cursor', async () => {
    const harness = await isolatedPresetHarness()
    try {
      const params = parseContinueRetrievalParams({
        sessionId: 'session-isolated-1', retrievalId: 'retrieval-isolated-1',
      })
      await expect(continueRetrievalForAgent(harness.ctx, harness.agent, params)).resolves.toMatchObject({
        retrievalId: 'retrieval-isolated-1', candidateCount: 2, nextPageAvailable: true,
      })
      await expect(continueRetrievalForAgent(harness.ctx, harness.agent, {
        ...params, retrievalId: RetrievalId('retrieval-wrong'),
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      await harness.ctx.fiber.dispose()
      await rm(harness.root, { recursive: true, force: true })
    }
  })
})
import SessionProjection from '@deepseek-ai/dsh-session-projection'
