import { describe, expect, it } from 'vitest'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { decisionFromArguments } from './assessment.js'

describe('model decision adapter', () => {
  it('keeps an unknown coverage gap as a model observation and leaves unjudged tickets unselected', () => {
    const state = { candidates: [], candidateHistory: [], promotedEvidence: [] } as unknown as RetrievalState
    const decision = decisionFromArguments(state, {
      state_id: 'state-1', judgments: [],
      action: { kind: 'search', query: '副卡解绑' },
      semantic_gaps: [{ kind: 'coverage', status: 'unknown', evidence_aliases: [], description: '当前结果不能证明语义召回完整。' }],
    })
    expect(decision.judgments).toEqual([])
    expect(decision.gaps).toEqual([{ kind: 'coverage', status: 'unknown', evidenceRefs: [], evaluator: 'model', description: '当前结果不能证明语义召回完整。' }])
  })
})
