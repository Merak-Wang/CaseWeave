import { describe, expect, it } from 'vitest'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { assessmentFromOutcome } from './assessment.js'

describe('model assessment adapter', () => {
  it('accepts a model-visible coverage gap while leaving it marked as a model observation', () => {
    const state = {
      task: { completenessRequirement: 'top_k' },
      candidates: [],
      candidateHistory: [],
      promotedEvidence: [],
      allowedActions: [],
    } as unknown as RetrievalState

    const assessment = assessmentFromOutcome(state, {
      verdict: 'continue',
      next: { type: 'keyword_search' },
      semantic_gaps: [{
        kind: 'coverage',
        status: 'unknown',
        evidence_aliases: [],
        description: '当前结果不能证明语义召回完整。',
      }],
    })

    expect(assessment.gaps).toEqual([{
      kind: 'coverage',
      status: 'unknown',
      evidenceRefs: [],
      evaluator: 'model',
      description: '当前结果不能证明语义召回完整。',
    }])
  })
})
