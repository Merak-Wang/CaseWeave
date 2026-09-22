import { describe, expect, it } from 'vitest'
import { collectionBoundary, qualityValue, retrievalSummary, evidenceScopeChanged, learningSteps, trainingExplanation } from './workbench-retrieval.js'
import { activityGroups } from './workbench-orchestration.js'

describe('retrieval workbench presentation', () => {
  it('adds committed judgment counts instead of describing repeated agent reads', () => {
    const groups = activityGroups([8, 8, 3].map((records, i) => ({ id: String(i), actor: '语义筛选', kind: 'judgment', records, text: `已写入 ${records} 条样本判断` })))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ records: 19, text: '已写入 19 条样本判断' })
  })
  it('collapses repeated reads while preserving distinct work and failures', () => {
    const reads = Array.from({ length: 66 }, (_, i) => ({ id: String(i), actor: 'Agent', kind: 'inspect', text: '读取下一组依据' }))
    const groups = activityGroups([...reads, { id: 'failed', actor: 'Agent', kind: 'error', text: '筛选中断' }, reads[0]])
    expect(groups.map(g => g.count)).toEqual([66, 1, 1])
    expect(groups[1].text).toBe('筛选中断')
  })
  it('explains the missing training class without claiming training occurred', () => {
    expect(trainingExplanation({ fitCount: 0, positiveCount: 0, negativeCount: 100, unresolvedCount: 28 })).toContain('尚缺正例')
    expect(trainingExplanation({ fitCount: 4 })).toContain('已完成 4 次')
    expect(learningSteps({ status: 'needs_coverage', scopeCount: 1000, sampledCount: 128, fitCount: 0 })[2]?.state).toBe('pending')
  })
  it('does not invent learning stages when the operator failed before sampling', () => {
    expect(retrievalSummary({ orchestration: { retrieval: { filterActivity: 'failed' } } }).status).toBe('语义筛选未完成')
    expect(learningSteps(undefined, true).every(s => s.state === 'pending')).toBe(true)
    const steps = learningSteps({ status: 'predicting', scopeCount: 1000, sampledCount: 64, fitCount: 4, selectedModel: 'dense_lr', predictedCount: 200 })
    expect(steps.map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'active', 'pending'])
  })
  it('keeps completed training visible when selection resumes', () => {
    const learning = { status: 'resuming_selection', scopeCount: 5000, sampledCount: 384, fitCount: 4, reusedTrainingCount: 128 }
    expect(learningSteps(learning).map(s => s.state)).toEqual(['done', 'done', 'done', 'active', 'pending', 'pending'])
    expect(retrievalSummary({ orchestration: { retrieval: { learning } } }).status).toContain('复用已有模型')
  })
  it('keeps evidence open on new candidates but closes obsolete input, source or report evidence', () => {
    const before = { inputRevision: 1, node: { snapshotShortId: 'source-1', collectionWindow: { version: 'v1' } } }
    expect(evidenceScopeChanged(before, { ...before, node: { ...before.node, collectionWindow: { version: 'v2' } } })).toBe(false)
    expect(evidenceScopeChanged(before, { ...before, inputRevision: 2 })).toBe(true)
    expect(evidenceScopeChanged(before, { ...before, node: { ...before.node, snapshotShortId: 'source-2' } })).toBe(true)
    expect(evidenceScopeChanged(before, { ...before, node: { ...before.node, status: 'permission_blocked' } })).toBe(true)
    expect(evidenceScopeChanged({ ...before, node: { ...before.node, result: { resultRevision: 'r1' } } }, before)).toBe(true)
  })
  it('does not equate enumeration with individual judgments or global recall', () => {
    expect(collectionBoundary({ resultPagesExhausted: true })).toContain('不代表每条线索都已判定')
    expect(collectionBoundary({ resultPagesExhausted: true })).toContain('仍可能遗漏')
  })
  it('keeps failed quality checks separate from a deliverable learned collection', () => {
    const view = retrievalSummary({ orchestration: { retrieval: { learning: {
      status: 'quality_not_met', returned: 1234, quality: { precision_lower: .91, recall_lower: null },
    } } } })
    expect(view.accepted).toBe(false)
    expect(view.status).toBe('集合质量尚未达标')
    expect(qualityValue(view.quality.recall_lower)).toBe('未测量')
    expect(qualityValue(0)).toBe('0.0%')
  })
  it('explains learned membership before the terminal report and clears it on a new snapshot', () => {
    expect(retrievalSummary({ orchestration: { retrieval: { learning: { status: 'quality_passed' } } } }).accepted).toBe(false)
    const view = retrievalSummary({ orchestration: { retrieval: { learning: { status: 'quality_passed', resultAvailable: true } } } })
    expect(view.accepted).toBe(true)
    expect(view.explanation).toContain('未逐条调用语言模型判断')
    expect(retrievalSummary({}).accepted).toBe(false)
    expect(retrievalSummary({ node: { result: { learnedSet: { quality: {} } } } }).accepted).toBe(true)
  })
})
