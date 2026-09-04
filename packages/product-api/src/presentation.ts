import type {
  RetrievalId,
  RetrievalState,
  TicketCandidateNode,
} from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/ticket-collection'

const STATUS_MESSAGES: Partial<Record<RetrievalState['termination'], string>> = {
  no_result: '当前检索表达式没有返回候选；这不能证明授权工单库中不存在语义相关工单。',
  partial: '已返回部分候选，仍有未解决的证据缺口。',
  budget_exhausted: '检索预算已耗尽，以下结果可能不完整。',
  permission_blocked: '当前身份没有足够权限完成此检索。',
  backend_error: '工单来源暂时不可用。',
  snapshot_invalid: '授权快照已失效，请重新检索。',
  cancelled: '检索已取消。',
}

function statusOf(state: RetrievalState | undefined): TicketCandidateNode['status'] {
  if (state === undefined || state.phase === 'created' || state.phase === 'snapshot_opened') return 'searching'
  switch (state.termination) {
    case 'permission_blocked': return 'permission_blocked'
    case 'snapshot_invalid': return 'snapshot_invalid'
    case 'backend_error': return 'error'
    case 'no_result': return 'empty'
    case 'partial':
    case 'budget_exhausted': return 'partial'
    case 'cancelled': return 'stopped'
    case 'active': return state.candidates.length === 0 ? 'searching' : 'results'
    case 'needs_clarification': return state.candidates.length === 0 ? 'searching' : 'results'
    case 'top_k_accepted': return state.candidates.length === 0 ? 'empty' : 'results'
    default: return state.termination satisfies never
  }
}

/** Pure authorized-state projection shared by Host and historical replay. Authorization happens at the Host boundary. */
export function projectTicketCandidateState(
  state: RetrievalState | undefined,
  retrievalId: RetrievalId,
  fallback: { readonly query?: string; readonly queryContract?: RetrievalState['query']['contract'] } = {},
): TicketCandidateNode {
  const queryContract = state?.query.contract ?? fallback.queryContract
  const querySummary = state?.query.original ?? fallback.query ?? ''
  const status = statusOf(state)
  const message = state?.termination === 'needs_clarification'
    ? state.clarification?.question
    : state?.stopExplanation ?? (state === undefined ? undefined : STATUS_MESSAGES[state.termination])
  const result = state?.phase === 'stopped' ? createTicketResultCollection(state) : undefined
  const candidates = result === undefined
    ? (state?.candidates ?? []).filter(candidate => !state?.excludedCandidateRefs.includes(candidate.ref))
    : [...result.tickets, ...(result.undeterminedCandidates ?? [])]
  const resultPagesExhausted = state?.lastPage?.boundary?.resultPagesExhausted
    ?? (state?.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined)
  return {
    retrievalId,
    version: state?.revision ?? 0,
    querySummary,
    ...(state === undefined ? {} : { confirmedConstraints: state.query.confirmedConstraints, selectedCandidateRefs: state.selectedCandidateRefs }),
    ...(queryContract?.logic === undefined ? {} : { queryLogic: queryContract.logic }),
    ...(queryContract === undefined ? {} : {
      normalizedQuery: queryContract.normalized,
      resultPolicy: queryContract.resultPolicy,
      fastQuery: queryContract.fastQuery,
      queryAmbiguities: queryContract.ambiguities,
    }),
    ...(state?.snapshot === undefined ? {} : { snapshotShortId: state.snapshot.shortId }),
    completeness: state?.lastPage?.completeness ?? 'pending',
    nextPageAvailable: state?.lastPage?.nextCursor !== undefined,
    resultPagesExhausted,
    semanticRecallKnown: state?.lastPage?.boundary?.semanticRecallKnown ?? false,
    ...(state?.lastPage?.boundary === undefined ? {} : { boundary: state.lastPage.boundary }),
    status,
    candidates,
    alreadyReadEvidence: result?.evidence ?? state?.promotedEvidence ?? [],
    detailFields: state?.snapshot?.fieldCatalog
      .filter(field => field.accessLevel === 'L2' && field.valueKind !== 'raw_json')
      .map(field => ({ key: field.key, label: field.label })) ?? [],
    ...(message === undefined ? {} : { message }),
    exportEnabled: state?.snapshot?.capabilities.exportRead === true
      && candidates.length > 0
      && !['snapshot_invalid', 'permission_blocked', 'error'].includes(status),
    ...(result === undefined ? {} : { result }),
  }
}
