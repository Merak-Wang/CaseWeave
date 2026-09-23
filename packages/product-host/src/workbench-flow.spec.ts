import { describe, expect, it } from 'vitest'
import { sampleAllocation, workflowSteps } from './workbench-flow.js'

describe('persistent retrieval workflow', () => {
  const finished = { node: { result: { resultRevision: 'r1' } }, orchestration: { stage: 'finished', terminal: true,
    fastQueryComplete: true, retrieval: { learning: { status: 'quality_fallback' } } } }
  it('moves from filtering to a real report job and keeps earlier steps accessible', () => {
    const steps = workflowSteps(finished, 'running')
    expect(steps.map(s => [s.label, s.state])).toEqual([['线索召回', 'done'], ['语义筛选', 'done'], ['检索报告', 'active']])
    expect(steps[1]).toMatchObject({ view: 'process', target: 'learning-progress', note: '抽样、领域判断与选模' })
    expect(workflowSteps(finished, 'ready').map(s => s.state)).toEqual(['done', 'done', 'done'])
    expect(workflowSteps(finished)[2]).toMatchObject({ state: 'upcoming', note: '可生成报告' })
  })
  it('keeps expert work within filtering and does not invent a completed report', () => {
    expect(workflowSteps({ orchestration: { stage: 'experts', fastQueryComplete: true } }).map(s => s.state)).toEqual(['done', 'active', 'upcoming'])
    expect(workflowSteps({ orchestration: { stage: 'finished', terminal: true, retrieval: { filterActivity: 'failed' } } })[1]?.state).toBe('failed')
    expect(workflowSteps({ ...finished, node: { status: 'permission_blocked', result: {} } }, 'ready')[2]?.state).toBe('upcoming')
    expect(workflowSteps(finished, 'failed')[2]?.note).toContain('可重试')
    expect(workflowSteps({ ...finished, orchestration: { ...finished.orchestration, outcome: 'cancelled' } })[1]?.state).toBe('stopped')
  })
  it('explains the real 320-sample split without treating unknowns as training labels', () => {
    expect(sampleAllocation({ trainingCount: 34, selectionCount: 256, unresolvedCount: 149,
      quality: { basis: 'selection', selection_unknown: 119 } })).toEqual({
      training: { total: 64, labeled: 34, unknown: 30 }, selection: { total: 256, labeled: 137, unknown: 119 },
    })
    expect(sampleAllocation({ trainingCount: 34 })).toBeUndefined()
  })
})
