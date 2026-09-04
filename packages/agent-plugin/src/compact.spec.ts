import { describe, expect, it } from 'vitest'
import { TicketCandidateRef, type RetrievalState } from '@retrieval-agent/contracts'
import { candidateAliases, compactTerminalReceipt } from './compact.js'

describe('stable model references and terminal receipt', () => {
  it('keeps a candidate alias when current rank changes or an older candidate becomes ineligible', () => {
    const first = { ref: TicketCandidateRef('opaque-1') }
    const second = { ref: TicketCandidateRef('opaque-2') }
    const state = { candidateHistory: [first, second], candidates: [second, first] } as unknown as RetrievalState
    expect([...candidateAliases(state)]).toEqual([[first.ref, 'c1'], [second.ref, 'c2']])
    expect([...candidateAliases({ ...state, candidates: [second] } as unknown as RetrievalState)]).toEqual([[first.ref, 'c1'], [second.ref, 'c2']])
  })
  it('reports confirmed and pending counts with a concrete stop reason without replaying ticket content', () => {
    const state = { retrievalId: 'retrieval-terminal', phase: 'stopped', termination: 'partial', gaps: [],
      selectedCandidateRefs: ['opaque-1'], excludedCandidateRefs: [], candidates: [{ ref: 'opaque-1' }, { ref: 'opaque-2' }],
      stopExplanation: '另一个候选尚未读取处理过程。',
      frozenEvidence: { packId: 'pack-1', complete: false, topKAccepted: false, resultPagesExhausted: true,
        semanticRecallKnown: false, resultMayBeIncomplete: true, nextPageAvailable: false,
        candidates: [{ ref: 'opaque-1', displayId: 'TKT-1' }], },
      budget: { modelStepsUsed: 1, searchesUsed: 2, wallClockElapsedMs: 10 },
    } as unknown as RetrievalState
    const receipt = compactTerminalReceipt(state)
    expect(receipt).toMatchObject({ schemaVersion: 4, selectedCount: 1, undeterminedCount: 1, explanation: '另一个候选尚未读取处理过程。' })
    expect(JSON.stringify(receipt)).not.toContain('TKT-1')
    expect(JSON.stringify(receipt)).not.toContain('opaque-1')
  })
})
