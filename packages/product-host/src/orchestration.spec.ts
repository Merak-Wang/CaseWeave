import { describe, expect, it } from 'vitest'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { projectOrchestration } from './orchestration.js'

const state = () => ({ inputGeneration: 2, phase: 'assessed', termination: 'active', candidates: [{ ref: 'current' }],
  budget: {},
  promotedEvidence: [{ candidateRef: 'current' }, { candidateRef: 'current' }, { candidateRef: 'history' }], selectedCandidateRefs: [],
  lastPage: {}, knowledgeCatalog: { status: 'available', releaseId: 'release-a', domains: [{ id: 'card', description: '主副卡', entryIds: ['rules'] }] },
  expertTasks: [{ id: 'current-expert', domainId: 'card', inputGeneration: 2, status: 'running', knowledgeRefs: ['loaded', 'sent'], actionsUsed: 1 },
    { id: 'old-expert', domainId: 'card', inputGeneration: 1, status: 'completed', knowledgeRefs: ['old'] }],
  contextManifests: [{ roleId: 'current-expert', inputGeneration: 2, measurement: 'conservative_estimate', knowledgeRefs: ['loaded'], evidenceIds: [] },
    { roleId: 'current-expert', inputGeneration: 1, measurement: 'dsh_request', knowledgeRefs: ['loaded'], evidenceIds: [] },
    { roleId: 'current-expert', inputGeneration: 2, measurement: 'dsh_request', knowledgeRefs: ['sent'], evidenceIds: ['e1'] }],
} as unknown as RetrievalState)

describe('public orchestration facts', () => {
  it('does not treat a returned expert as delivery while filtering or reviewing', () => {
    const s = { ...state(), expertTasks: state().expertTasks!.map(t => ({ ...t, status: 'completed' as const })) }
    expect(projectOrchestration(s).stage).toBe('review')
    expect(projectOrchestration({ ...s, operatorActivity: { inputGeneration: 2, operation: 'sem_filter', status: 'running', at: '' } }).stage).toBe('review')
    expect(projectOrchestration({ ...s, operatorActivity: { inputGeneration: 2, operation: 'sem_agg', status: 'running', at: '' } }).stage).toBe('synthesis')
  })
  it('uses one actual operator request for context, never cumulative input usage', () => {
    const view = projectOrchestration({ ...state(), budget: { operatorUsage: { reported_prompt_tokens: 80000 } },
      contextManifests: [{ inputGeneration: 2, measurement: 'dsh_request', estimatedTokens: 1500, operator: {
        operation: 'query_plan', metrics: { context: { measuredInputTokens: 1234, limit: 1000000, model: 'deepseek-v4.1-flash', operation: 'query_plan' } },
      } }], operatorActivity: { inputGeneration: 2, operation: 'sem_filter', status: 'failed' },
    } as unknown as RetrievalState)
    expect(view.context).toMatchObject({ measuredInputTokens: 1234, limit: 1000000, source: 'operator' })
    expect(view.retrieval.filterActivity).toBe('failed')
    expect(view.clock.running).toBe(false)
  })
  it('shows historical operator estimates without inventing the old model capacity', () => {
    const view = projectOrchestration({ ...state(), contextManifests: [{ inputGeneration: 2, measurement: 'dsh_request',
      estimatedTokens: 1500, operator: { operation: 'query_plan' } }] } as unknown as RetrievalState)
    expect(view.context).toMatchObject({ estimatedInputTokens: 1500, source: 'operator' })
    expect(view.context?.limit).toBeUndefined()
  })
  it('reads planning usage from the budget after evidence admission strips dynamic metrics', () => {
    const view = projectOrchestration({ ...state(), budget: { operatorUsage: { context: { measuredInputTokens: 9000, limit: 1000000, operation: 'query_plan' } } },
      contextManifests: [{ inputGeneration: 2, measurement: 'dsh_request', estimatedTokens: 12000, operator: { operation: 'query_plan' } }],
    } as unknown as RetrievalState)
    expect(view.context).toMatchObject({ measuredInputTokens: 9000, limit: 1000000, source: 'operator' })
  })
  it('projects the current predicate and bounded learning facts without publishing sampled IDs', () => {
    const view = projectOrchestration({ ...state(), expertTasks: [],
      query: { contract: { semanticPlan: { inputGeneration: 2, instruction: '解绑后仍合账，排除未解绑', keywords: ['解绑', '合账'], retrieval_expressions: ['取消副卡后继续扣费'], goal: { mode: 'all', count: null } } } },
      budget: { operatorUsage: { learning: { input_revision: 2, stop_reason: 'quality_not_met', corpus_records: 20000,
        teacher_unique_records: 128, training_ids: Array.from({ length: 2000 }, (_, i) => i), quality: { precision_lower: .91, recall_lower: null, precision_target: .95, recall_target: .95 } } } },
    } as unknown as RetrievalState)
    expect(view.retrieval.plan).toMatchObject({ instruction: '解绑后仍合账，排除未解绑', goal: { mode: 'all' } })
    expect(view.retrieval.learning).toMatchObject({ status: 'quality_not_met', scopeCount: 20000, sampledCount: 128,
      quality: { precision_lower: .91, recall_lower: null } })
    expect(JSON.stringify(view.retrieval)).not.toContain('training_ids')
  })
  it('reports expert knowledge carried by actual sample judgments, excluding planning and old inputs', () => {
    const view = projectOrchestration({ ...state(), expertTasks: [],
      budget: { operatorUsage: { learning: { input_revision: 2, stop_reason: 'sampling', concurrency: 128, batch_size: 1,
        precision_target: .9, recall_target: .9, sample_size: 128, diversity_records: 25 } } },
      contextManifests: [
        { inputGeneration: 1, measurement: 'dsh_request', operator: { operation: 'sem_filter', knowledgeIds: ['old'] } },
        { inputGeneration: 2, measurement: 'dsh_request', operator: { operation: 'query_plan', knowledgeIds: ['plan-only'] } },
        { inputGeneration: 2, measurement: 'dsh_request', operator: { operation: 'sem_filter', knowledgeIds: ['expiry', 'billing'] } },
      ],
    } as unknown as RetrievalState)
    expect(view.retrieval.learning).toMatchObject({ concurrency: 128, batchSize: 1, precisionTarget: .9, recallTarget: .9,
      sampleSize: 128, diversityCount: 25, knowledgeEntryCount: 2, knowledgeRequestCount: 1 })
  })
  it('drops old plan and learning progress after a condition revision', () => {
    const view = projectOrchestration({ ...state(), query: { contract: { semanticPlan: { inputGeneration: 1 } } },
      budget: { operatorUsage: { learning: { input_revision: 1, stop_reason: 'quality_passed', returned: 99 } } },
    } as unknown as RetrievalState)
    expect(view.retrieval.plan).toBeUndefined()
    expect(view.retrieval.learning).toBeUndefined()
  })
  it('links current sample requests to selected knowledge and stable candidate refs', () => {
    const s = { ...state(), expertTasks: [], candidateHistory: [{ ref: 'a', displayId: 'ESFT-10001' }, { ref: 'b' }], contextManifests: [
      { id: 'old-request', inputGeneration: 1, measurement: 'dsh_request', knowledgeRefs: ['old@1'], candidateRefs: ['old'], operator: { operation: 'sem_filter', knowledgeIds: ['old'] } },
      { id: 'estimate', inputGeneration: 2, measurement: 'conservative_estimate', knowledgeRefs: ['unused@1'], operator: { operation: 'sem_filter', knowledgeIds: ['unused'] } },
      { id: 'plan', inputGeneration: 2, measurement: 'dsh_request', knowledgeRefs: ['plan@1'], operator: { operation: 'query_plan', knowledgeIds: ['plan'] } },
      { id: 'request-1', inputGeneration: 2, measurement: 'dsh_request', knowledgeRefs: ['billing@2', 'quota@3', 'billing@2'], candidateRefs: ['a', 'b', 'a'], operator: { operation: 'sem_filter', knowledgeIds: ['billing', 'quota', 'billing'] } },
      { id: 'request-2', inputGeneration: 2, measurement: 'dsh_request', knowledgeRefs: ['billing@2'], candidateRefs: ['b', 'c'], operator: { operation: 'sem_filter', knowledgeIds: ['billing'] } },
      { id: 'request-empty', inputGeneration: 2, measurement: 'dsh_request', knowledgeRefs: [], candidateRefs: ['d'], operator: { operation: 'sem_filter', knowledgeIds: [] } },
    ] } as unknown as RetrievalState
    const sampling = projectOrchestration(s).samplingKnowledge
    expect(sampling).toEqual({ requestCount: 2, sampleCount: 3, entries: [
      { id: 'billing', reference: 'billing@2', requestCount: 2, sampleCount: 3 },
      { id: 'quota', reference: 'quota@3', requestCount: 1, sampleCount: 2 },
    ], requests: [
      { id: 'request-1', knowledge: [{ id: 'billing', reference: 'billing@2' }, { id: 'quota', reference: 'quota@3' }], candidates: [
        { ref: 'a', displayId: 'ESFT-10001' }, { ref: 'b' }] },
      { id: 'request-2', knowledge: [{ id: 'billing', reference: 'billing@2' }], candidates: [{ ref: 'b' }, { ref: 'c' }] },
      { id: 'request-empty', knowledge: [], candidates: [{ ref: 'd' }] },
    ] })
    expect(projectOrchestration({ ...s, inputGeneration: 3 }).samplingKnowledge).toEqual({ requestCount: 0, sampleCount: 0, entries: [], requests: [] })
  })
  it('projects the Agent-selected knowledge and reasons from the current plan', () => {
    const routes = [{ entry_id: 'expiry', title: '宽带到期', reason: '解释到期后的资费状态' }]
    const view = projectOrchestration({ ...state(), query: { contract: { semanticPlan: {
      inputGeneration: 2, knowledge_routes: routes,
    } } } } as unknown as RetrievalState)
    expect(view.retrieval.plan?.knowledgeRoutes).toEqual(routes)
  })
  it('shows planning and missing-field limits for an empty current generation instead of candidate review', () => {
    const empty = { ...state(), expertTasks: [], candidates: [], query: { unresolvedConstraints: ['来源没有日期字段'], contract: { schemaVersion: 10 } } } as unknown as RetrievalState
    expect(projectOrchestration(empty)).toMatchObject({ stage: 'planning', blockers: ['来源没有日期字段'] })
    const planned = { ...empty, query: { ...empty.query, contract: { ...empty.query.contract!, semanticPlan: { inputGeneration: 2 } } } } as RetrievalState
    expect(projectOrchestration(planned).stage).toBe('coverage')
    expect(projectOrchestration({ ...planned, phase: 'stopped', updatedAt: '2099-01-01T00:00:00Z' }).clock).toMatchObject({ unavailable: true, running: false })
  })
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
