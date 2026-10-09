import { createHash } from 'node:crypto'
import { RetrievalError, type RetrievalState, type RetrievalCandidateJudgment, type TicketCandidate } from '@retrieval-agent/contracts'

export type PredictionSelection = 'accept' | 'all'
const methods = ['dual_description_margin', 'name_gmm', 'kmeans']
/** Server-side prediction allowlist. A proposed class never changes confirmed membership. */
export function predictionRows(state: RetrievalState, selection: PredictionSelection = 'accept'): readonly { candidate: TicketCandidate; judgment: RetrievalCandidateJudgment }[] {
  if (!['accept', 'all'].includes(selection)) throw new RetrievalError('INVALID_REQUEST', '候选预测范围无效。')
  if (state.accessValidation !== 'current' || ['permission_blocked', 'snapshot_invalid'].includes(state.termination)) return []
  const method = state.query.contract?.semanticExecution?.semanticMethod
  if (!method || !methods.includes(method) || !state.snapshot) return []
  const excluded = new Set(state.excludedCandidateRefs), selected = new Set(state.selectedCandidateRefs)
  const judgments = new Map((state.judgments ?? []).map(j => [j.candidateRef, j]))
  return state.candidates.flatMap(candidate => {
    const judgment = judgments.get(candidate.ref), inference = judgment?.operatorInference
    if (!judgment || judgment.basis !== 'unresolved' || judgment.verdict !== 'undetermined'
      || inference?.quality !== 'unmeasured' || inference.input_revision !== (state.inputGeneration ?? 0)
      || inference.algorithm !== method || !['accept', 'exclude', 'undetermined'].includes(String(inference.proposed_label))
      || excluded.has(candidate.ref) || selected.has(candidate.ref)) return []
    if (candidate.snapshotId !== state.snapshot!.snapshotId || inference.source_version !== candidate.sourceVersion
      || inference.content_hash !== candidate.contentHash
      || inference.record_identity !== createHash('sha256').update(JSON.stringify([candidate.ref, candidate.sourceVersion, candidate.contentHash])).digest('hex')) {
      throw new RetrievalError('SNAPSHOT_INVALID', '候选预测的工单来源身份已变化，请重新判别。')
    }
    return selection === 'accept' && inference.proposed_label !== 'accept' ? [] : [{ candidate, judgment }]
  })
}
