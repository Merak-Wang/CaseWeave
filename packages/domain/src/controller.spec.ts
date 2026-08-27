import { describe, expect, it } from 'vitest'
import {
  RetrievalError,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketId,
  TicketSnapshotId,
  type TicketRetrievalProvider,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { EvidenceContextPolicy } from './context.js'
import { RetrievalController } from './controller.js'
import { InMemoryRetrievalEventJournal } from './journal.js'
import { foldRetrievalEvents } from './replay.js'

const NOW = new Date('2026-08-27T02:00:00.000Z')
const CANDIDATE_REF = TicketCandidateRef('cand-1')
const EVIDENCE_ID = TicketEvidenceId('evidence-1')

const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo',
  subjectId: 'support-user',
  entitlementVersion: 'entitlements-v1',
  purpose: 'ticket_retrieval',
  attributes: { group: ['support'] },
  issuedAt: '2026-08-27T00:00:00.000Z',
  expiresAt: '2026-08-28T00:00:00.000Z',
}

function provider(): TicketRetrievalProvider {
  return {
    providerId: 'stub-v1',
    resolve(request) {
      return {
        target: request.target,
        originalQuery: request.query,
        normalizedQuery: request.query.trim(),
        requestedCount: request.requestedCount ?? 3,
        mode: request.mode ?? 'keyword',
        filters: request.filters ?? [],
        excludedTerms: [],
        semanticHints: [],
        compilerVersion: 'stub-query-v1',
      }
    },
    async openSnapshot() {
      return {
        snapshotId: TicketSnapshotId('snapshot-1'),
        shortId: 'snap-1',
        providerId: 'stub-v1',
        createdAt: NOW.toISOString(),
        expiresAt: '2026-08-28T00:00:00.000Z',
        sourceVersion: 'source-v1',
        indexVersion: 'index-v1',
        authorizationVersion: 'entitlements-v1',
        principalBindingHash: 'principal-binding',
        queryPolicyVersion: 'query-v1',
        capabilities: { exhaustive: true, pagination: false, evidencePromotion: true, detailRead: true, exportRead: true },
      }
    },
    async search(_principal, snapshotId, query) {
      return {
        snapshotId,
        queryFingerprint: 'query-fingerprint',
        candidates: [{
          ref: CANDIDATE_REF,
          displayId: 'INC-1',
          sourceVersion: 'source-v1',
          snapshotId,
          contentHash: 'content-hash-1',
          evidenceLevel: 'L1',
          rank: 1,
          title: '登录失败',
          summary: '验证码缓存失效',
          l0: { category: '认证', priority: 'P1' },
          matchFragments: [{ field: 'title', text: '登录失败', truncated: false }],
        }],
        completeness: 'exhaustive',
        scanned: 1,
        returned: 1,
        elapsedMs: 7,
        appliedFilters: query.filters,
        warnings: [],
      }
    },
    async readEvidence(_principal, request) {
      return {
        snapshotId: request.snapshotId,
        evidence: [{
          evidenceId: EVIDENCE_ID,
          candidateRef: CANDIDATE_REF,
          displayId: 'INC-1',
          sourceVersion: 'source-v1',
          contentHash: 'content-hash-1',
          field: 'problemDescription',
          text: '验证码缓存键未包含时区。',
          start: 0,
          end: 13,
          estimatedTokens: 13,
          trust: 'untrusted_ticket_evidence',
          truncated: false,
        }],
        requestedCandidateRefs: request.candidateRefs,
        rejectedCandidateRefs: [],
        tokenBudget: request.tokenBudget,
        tokensUsed: 13,
        warnings: [],
      }
    },
    async readDetails(_principal, request) {
      return { snapshotId: request.snapshotId, details: [], rejectedCandidateRefs: request.candidateRefs, warnings: [] }
    },
    async status() {
      return { providerId: 'stub-v1', ready: true, readOnly: true, snapshotValid: true, warnings: [] }
    },
  }
}

function deterministicIds(): () => string {
  let value = 0
  return () => `id-${value++}`
}

describe('RetrievalController', () => {
  it('runs a bounded search, evidence promotion, freeze, and exact event replay', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, new EvidenceContextPolicy({ estimateTokens: () => 1 }), {
      now: () => NOW,
      id: ids,
      maxRounds: 4,
      maxSearches: 2,
      maxPromotions: 1,
      maxEvidenceTokens: 50,
    })

    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录 验证码', requestedCount: 3 })
    expect(state.allowedActions.map(item => item.kind)).toEqual(['search', 'read_state'])
    expect(() => controller.freeze(state, [])).toThrowError(RetrievalError)

    state = await controller.search(PRINCIPAL, state)
    state = controller.assess(state, {
      decision: 'continue',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [CANDIDATE_REF], evaluator: 'model' }],
      model: 'fixture-model',
    })
    await expect(controller.promote(PRINCIPAL, state, [TicketCandidateRef('forged')], ['problemDescription'], 20))
      .rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
    state = await controller.promote(PRINCIPAL, state, [CANDIDATE_REF], ['problemDescription'], 20)

    const context = controller.projectContext(state, 20)
    expect(context.includedCandidateRefs).toEqual([CANDIDATE_REF])
    expect(context.includedEvidenceIds).toEqual([EVIDENCE_ID])
    expect(context.rendered).toContain('<untrusted_ticket_evidence>')

    state = controller.assess(state, {
      decision: 'sufficient',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [{ kind: 'depth', status: 'resolved', evidenceRefs: [EVIDENCE_ID], evaluator: 'model' }],
    })
    state = controller.freeze(state, [CANDIDATE_REF])

    expect(state.termination).toBe('sufficient')
    expect(state.frozenEvidence?.candidates[0]).toMatchObject({ displayId: 'INC-1', evidenceLevel: 'L2' })
    expect(controller.validateFrozenReferences(state, ['INC-1'], [EVIDENCE_ID])).toBe(state.frozenEvidence)
    expect(() => controller.validateFrozenReferences(state, ['INC-999'], [])).toThrow(/冻结证据包以外/u)

    const events = journal.read(state.retrievalId)
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index))
    expect(foldRetrievalEvents(events, state.retrievalId)).toEqual(state)
  })

  it('rejects broken replay chains instead of accepting a partial state history', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, { now: () => NOW, id: ids })
    const state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    const events = [...journal.read(state.retrievalId)]
    const broken = events.map((event, index) => index === 1 ? { ...event, sequence: 4 } : event)
    expect(() => foldRetrievalEvents(broken, state.retrievalId)).toThrow(/序列不连续/u)
  })

  it('rejects provider data that escapes the requested snapshot or evidence allowlist', async () => {
    const ids = deterministicIds()
    const base = provider()
    const wrongSnapshotProvider: TicketRetrievalProvider = {
      ...base,
      async search(principal, snapshotId, query, options) {
        return { ...await base.search(principal, snapshotId, query, options), snapshotId: TicketSnapshotId('other-snapshot') }
      },
    }
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(wrongSnapshotProvider, journal, undefined, { now: () => NOW, id: ids })
    const started = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    await expect(controller.search(PRINCIPAL, started)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })

    const rejectedProvider: TicketRetrievalProvider = {
      ...base,
      async readEvidence(_principal, request) {
        return {
          snapshotId: request.snapshotId,
          evidence: [],
          requestedCandidateRefs: request.candidateRefs,
          rejectedCandidateRefs: request.candidateRefs,
          tokenBudget: request.tokenBudget,
          tokensUsed: 0,
          warnings: ['authorization_changed'],
        }
      },
    }
    const secondIds = deterministicIds()
    const secondJournal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: secondIds })
    const second = new RetrievalController(rejectedProvider, secondJournal, undefined, { now: () => NOW, id: secondIds })
    let state = await second.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = await second.search(PRINCIPAL, state)
    state = second.assess(state, { decision: 'continue', selectedCandidateRefs: [CANDIDATE_REF], gaps: [] })
    await expect(second.promote(PRINCIPAL, state, [CANDIDATE_REF], ['problemDescription'], 20))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('turns exhausted round or latency budgets into a freeze-only convergence path', async () => {
    const ids = deterministicIds()
    const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: ids })
    const controller = new RetrievalController(provider(), journal, undefined, {
      now: () => NOW,
      id: ids,
      maxRounds: 1,
      maxSearches: 3,
      maxPromotions: 3,
      maxLatencyMs: 5,
    })
    let state = await controller.start(PRINCIPAL, { target: 'ranked_cases', query: '登录' })
    state = await controller.search(PRINCIPAL, state)
    expect(state.budget.latencyMs).toBe(7)
    expect(state.allowedActions.map(item => item.kind)).toEqual(['assess', 'read_state'])

    state = controller.assess(state, {
      decision: 'continue',
      selectedCandidateRefs: [CANDIDATE_REF],
      gaps: [{ kind: 'depth', status: 'open', evidenceRefs: [CANDIDATE_REF], evaluator: 'model' }],
    })
    expect(state.allowedActions.map(item => item.kind)).toEqual(['freeze', 'read_state'])
    state = controller.freeze(state, [CANDIDATE_REF])
    expect(state.termination).toBe('partial')
  })
})
