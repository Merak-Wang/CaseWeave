import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { createScope } from '@deepseek-ai/dsh-scope'
import { InMemoryExportAuditSink } from '@retrieval-agent/product-api'
import { describe, expect, it } from 'vitest'
import { exportCandidatesForAgent, parseExportCandidatesParams } from './index.js'

const ISOLATED_SERVICES_FIXTURE = `
const candidateRef = 'candidate-isolated-1'
const state = {
  retrievalId: 'retrieval-isolated-1',
  query: { original: '隔离服务导出' },
  snapshot: { snapshotId: 'snapshot-isolated-1', shortId: 'snap-isolated' },
  candidates: [{
    ref: candidateRef,
    rank: 1,
    displayId: 'TKT-ISO-1',
    sourceVersion: 'fixture-v1',
    contentHash: 'fixture-content-hash',
    evidenceLevel: 'L1',
    title: '隔离 preset 中的工单',
    summary: '该记录验证 Host 能通过公开 serviceFor 读取隔离服务。',
    l0: { status: 'resolved', priority: 'high' },
    matchFragments: [],
  }],
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
  principal: async () => principal,
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
      summary: '该记录验证 Host 能通过公开 serviceFor 读取隔离服务。',
      l0: { status: 'resolved', priority: 'high' },
      fields: {},
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
  ctx.loader.builtins.group = Group
  await ctx.plugin(AgentPresets, {
    default: 'isolated-export',
    roots: [{ path: root, trust: 'user' }],
    includeUserRoot: false,
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

describe('DSH product Host export adapter', () => {
  it('accepts only the explicit wire contract', () => {
    expect(parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1'],
    })).toMatchObject({ sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1'] })
    expect(() => parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: [], principal: { tenantId: 'attacker' },
    })).toThrow(/未知字段/u)
    expect(() => parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: Array.from({ length: 201 }, (_, index) => `ref-${index}`),
    })).toThrow(/候选引用/u)
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
})
