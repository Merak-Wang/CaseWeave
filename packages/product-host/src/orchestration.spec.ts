import { describe, expect, it } from 'vitest'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { projectOrchestration } from './orchestration.js'

const state = () => ({ inputGeneration: 2, phase: 'assessed', termination: 'active', candidates: [{ ref: 'current' }],
  promotedEvidence: [{ candidateRef: 'current' }, { candidateRef: 'current' }, { candidateRef: 'history' }], selectedCandidateRefs: [],
  lastPage: {}, knowledgeCatalog: { status: 'available', releaseId: 'release-a', domains: [{ id: 'card', description: '主副卡', entryIds: ['rules'] }] },
  expertTasks: [{ id: 'current-expert', domainId: 'card', inputGeneration: 2, status: 'running', knowledgeRefs: ['loaded', 'sent'], actionsUsed: 1 },
    { id: 'old-expert', domainId: 'card', inputGeneration: 1, status: 'completed', knowledgeRefs: ['old'] }],
  contextManifests: [{ roleId: 'current-expert', inputGeneration: 2, measurement: 'conservative_estimate', knowledgeRefs: ['loaded'], evidenceIds: [] },
    { roleId: 'current-expert', inputGeneration: 1, measurement: 'dsh_request', knowledgeRefs: ['loaded'], evidenceIds: [] },
    { roleId: 'current-expert', inputGeneration: 2, measurement: 'dsh_request', knowledgeRefs: ['sent'], evidenceIds: ['e1'] }],
} as unknown as RetrievalState)

describe('public orchestration facts', () => {
  it('counts only output usage and retains prior expert rounds in the task total', () => {
    const original = state()
    const measured = { ...original, budget: { totalOutputTokens: 100, totalMeasuredInputTokens: 9000, modelStepsUsed: 3, maxSearches: 2500, searchesUsed: 1, wallClockElapsedMs: 10 },
      expertTasks: original.expertTasks!.map((t, i) => ({ ...t, outputTokens: i ? 30 : 20, inputTokens: 7000, modelSteps: 1 })) } as RetrievalState
    const usage = projectOrchestration(measured).usage
    expect(usage).toMatchObject({ outputTokens: 150, mainOutputTokens: 100, expertOutputTokens: 50, modelRequests: 5 })
    expect(usage.experts).toHaveLength(2)
    expect(projectOrchestration(measured).experts).toHaveLength(1)
  })
  it('does not count a long clarification pause as active execution', () => {
    const view = projectOrchestration({ ...state(), createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T01:00:00Z',
      executionClock: { totalWaitingMs: 0, waitingSince: '2026-09-09T00:01:00Z' } })
    expect(view.clock).toEqual({ elapsedMs: 60_000, running: false })
    const resumed = projectOrchestration({ ...state(), createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T01:01:00Z',
      userFeedback: [{ text: '继续', receivedAt: '2026-09-09T00:59:00Z' }],
      executionClock: { totalWaitingMs: 59 * 60_000 } })
    expect(resumed.clock).toEqual({ elapsedMs: 120_000, running: true })
  })
  it('distinguishes loaded priors from actual current-generation model requests and excludes historical branches', () => {
    const view = projectOrchestration(state())
    expect(view.experts).toHaveLength(1)
    expect(view.experts[0]).toMatchObject({ title: '主副卡', evidenceCount: 1, requestCount: 1,
      knowledge: [{ reference: 'loaded', used: false }, { reference: 'sent', used: true }] })
    expect(view.counts.inspected).toBe(1)
    expect(view.stage).toBe('experts')
  })
  it('retains incomplete outcome when execution stops with unfinished experts', () => {
    const view = projectOrchestration({ ...state(), phase: 'stopped', termination: 'budget_exhausted' })
    expect(view).toMatchObject({ stage: 'finished', terminal: true, outcome: 'budget_exhausted' })
    expect(view.counts.completedExperts).toBe(0)
  })
})
