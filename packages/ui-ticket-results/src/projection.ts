import type {
  RetrievalDomainEvent,
  RetrievalId,
  RetrievalState,
  TicketCandidateNode,
} from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/ticket-collection'

const STATUS_MESSAGES: Partial<Record<RetrievalState['termination'], string>> = {
  no_result: '当前授权快照中没有匹配工单。',
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
    case 'sufficient': return state.candidates.length === 0 ? 'empty' : 'results'
    default: return state.termination satisfies never
  }
}

/** Pure, replay-safe projection from one retrieval event stream to a UI node. */
export function projectTicketCandidateNode(
  events: readonly RetrievalDomainEvent[],
  retrievalId: RetrievalId,
): TicketCandidateNode {
  const relevant = events.filter(event => event.retrievalId === retrievalId)
  const contract = relevant.find(event => event.type === 'retrieval/query-contracted')
  const states = relevant.filter((event): event is RetrievalDomainEvent<'retrieval/state-recorded'> => event.type === 'retrieval/state-recorded')
  const state = states.at(-1)?.data.state
  const querySummary = state?.query.original
    ?? (contract?.type === 'retrieval/query-contracted' ? contract.data.spec.originalQuery : '')
  const status = statusOf(state)
  const message = state?.termination === 'needs_clarification'
    ? state.clarification?.question
    : state === undefined ? undefined : STATUS_MESSAGES[state.termination]
  const result = state?.phase === 'stopped' ? createTicketResultCollection(state) : undefined
  const candidates = result?.tickets ?? state?.candidates ?? []
  return {
    retrievalId,
    version: state?.revision ?? 0,
    querySummary,
    ...(state?.snapshot === undefined ? {} : { snapshotShortId: state.snapshot.shortId }),
    completeness: state?.lastPage?.completeness ?? 'pending',
    status,
    candidates,
    alreadyReadEvidence: result?.evidence ?? state?.promotedEvidence ?? [],
    ...(message === undefined ? {} : { message }),
    exportEnabled: state?.snapshot?.capabilities.exportRead === true
      && candidates.length > 0
      && !['snapshot_invalid', 'permission_blocked', 'error'].includes(status),
    ...(result === undefined ? {} : { result }),
  }
}
