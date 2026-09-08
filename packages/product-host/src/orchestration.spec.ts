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
