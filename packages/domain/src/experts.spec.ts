import { describe, expect, it } from 'vitest'
import { TicketCandidateRef, TicketEvidenceId, type RetrievalState, type RetrievalDecision, type ExpertTask } from '@retrieval-agent/contracts'
import { finishReason } from './decision.js'
import { expertConflictResolution } from './experts.js'

const ref = TicketCandidateRef('test-current')
const state = { candidates: [{ ref }], selectedCandidateRefs: [ref], excludedCandidateRefs: [],
  modelVisibleCandidateRefs: [ref], promotedEvidence: [], query: { unresolvedConstraints: [] }, gaps: [],
  task: { countPolicy: 'explicit', requestedCount: 1 }, lastPage: { boundary: { resultPagesExhausted: true } },
  knowledgeCatalog: { status: 'empty', domains: [] }, inputGeneration: 0,
} as unknown as RetrievalState
const finish = { kind: 'finish', reason: 'satisfied', explanation: '已核对一个个案的来源。',
  coverage: { checked: ['用户指定场景'], remaining: [], nextAction: '个案已足够，不需扩展。', nextActionValue: 'none' },
} satisfies Extract<RetrievalDecision['action'], { kind: 'finish' }>

describe('evidence-backed semantic stopping', () => {
  it('does not relabel a read L1 summary as decisive source evidence for a disagreement', () => {
    const id = TicketEvidenceId('read-summary')
    const conflicting = { ...state, modelVisibleEvidenceIds: [id],
      promotedEvidence: [{ evidenceId: id, candidateRef: ref, field: 'summary', projectionLevel: 'L1', displayId: 'TEST',
        sourceVersion: 'v1', contentHash: 'hash', text: '摘要', start: 0, end: 2, estimatedTokens: 2, trust: 'untrusted_ticket_evidence', truncated: false }],
      expertConflicts: [{ candidateRef: ref, status: 'open', findingIds: ['f1', 'f2'], kind: 'fact' }],
    } as RetrievalState
    expect(() => expertConflictResolution(conflicting, [{ candidateRef: ref, verdict: 'accept', evidenceRefs: [id], reason: '摘要重复支持',
      conflictResolution: { kind: 'fact', reason: '只有重读摘要', evidenceRefs: [id] } }])).toThrow(/来源片段/)
  })
  it('does not treat the count or exhausted page as a substitute for coverage and next-action value', () => {
    expect(() => finishReason(state, { kind: 'finish', reason: 'satisfied', explanation: '数量够了' })).toThrow(/coverage/)
    expect(() => finishReason(state, { ...finish, coverage: { ...finish.coverage, nextActionValue: 'useful' } })).toThrow(/尚未满足/)
    expect(finishReason(state, { ...finish, reason: 'incomplete', coverage: { ...finish.coverage, remaining: ['原因排除尚未核实'] } })).toBe('partial')
    expect(finishReason(state, finish)).toBe('top_k_accepted')
  })
  it('requires explicit main evidence review of a failed expert scope, and cannot bypass in-flight work or open disagreement', () => {
    const task = { id: 'expert-1', inputGeneration: 0, status: 'failed' } as ExpertTask
    const failed = { ...state, expertTasks: [task] }
    expect(() => finishReason(failed, finish)).toThrow(/尚未满足/)
    expect(() => finishReason(failed, finish)).toThrow('coverage.expertReviews 缺少分支 expert-1')
    const reviewed = { ...finish, coverage: { ...finish.coverage, expertReviews: [{ taskId: task.id, reason: '主 Agent 已读取并完成该分支个案核对。', evidenceRefs: [ref] }] } }
    expect(finishReason(failed, reviewed)).toBe('top_k_accepted')
    expect(() => finishReason({ ...failed, expertTasks: [{ ...task, status: 'running' }] }, reviewed)).toThrow(/已结束分支/)
    expect(() => finishReason(failed, { ...reviewed, coverage: { ...reviewed.coverage, expertReviews: [{ taskId: task.id, reason: '猜测', evidenceRefs: ['unread'] }] } })).toThrow(/尚未收到/)
    expect(() => finishReason({ ...failed, expertConflicts: [{ candidateRef: ref, status: 'open', findingIds: ['f1', 'f2'], kind: 'fact' }] }, reviewed)).toThrow(/尚未满足/)
  })
})
