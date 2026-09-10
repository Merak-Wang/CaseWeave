import { describe, expect, it } from 'vitest'
import { TicketCandidateRef, TicketEvidenceId, type RetrievalState, type RetrievalDecision, type ExpertTask } from '@retrieval-agent/contracts'
import { finishReason } from './decision.js'
import { expertConflictResolution, findingPatch, planExperts } from './experts.js'

const ref = TicketCandidateRef('test-current')
const state = { candidates: [{ ref }], candidateHistory: [{ ref }], selectedCandidateRefs: [ref], excludedCandidateRefs: [],
  modelVisibleCandidateRefs: [ref], promotedEvidence: [], query: { unresolvedConstraints: [] }, gaps: [],
  task: { countPolicy: 'explicit', requestedCount: 1 }, lastPage: { boundary: { resultPagesExhausted: true } },
  knowledgeCatalog: { status: 'empty', domains: [] }, inputGeneration: 0,
} as unknown as RetrievalState
const finish = { kind: 'finish', reason: 'satisfied', explanation: '已核对一个个案的来源。',
  coverage: { checked: ['用户指定场景'], remaining: [], nextAction: '个案已足够，不需扩展。', nextActionValue: 'none' },
} satisfies Extract<RetrievalDecision['action'], { kind: 'finish' }>

describe('evidence-backed semantic stopping', () => {
  it('names a missing expert report next_action instead of implying its valid citations are invisible', () => {
    const task = { id: 'expert-1', inputGeneration: 0, status: 'running', candidateRefs: [ref] } as unknown as ExpertTask
    const current = { ...state, expertTasks: [task],
      contextManifests: [{ roleId: task.id, inputGeneration: 0, measurement: 'dsh_request', candidateRefs: [ref], evidenceIds: [] }] } as unknown as RetrievalState
    const finding = { id: 'finding', taskId: task.id, inputGeneration: 0, judgments: [], gaps: [], counterEvidenceRefs: [], nextAction: '' }
    expect(() => findingPatch(current, finding)).toThrow(/next_action/u)
    expect(findingPatch(current, { ...finding, nextAction: '本范围核查完成，交由主 Agent 综合' }).expertTasks?.[0]?.status).toBe('completed')
  })
  it.each(['accept', 'exclude'] as const)('reopens a %s judgment when a late expert brings a conflicting finding', verdict => {
    const pending = { id: 'expert-1', inputGeneration: 0, status: 'running', candidateRefs: [ref] } as unknown as ExpertTask
    const current = { ...state, expertTasks: [pending], judgments: [{ candidateRef: ref, verdict, evidenceRefs: [ref], reason: '先返回的判断' }],
      selectedCandidateRefs: verdict === 'accept' ? [ref] : [], excludedCandidateRefs: verdict === 'exclude' ? [ref] : [],
      contextManifests: [{ roleId: pending.id, inputGeneration: 0, measurement: 'dsh_request', candidateRefs: [ref], evidenceIds: [] }] } as unknown as RetrievalState
    const patch = findingPatch(current, { id: 'late', taskId: pending.id, inputGeneration: 0,
      judgments: [{ candidateRef: ref, verdict: verdict === 'accept' ? 'exclude' : 'accept', reason: '独立核查存在相反来源', evidenceRefs: [ref] }],
      gaps: [], counterEvidenceRefs: [], nextAction: '主 Agent 核对冲突原文' })
    expect(patch.expertConflicts).toMatchObject([{ candidateRef: ref, status: 'open' }])
    expect(patch.selectedCandidateRefs).toEqual([]); expect(patch.excludedCandidateRefs).toEqual([])
    expect(patch.judgments).toMatchObject([{ verdict: 'undetermined' }])
  })
  it('accepts additional independent assignments while rejecting duplicate in-flight work', () => {
    const assignment = { domainId: 'general', goal: '核查业务', scope: '一种边界', candidateRefs: [ref] }
    const tasks = planExperts(state, [assignment], () => 'first')
    expect(() => planExperts({ ...state, expertTasks: tasks }, [assignment], () => 'duplicate')).toThrow(/相同范围/)
    expect(planExperts({ ...state, expertTasks: tasks }, [{ ...assignment, scope: '另一边界' }], () => 'second')).toHaveLength(1)
  })
  it('resolves a disagreement with a visible source and its own overview, but never with only an overview or another ticket', () => {
    const id = TicketEvidenceId('read-source')
    const conflicting = { ...state, modelVisibleEvidenceIds: [id],
      promotedEvidence: [{ evidenceId: id, candidateRef: ref, field: 'problemDescription', projectionLevel: 'L2', text: '原文明确说明办理对象与障碍。' }],
      expertConflicts: [{ candidateRef: ref, status: 'open', findingIds: ['f1', 'f2'], kind: 'business_scope' }],
    } as unknown as RetrievalState
    const judgment = { candidateRef: ref, verdict: 'exclude' as const, evidenceRefs: [ref, id], reason: '依据原文排除',
      conflictResolution: { kind: 'business_scope' as const, reason: '原文支持另一业务对象', evidenceRefs: [ref, id] } }
    expect(expertConflictResolution(conflicting, [judgment])[0]?.status).toBe('resolved')
    for (const refs of [[ref], [ref, 'unseen'], ['another-ticket', id]]) {
      expect(() => expertConflictResolution(conflicting, [{ ...judgment, conflictResolution: { ...judgment.conflictResolution, evidenceRefs: refs } }])).toThrow(/来源片段/)
    }
  })
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
