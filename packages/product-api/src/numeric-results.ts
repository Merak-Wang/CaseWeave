import { RetrievalError, type RetrievalState, type SemanticResultStore, type TicketRetrievalProvider,
  type TrustedPrincipalContext, type TicketCandidateRef } from '@retrieval-agent/contracts'
import { learnedResult } from '@retrieval-agent/domain/result'
import type { CandidateWindow } from './window.js'

/** 按数值键分页；正文仅在当前页面经 Provider 重新授权后读取。 */
export async function learnedResultWindow(state: RetrievalState, provider: TicketRetrievalProvider,
  principal: TrustedPrincipalContext, store: SemanticResultStore, cursor?: string, limit = 30): Promise<CandidateWindow> {
  const result = learnedResult(state)
  if (!result || !provider.resolveFeatureIds || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RetrievalError('INVALID_REQUEST', '学习结果或页宽无效。')
  let after = -1, offset = 0
  if (cursor) {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value.version !== result.model_id) throw new RetrievalError('INVALID_TRANSITION', '集合已更新，请重新打开第一页。')
    after = value.after; offset = value.offset
    if (!Number.isSafeInteger(after) || !Number.isSafeInteger(offset) || after < 0 || offset < 0) throw new RetrievalError('INVALID_REQUEST', '数值集合游标无效。')
  }
  const block = await store.page(state.retrievalId, result.model_id, after, limit)
  const items = await provider.resolveFeatureIds(principal, { snapshotId: state.snapshot!.snapshotId, ids: block.ids })
  if (items.length !== block.ids.length) throw new RetrievalError('SNAPSHOT_INVALID', '集合来源已变化。')
  return { view: 'confirmed', version: result.model_id, offset, total: result.returned, limit, items,
    readableCandidateRefs: items.map(c => c.ref), judgments: items.map(c =>
      state.judgments?.find(j => j.candidateRef === c.ref && j.verdict === 'accept') ?? {
        candidateRef: c.ref, verdict: 'accept', reason: '学习模型集合预测；本条未逐条交 LLM 判断。', basis: 'proxy', evidenceRefs: [] }),
    ...(offset + items.length < result.returned && block.ids.length ? { nextCursor: Buffer.from(JSON.stringify({ version: result.model_id,
      after: block.ids.at(-1), offset: offset + items.length })).toString('base64url') } : {}) }
}

export async function materializeLearnedRefs(state: RetrievalState, provider: TicketRetrievalProvider,
  principal: TrustedPrincipalContext, store: SemanticResultStore, refs: readonly TicketCandidateRef[]): Promise<RetrievalState> {
  const result = learnedResult(state)
  if (!result || !provider.featureBlock || !provider.resolveFeatureIds) return state
  const block = await provider.featureBlock(principal, { snapshotId: state.snapshot!.snapshotId, refs, limit: refs.length })
  const ids: number[] = []
  for (const id of block.ids) if ((await store.page(state.retrievalId, result.model_id, id-1, 1)).ids[0] === id) ids.push(id)
  const rows = await provider.resolveFeatureIds(principal, { snapshotId: state.snapshot!.snapshotId, ids })
  if (rows.length !== new Set(refs).size || rows.some(c => !refs.includes(c.ref))) throw new RetrievalError('CANDIDATE_NOT_FOUND', '工单不属于当前学习结果集合。')
  const byRef = new Map(state.candidates.map(c => [c.ref, c])); rows.forEach(c => byRef.set(c.ref, c))
  return { ...state, candidates: [...byRef.values()], selectedCandidateRefs: [...new Set([...state.selectedCandidateRefs, ...refs])],
    judgments: [...(state.judgments ?? []).filter(j => !refs.includes(j.candidateRef)), ...rows.map(c =>
      state.judgments?.find(j => j.candidateRef === c.ref && j.verdict === 'accept') ?? { candidateRef: c.ref,
        verdict: 'accept' as const, reason: '学习模型集合预测；本条未逐条交 LLM 判断。', basis: 'proxy' as const,
        evidenceRefs: [], operatorInference: { algorithm: 'learned', proposal: String(result.metadata.model), phase: 'prediction',
          model_id: result.model_id, proposed: 1, inferred: true } })] }
}
