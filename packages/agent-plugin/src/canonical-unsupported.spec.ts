import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { SemanticOperators } from './semantic-operators.js'

describe('explicit unsupported canonical evidence constraint', () => {
  it('uses the real filter boundary to stop unknown before teacher, training or confirmation', async () => {
    let state = { phase: 'searching', inputGeneration: 0, selectedCandidateRefs: [],
      snapshot: { documentProjection: 'canonical-title-abstract-v1', fieldCatalog: [
        { key: 'source.raw_dialogue', accessLevel: 'L3' }] }, budget: {}, query: {
        original: '必须逐字核对对话原文', contract: {
        semanticExecution: { orchestration: 'fixed' }, semanticPlan: { unsupported_constraints: [
          { field: 'source.raw_dialogue', source_text: '必须逐字核对对话原文', provenance: 'host-explicit-raw-request-v1' }],
          steps: [{ op: 'sem_filter', params: { require_source: false, required_fields: [] } }] } } } } as unknown as RetrievalState
    const bridgeRun = vi.fn()
    const stopIncomplete = vi.fn(async (_agent, reason: string) => {
      state = { ...state, phase: 'stopped', termination: 'partial', stopExplanation: reason }
      return state
    })
    const recordOperatorUsage = vi.fn(async (_agent, _generation, usage) => {
      state = { ...state, budget: { ...state.budget, operatorUsage: usage } }
      return state
    })
    const operators = Object.create(SemanticOperators.prototype) as SemanticOperators
    Object.assign(operators, { bridge: { run: bridgeRun }, ensurePlan: vi.fn(async () => state), application: {
      ensureModelAccess: vi.fn(async () => state), current: () => state, recordOperatorUsage, stopIncomplete } })
    const result = await operators.filter({} as Agent)
    expect(recordOperatorUsage).toHaveBeenCalledTimes(1)
    expect(stopIncomplete).toHaveBeenCalledTimes(1)
    expect(bridgeRun).not.toHaveBeenCalled()
    expect(result.phase).toBe('stopped')
    expect(result.stopExplanation).toContain('执行未完成：用户要求的原文证据未包含在当前投影中')
    expect(result.selectedCandidateRefs).toEqual([])
  })

  it('rejects an exact ordinary query falsely mapped to raw evidence at the real filter boundary', async () => {
    const state = { phase: 'searching', inputGeneration: 0, selectedCandidateRefs: [],
      snapshot: { documentProjection: 'canonical-title-abstract-v1', fieldCatalog: [
        { key: 'resolutionSteps', accessLevel: 'L3' }] }, budget: {}, query: { original: '找请求更换设备的工单', contract: {
        semanticExecution: { orchestration: 'fixed' }, semanticPlan: { unsupported_constraints: [
          { field: 'resolutionSteps', source_text: '找请求更换设备的工单', provenance: 'host-explicit-raw-request-v1' }],
          steps: [{ op: 'sem_filter', params: { require_source: false, required_fields: [] } }] } } } } as unknown as RetrievalState
    const bridgeRun = vi.fn(), recordOperatorUsage = vi.fn(), stopIncomplete = vi.fn()
    const operators = Object.create(SemanticOperators.prototype) as SemanticOperators
    Object.assign(operators, { bridge: { run: bridgeRun }, ensurePlan: vi.fn(async () => state), application: {
      ensureModelAccess: vi.fn(async () => state), current: () => state, recordOperatorUsage, stopIncomplete } })
    await expect(operators.filter({} as Agent)).rejects.toThrow('当前用户明确要求')
    expect(bridgeRun).not.toHaveBeenCalled()
    expect(recordOperatorUsage).not.toHaveBeenCalled()
    expect(stopIncomplete).not.toHaveBeenCalled()
  })
})
