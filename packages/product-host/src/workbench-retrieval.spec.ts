import { describe, expect, it } from 'vitest'
import { collectionBoundary, qualityValue, retrievalSummary, evidenceScopeChanged } from './workbench-retrieval.js'

describe('retrieval workbench presentation', () => {
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
