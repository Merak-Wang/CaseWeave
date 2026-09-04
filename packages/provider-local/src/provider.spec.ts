import { describe, expect, it } from 'vitest'
import {
  TicketCandidateRef,
  type NormalizedTicketRecord,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { normalizeFixtureTicket, type FixtureTicketInput } from './fixture.js'
import { LocalTicketProvider } from './provider.js'
import { RankingError, type RetrievalRanker } from '@retrieval-agent/retrieval-ranking'
import { testHybridRanker } from '../../../tests/support/fake-model-gateway.js'

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
  it('defaults an unquantified request to adaptive independently of task type', () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, ranker: testHybridRanker() })
    const spec = provider.resolve({ target: 'cohort_collection', query: '登录工单' })
    expect(spec).toMatchObject({ target: 'cohort_collection', countPolicy: 'adaptive' })
    expect(spec).not.toHaveProperty('requestedCount')
  })

  it('keeps later candidates reachable when the initial top-ranked candidate is rejected', async () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, ranker: testHybridRanker() })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const spec = provider.resolve({ target: 'ranked_cases', query: '登录', requestedCount: 1, countPolicy: 'explicit' })
    const page = await provider.search(user, snapshot.snapshotId, spec, {
      topK: 1, maxScan: 100, stage: 'initial_hybrid',
    })

    expect(page.candidates).toHaveLength(1)
    expect(page.nextCursor).toBeDefined()
    expect(page.boundary.rankedHits).toBeGreaterThan(1)
    const next = await provider.search(user, snapshot.snapshotId, spec, {
      topK: 1, maxScan: 100, stage: 'next_page', cursor: page.nextCursor!,
    })
    expect(next.candidates[0]?.ref).not.toBe(page.candidates[0]?.ref)
    expect(next.candidates[0]?.rank).toBe(2)
  })

  it('admits an explicit result goal above its page capacity and still enforces that capacity', async () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, maxPageSize: 1, ranker: testHybridRanker() })
    const user = principal()
    const spec = provider.resolve({ target: 'ranked_cases', query: '登录', requestedCount: 150, countPolicy: 'explicit' })
    const snapshot = await provider.openSnapshot(user)
    expect(spec.requestedCount).toBe(150)
    await expect(provider.search(user, snapshot.snapshotId, spec, { topK: 1, maxScan: 100, stage: 'initial_hybrid' }))
      .resolves.toMatchObject({ returned: 1 })
    await expect(provider.search(user, snapshot.snapshotId, spec, { topK: 2, maxScan: 100, stage: 'initial_hybrid' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('does not synthesize a keyword query when the fast plan is dense-only', async () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, ranker: testHybridRanker() })
    const spec = provider.resolve({
      target: 'cohort_collection', query: 'same semantic issue in another language', mode: 'hybrid',
      fastQuery: {
        schemaVersion: 2, source: 'direct_user', rewriteApplied: false,
        vector: { text: 'same semantic issue in another language' },
      },
    })
    expect(spec.semanticQuery).toBe('same semantic issue in another language')
    expect(spec).not.toHaveProperty('keywordQuery')
    const snapshot = await provider.openSnapshot(principal())
    const page = await provider.search(principal(), snapshot.snapshotId, spec, {
      topK: 20, maxScan: 100, stage: 'initial_hybrid',
    })
    expect(page.trace).toMatchObject({ requestedMode: 'hybrid', executedMode: 'dense' })
    expect(page.trace.channels.map(channel => channel.channel)).toEqual(['vector'])
    expect(page.boundary.documentsEligibleForKeywordChannel).toBe(0)
  })

  it('filters unauthorized, cross-tenant, and unreviewed-PII records before ranking', async () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, ranker: testHybridRanker() })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const page = await provider.search(user, snapshot.snapshotId, provider.resolve({ target: 'ranked_cases', query: '登录', requestedCount: 5, countPolicy: 'explicit' }), {
      topK: 10,
      maxScan: 100,
      stage: 'baseline',
    })

    expect(page.candidates.map(candidate => candidate.displayId)).toEqual(['INC-1', 'INC-2'])
    expect(page.completeness).toBe('exhaustive')
    expect(snapshot.authorizationVersion).toBe('entitlements-v1')
  })

  it('returns the authorized L1 summary and keeps the evidence read independently auditable', async () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, ranker: testHybridRanker() })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const page = await provider.search(user, snapshot.snapshotId, provider.resolve({ target: 'ranked_cases', query: '验证码', requestedCount: 5, countPolicy: 'explicit' }), {
      topK: 5, maxScan: 100, stage: 'baseline',
    })
    const candidate = page.candidates[0]!

    expect(candidate.summary).toBe('登录故障摘要')
    expect(candidate.matchFragments.every(fragment => fragment.field === 'title')).toBe(true)
    expect(snapshot.fieldCatalog).toContainEqual(expect.objectContaining({ key: 'summary', accessLevel: 'L1' }))
    const promoted = await provider.readEvidence(user, {
      snapshotId: snapshot.snapshotId,
      candidateRefs: [candidate.ref],
      fields: ['summary'],
      tokenBudget: 64,
    })
    expect(promoted.evidence).toEqual([expect.objectContaining({
      candidateRef: candidate.ref, field: 'summary', text: '登录故障摘要',
    })])
  })

  it('makes every exact AND match eligible in the keyword channel', async () => {
    const provider = new LocalTicketProvider([
      ...fixtureRecords(),
      record({ ticketId: 'T-6', displayId: 'INC-6', title: '副卡新增订单失败' }),
      record({ ticketId: 'T-7', displayId: 'INC-7', title: '副卡在省外漫游无法上网' }),
      record({ ticketId: 'T-8', displayId: 'INC-8', title: '副卡跨域办理失败' }),
    ], { now: () => BASE_TIME, ranker: testHybridRanker() })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const spec = provider.resolve({
      target: 'ranked_cases',
      query: '查找副卡和跨域有关工单',
      retrievalQuery: '副卡和跨域',
      requestedCount: 20,
      countPolicy: 'adaptive',
      filters: [],
      ambiguities: [],
      queryContract: {
        schemaVersion: 3,
        original: '查找副卡和跨域有关工单',
        normalized: '副卡和跨域',
        task: 'ranked_cases',
        resultPolicy: 'adaptive_top_k',
        maxResults: 20,
        domain: 'telecom_ticket',
        language: 'zh',
        entities: [{ type: 'business_object', surface: '副卡', canonical: '副卡' }],
        constraints: [],
        logic: {
          operator: 'and',
          requiredConcepts: [
            { surface: '副卡', canonical: '副卡', alternatives: ['副卡'] },
            { surface: '跨域', canonical: '跨域', alternatives: ['跨域', '跨省', '省外', '漫游'] },
          ],
        },
        ambiguities: [],
        fastQuery: {
          schemaVersion: 1,
          source: 'direct_user',
          rewriteApplied: false,
          keyword: { terms: ['副卡', '跨域'], operator: 'and' },
          vector: { text: '查找副卡和跨域有关工单' },
        },
        interpretationBasis: 'deterministic_syntax',
        compilerVersion: 'direct-query-contract-v4',
      },
      fastQuery: {
        schemaVersion: 1,
        source: 'direct_user',
        rewriteApplied: false,
        keyword: { terms: ['副卡', '跨域'], operator: 'and' },
        vector: { text: '查找副卡和跨域有关工单' },
      },
    })

    const page = await provider.search(user, snapshot.snapshotId, spec, {
      topK: 20,
      maxScan: 100,
      stage: 'baseline',
    })

    expect(spec.requiredConcepts?.map(concept => concept.canonical)).toEqual(['副卡', '跨域'])
    expect(spec.fastQuery).toMatchObject({ rewriteApplied: false, keyword: { terms: ['副卡', '跨域'], operator: 'and' } })
    expect(page.candidates.map(candidate => candidate.displayId)).toEqual(['INC-8'])
    expect(page.boundary.documentsEligibleForKeywordChannel).toBe(1)
    expect(page.completeness).toBe('exhaustive')
  })

  it('binds snapshots to the exact trusted principal and rejects forged candidate refs', async () => {
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, ranker: testHybridRanker() })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const spec = provider.resolve({ target: 'ranked_cases', query: '验证码', requestedCount: 5, countPolicy: 'explicit' })
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
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => now, snapshotTtlMs: 1_000, ranker: testHybridRanker() })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const spec = provider.resolve({ target: 'ranked_cases', query: '登录', requestedCount: 5, countPolicy: 'explicit' })
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

  it('reuses one ranking result while an exhaustive query advances through Provider pages', async () => {
    const base = testHybridRanker()
    let rankingCalls = 0
    const ranker: RetrievalRanker = {
      profileVersion: base.profileVersion,
      capabilities: base.capabilities,
      rank: (...args) => {
        rankingCalls += 1
        return base.rank(...args)
      },
    }
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, ranker })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    const spec = provider.resolve({ target: 'cohort_collection', query: '登录', countPolicy: 'exhaustive' })
    const first = await provider.search(user, snapshot.snapshotId, spec, {
      topK: 1, maxScan: 100, stage: 'initial_hybrid',
    })
    if (first.nextCursor === undefined) throw new Error('fixture should contain a second ranked page')
    const second = await provider.search(user, snapshot.snapshotId, spec, {
      topK: 1, maxScan: 100, stage: 'next_page', cursor: first.nextCursor,
    })

    expect(second.nextCursor).toBeUndefined()
    expect(rankingCalls).toBe(1)
  })

  it('maps RAG transport failures to stable domain errors', async () => {
    const ranker: RetrievalRanker = {
      profileVersion: 'failing-v1',
      capabilities: { keyword: true, dense: true, fusion: true, reranker: false },
      rank: async () => { throw new RankingError('DEADLINE_EXCEEDED', 'late', true) },
    }
    const provider = new LocalTicketProvider(fixtureRecords(), { now: () => BASE_TIME, ranker })
    const user = principal()
    const snapshot = await provider.openSnapshot(user)
    await expect(provider.search(user, snapshot.snapshotId, provider.resolve({ target: 'ranked_cases', query: '登录', requestedCount: 5, countPolicy: 'explicit' }), {
      topK: 5, maxScan: 100, stage: 'baseline',
    })).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
  })
})
