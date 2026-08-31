import { describe, expect, it } from 'vitest'
import {
  TicketCandidateRef,
  type NormalizedTicketRecord,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { normalizeFixtureTicket, type FixtureTicketInput } from './fixture.js'
import { LocalTicketProvider } from './provider.js'

const BASE_TIME = new Date('2026-08-27T00:00:00.000Z')

function principal(overrides: Partial<TrustedPrincipalContext> = {}): TrustedPrincipalContext {
  return {
    tenantId: 'demo',
    subjectId: 'support-user',
    entitlementVersion: 'entitlements-v1',
    purpose: 'ticket_retrieval',
    attributes: { group: ['support'], region: ['cn'] },
    issuedAt: '2026-08-26T00:00:00.000Z',
    expiresAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  }
}

function record(input: Pick<FixtureTicketInput, 'ticketId' | 'displayId' | 'title'> & Partial<FixtureTicketInput>): NormalizedTicketRecord {
  return normalizeFixtureTicket({
    ticketId: input.ticketId,
    displayId: input.displayId,
    title: input.title,
    summary: input.summary ?? '登录故障摘要',
    tenantId: input.tenantId ?? 'demo',
    allowedSubjectIds: input.allowedSubjectIds ?? [],
    requiredAttributes: input.requiredAttributes ?? { group: ['support'] },
    sourceVersion: input.sourceVersion ?? 'fixture-v1:1',
    conversationOrUpdates: input.conversationOrUpdates ?? [],
    resolutionSteps: input.resolutionSteps ?? [],
    errorCodes: input.errorCodes ?? [],
    piiRedactionStatus: input.piiRedactionStatus ?? 'redacted',
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    ...(input.resolvedAt === undefined ? {} : { resolvedAt: input.resolvedAt }),
    ...(input.problemDescription === undefined ? {} : { problemDescription: input.problemDescription }),
    ...(input.rootCause === undefined ? {} : { rootCause: input.rootCause }),
    ...(input.answer === undefined ? {} : { answer: input.answer }),
    ...(input.product === undefined ? {} : { product: input.product }),
    ...(input.component === undefined ? {} : { component: input.component }),
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.region === undefined ? {} : { region: input.region }),
  })
}

function fixtureRecords(): readonly NormalizedTicketRecord[] {
  return [
    record({ ticketId: 'T-1', displayId: 'INC-1', title: '登录验证码失效', problemDescription: '验证码缓存已过期。' }),
    record({ ticketId: 'T-2', displayId: 'INC-2', title: '登录代理循环跳转', answer: '透传原始协议。' }),
    record({ ticketId: 'T-3', displayId: 'INC-3', title: '登录安全调查', allowedSubjectIds: ['security-user'], requiredAttributes: { group: ['security'] } }),
    record({ ticketId: 'T-4', displayId: 'INC-4', title: '其他租户登录故障', tenantId: 'other-tenant' }),
    record({ ticketId: 'T-5', displayId: 'INC-5', title: '未审阅登录记录', piiRedactionStatus: 'unreviewed' }),
  ]
}

describe('LocalTicketProvider authorization boundary', () => {
  it('filters unauthorized, cross-tenant, and unreviewed-PII records before ranking', async () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const page = await provider.search(user, snapshot.snapshotId, provider.resolve({ target: 'ranked_cases', query: '登录' }), {
      topK: 10,
      maxScan: 100,
      stage: 'baseline',
    })

    expect(page.candidates.map(candidate => candidate.displayId)).toEqual(['INC-1', 'INC-2'])
    expect(page.completeness).toBe('exhaustive')
    expect(snapshot.authorizationVersion).toBe('entitlements-v1')
  })

  it('binds snapshots to the exact trusted principal and rejects forged candidate refs', async () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const spec = provider.resolve({ target: 'ranked_cases', query: '验证码' })
    const page = await provider.search(user, snapshot.snapshotId, spec, { topK: 5, maxScan: 100, stage: 'baseline' })

    await expect(provider.search(principal({ attributes: { region: ['cn'], group: ['support', 'support'] } }), snapshot.snapshotId, spec, { topK: 5, maxScan: 100, stage: 'baseline' }))
      .resolves.toMatchObject({ returned: 1 })

    await expect(provider.search(principal({ subjectId: 'another-user' }), snapshot.snapshotId, spec, { topK: 5, maxScan: 100, stage: 'baseline' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    const details = await provider.readDetails(user, {
      snapshotId: snapshot.snapshotId,
      candidateRefs: [page.candidates[0]!.ref, TicketCandidateRef('cand_forged')],
      fields: ['problemDescription'],
      purpose: 'inline_detail',
    })
    expect(details.details).toHaveLength(1)
    expect(details.rejectedCandidateRefs).toEqual([TicketCandidateRef('cand_forged')])
  })

  it('rejects tampered cursors, expired snapshots, and cancelled calls', async () => {
    let now = BASE_TIME
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => now, snapshotTtlMs: 1_000 })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const spec = provider.resolve({ target: 'ranked_cases', query: '登录' })
    const first = await provider.search(user, snapshot.snapshotId, spec, { topK: 1, maxScan: 100, stage: 'baseline' })
    expect(first.nextCursor).toBeDefined()
    const decoded = Buffer.from(first.nextCursor!, 'base64url').toString('utf8')
    const tampered = Buffer.from(`${decoded.slice(0, -1)}x`, 'utf8').toString('base64url')
    await expect(provider.search(user, snapshot.snapshotId, spec, { topK: 1, maxScan: 100, stage: 'next_page', cursor: tampered }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const controller = new AbortController()
    controller.abort()
    await expect(provider.readEvidence(user, {
      snapshotId: snapshot.snapshotId,
      candidateRefs: [first.candidates[0]!.ref],
      fields: ['problemDescription'],
      tokenBudget: 20,
    }, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })

    now = new Date(BASE_TIME.getTime() + 1_001)
    await expect(provider.search(user, snapshot.snapshotId, spec, { topK: 1, maxScan: 100, stage: 'baseline' }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' })
    await expect(provider.status(user, snapshot.snapshotId)).resolves.toMatchObject({ snapshotValid: false })
  })
})
