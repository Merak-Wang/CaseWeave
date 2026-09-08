import { createHash } from 'node:crypto'
import { RetrievalError, type RetrievalState, type TicketCandidate, type TicketCandidateNode } from '@retrieval-agent/contracts'
import { confirmedTickets } from '@retrieval-agent/domain/result'

export type CandidateView = 'current' | 'confirmed' | 'history'
export interface CandidateWindow {
  view: CandidateView; version: string; offset: number; total: number; limit: number;
  items: readonly TicketCandidate[];
  readableCandidateRefs: readonly string[];
  judgments: readonly { candidateRef: string; verdict: string; reason: string; evidenceRefs: readonly string[] }[];
  nextCursor?: string;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function candidateWindow(state: RetrievalState, view: CandidateView = 'current', cursor?: string, limit = 30): CandidateWindow {
  if (!['current', 'confirmed', 'history'].includes(view) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RetrievalError('INVALID_REQUEST', '列表范围或页宽无效，页宽应在 1–100 之间。')
  }
  const excluded = new Set(state.excludedCandidateRefs)
  const items = ['permission_blocked', 'snapshot_invalid'].includes(state.termination) ? []
    : view === 'history' ? state.candidateHistory : view === 'confirmed' ? confirmedTickets(state)
      : state.candidates.filter(c => !excluded.has(c.ref))
  // Display-only reads do not invalidate a cursor. New inputs, identities or judgments do.
  const version = digest([state.retrievalId, state.inputGeneration, state.query.confirmedConstraints, view,
    items.map(c => [c.ref, c.sourceVersion, c.contentHash]), state.judgments, state.selectedCandidateRefs])
  let offset = 0
  if (cursor) {
    try {
      if (cursor.length > 512) throw new Error()
      const saved = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (saved.version !== version) throw new RetrievalError('INVALID_TRANSITION', '候选集合已更新，请从第一页重新读取。', { retryable: true })
      if (!Number.isSafeInteger(saved.offset) || saved.offset < 0 || saved.offset >= items.length) throw new Error()
      offset = saved.offset
    } catch (e) { if (e instanceof RetrievalError) throw e; throw new RetrievalError('INVALID_REQUEST', '列表游标无效。') }
  }
  const page = items.slice(offset, offset + limit)
  const refs = new Set(page.map(c => c.ref))
  const current = new Set(state.candidates.map(c => c.ref))
  return { view, version, offset, total: items.length, limit, items: page,
    readableCandidateRefs: page.filter(c => current.has(c.ref)).map(c => c.ref),
    judgments: (state.judgments ?? []).filter(j => refs.has(j.candidateRef)),
    ...(offset + limit < items.length ? { nextCursor: Buffer.from(JSON.stringify({ version, offset: offset + limit })).toString('base64url') } : {}) }
}

/** The task wire value is bounded; full result collections remain server-side authority. */
export function windowedNode(state: RetrievalState, node: TicketCandidateNode): TicketCandidateNode {
  const page = candidateWindow(state)
  const confirmed = candidateWindow(state, 'confirmed')
  const refs = new Set(page.items.map(c => c.ref))
  return { ...node, candidates: page.items, alreadyReadEvidence: [],
    selectedCandidateRefs: node.selectedCandidateRefs?.filter(ref => refs.has(ref)) ?? [],
    collectionWindow: { current: page.total, history: state.candidateHistory.length, confirmed: confirmed.total, version: page.version, limit: page.limit },
    ...(node.result ? { result: { ...node.result, tickets: confirmed.items, judgments: node.result.judgments.filter(j => confirmed.items.some(c => c.ref === j.candidateRef)), evidence: [] } } : {}) }
}
