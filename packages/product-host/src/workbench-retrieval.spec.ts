import { describe, expect, it } from 'vitest'
import { collectionBoundary, qualityValue, qualityDescription, retrievalSummary, evidenceScopeChanged, learningSteps, executionDescription, usesFeedbackLearning, hasFinalTeacherReference, finalTeacherAgreementDescription, selectionReasonDescription } from './workbench-retrieval.js'
import { activityGroups, knowledgeConsumers } from './workbench-orchestration.js'

describe('retrieval workbench presentation', () => {
  it('describes the execution saved on the task, independent of new-task form settings', () => {
    const frozen = { onlineLearning: false, semanticMethod: 'auto' }
    const snapshot = { orchestration: { retrieval: { execution: frozen } } }
    expect(retrievalSummary(snapshot).execution).toEqual(frozen)
    expect(retrievalSummary(snapshot).method).toBe('固定判据逐条判断')
    expect(retrievalSummary({ orchestration: { retrieval: { execution: { onlineLearning: true, semanticMethod: 'auto' } } } }).method).toBe('语义筛选')
  })
  it.each([['dual_description_margin', '双描述匹配'], ['name_gmm', 'GMM 名称聚类'], ['kmeans', 'KMeans 聚类']])('keeps %s candidates unconfirmed and quality unmeasured', (semanticMethod, label) => {
    const execution = { onlineLearning: false, semanticMethod, orchestration: 'fixed' }
    const view = retrievalSummary({ orchestration: { retrieval: { execution,
      learning: { status: 'model_unknown', qualityBasis: 'unmeasured', quality: 'unmeasured', positiveCount: 24, resultAvailable: false } } } })
    expect(view).toMatchObject({ unmeasured: true, accepted: false, method: label, status: '算法判定已保存' })
    expect(executionDescription(execution)).toBe(`本任务：${label}。`)
    expect(usesFeedbackLearning(execution)).toBe(false)
  })
  it('describes actual feedback training and leaves legacy mode unspecified', () => {
    expect(executionDescription(undefined)).toBe('')
    expect(executionDescription({ onlineLearning: true, semanticMethod: 'auto' })).toBe('本任务：在线学习（模型伪标签）。')

  })
  it('shows sample knowledge usage even without a domain expert', () => {
    const orchestration = { experts: [], samplingKnowledge: { entries: [{ id: 'billing', reference: 'billing@2', requestCount: 12 }] } }
    expect(knowledgeConsumers(orchestration, 'billing@2', 'billing')).toEqual([{ title: '抽样判断', requestCount: 12 }])
    expect(knowledgeConsumers(orchestration, 'billing@1', 'billing')).toEqual([])
  })
  it('shows a neutral completion state and concise selection metrics', () => {
    const quality = { basis: 'selection', precision: .6, recall: .8, acceptance: 'fallback' }
    const view = retrievalSummary({ orchestration: { retrieval: { learning: { status: 'quality_fallback', quality, resultAvailable: true } } } })
    expect(view.status).toBe('语义筛选已完成')
    expect(qualityDescription(quality)).toBe('选择集 P/R：60.0% / 80.0%')
    expect(qualityDescription(quality)).not.toMatch(/未达标|可能遗漏|60%|未逐条|全库质量/u)
    expect(retrievalSummary({ orchestration: { retrieval: { learning: { status: 'quality_fallback' } } } }).status).toBe('模型选择完成')
    const unknown = retrievalSummary({ orchestration: { retrieval: { learning: { status: 'model_unknown' } } } })
    expect(unknown.accepted).toBe(false)
    expect(unknown.status).toBe('未完成：质量未达标')
  })
  it('shows selection metrics without population bounds or a pending audit stage', () => {
    const quality = { basis: 'selection', precision: .903, recall: .915 }
    const learning = { status: 'quality_passed', quality, resultAvailable: true }
    const view = retrievalSummary({ orchestration: { retrieval: { learning } } })
    expect(view.status).toBe('语义筛选已完成')
    expect(qualityDescription(quality)).toContain('选择集 P/R：90.3% / 91.5%')
    expect(qualityDescription(quality)).not.toContain('下界')
    expect(learningSteps(learning)).toHaveLength(5)
    expect(qualityDescription({ precision_lower: .827, recall_lower: .016 })).toBe('历史抽验 P/R 下界：82.7% / 1.6%')
    expect(learningSteps({ auditCount: 577 }).at(-1)?.label).toBe('历史独立抽验')
  })
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
  it('keeps the current workflow status and genuine execution failures', () => {
    expect(learningSteps({ status: 'needs_coverage', scopeCount: 1000, sampledCount: 128, fitCount: 0 })[2]?.state).toBe('pending')
    expect(retrievalSummary({ orchestration: { retrieval: { filterActivity: 'failed' } } }).status).toBe('语义筛选失败')
    expect(learningSteps(undefined, true).every(s => s.state === 'pending')).toBe(true)
    const steps = learningSteps({ status: 'predicting', scopeCount: 1000, sampledCount: 64, fitCount: 4, selectedModel: 'dense_lr', predictedCount: 200 })
    expect(steps.map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'active'])
  })
  it('keeps completed training visible when selection resumes', () => {
    const learning = { status: 'resuming_selection', scopeCount: 5000, sampledCount: 384, fitCount: 4, reusedTrainingCount: 128 }
    expect(learningSteps(learning).map(s => s.state)).toEqual(['done', 'done', 'done', 'active', 'pending'])
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
  it('summarizes expression enumeration without speculative caveats', () => {
    expect(collectionBoundary({ resultPagesExhausted: true })).toBe('当前检索表达式已枚举完。')
    expect(collectionBoundary({ resultPagesExhausted: false, semanticRecallKnown: false })).toBe('当前检索表达式未全部枚举。')
  })
  it('keeps an ended selection separate from an available result', () => {
    const view = retrievalSummary({ orchestration: { retrieval: { learning: {
      status: 'quality_not_met', returned: 1234, quality: { precision_lower: .91, recall_lower: null },
    } } } })
    expect(view.accepted).toBe(false)
    expect(view.status).toBe('未完成：质量未达标')
    expect(qualityDescription(view.quality)).not.toContain('未达标')
    expect(qualityValue(view.quality.recall_lower)).toBe('未测量')
    expect(qualityValue(0)).toBe('0.0%')
  })
  it('explains learned membership before the terminal report and clears it on a new snapshot', () => {
    expect(retrievalSummary({ orchestration: { retrieval: { learning: { status: 'quality_passed' } } } }).accepted).toBe(false)
    const view = retrievalSummary({ orchestration: { retrieval: { learning: { status: 'quality_passed', resultAvailable: true } } } })
    expect(view.accepted).toBe(true)
    expect(retrievalSummary({}).accepted).toBe(false)
    expect(retrievalSummary({ node: { result: { learnedSet: { quality: {} } } } }).accepted).toBe(true)
  })
  it('uses only stored fusion options and leaves legacy execution generic', () => {
    expect(executionDescription({ onlineLearning: true, semanticMethod: 'auto' })).toBe('本任务：在线学习（模型伪标签）。')
    expect(executionDescription({ onlineLearning: true, semanticMethod: 'auto', onlineFusion: 'selective', onlineModels: ['dense_lr', 'feedback_margin'] })).toBe('本任务：在线学习（模型伪标签） · 二分类多数投票 · 2 个候选模型。')
    expect(executionDescription({ onlineLearning: true, semanticMethod: 'auto', onlineFusion: 'single' })).toBe('本任务：在线学习（模型伪标签） · 最佳单模型。')
  })
  it.each([undefined, null, NaN, Infinity, -Infinity, -.1, 1.1])('never presents invalid quality %s as a percentage', value => {
    expect(qualityValue(value)).toBe('未测量')
  })
  it('labels cross-fit teacher reference separately from legacy selection and audit', () => {
    const quality = { basis: 'training_group_crossfit', precision: .91, recall: .86, reference_basis: 'teacher', business_accuracy: 'not_measured' }
    expect(qualityDescription(quality)).toBe('训练组交叉拟合教师一致率 P/R：91.0% / 86.0%；用于选模，非独立验收。')
    expect(learningSteps({ quality })[3]!.label).toBe('训练组交叉拟合与模型选择')
    expect(qualityDescription({ basis: 'independent_audit', precision_lower: .8, recall_lower: .7 })).toBe('历史抽验 P/R 下界：80.0% / 70.0%')
    expect(qualityDescription({ basis: 'unknown', precision_lower: .8 })).toBe('质量参考未测量。')
    expect(qualityValue(1)).toBe('100.0%')
  })
  it('shows final teacher metrics only with explicit unused raw-prediction reference', () => {
    const reference = { precision: .9, recall: .8, reference_records: 12, reference_basis: 'teacher', used_for_selection: false, raw_before_label_override: true }
    expect(hasFinalTeacherReference(reference)).toBe(true)
    expect(finalTeacherAgreementDescription(reference)).toContain('最终留出集教师一致率 P/R：90.0% / 80.0%')
    expect(finalTeacherAgreementDescription(reference)).toContain('不是业务准确率或最终独立验收')
    for (const invalid of [{ reference_basis: undefined }, { reference_basis: 'business_gold' }, { used_for_selection: undefined },
      { used_for_selection: true }, { raw_before_label_override: undefined }, { raw_before_label_override: false }, { reference_records: 0 }]) {
      const result = { ...reference, ...invalid }
      expect(hasFinalTeacherReference(result)).toBe(false)
      expect(finalTeacherAgreementDescription(result)).toBe('最终留出教师参考未验证。')
    }
    expect(finalTeacherAgreementDescription({ ...reference, precision: NaN, recall: null })).toContain('未测量 / 未测量')
    expect(selectionReasonDescription('no_oof_diversity_gain')).toContain('融合未优于单模型')
  })
})
