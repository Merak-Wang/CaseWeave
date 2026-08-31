import type { TicketCandidateNode } from '@retrieval-agent/contracts'

export interface CandidateNodeLike {
  readonly kind: string
  readonly data?: unknown
}

export interface CandidateNodeStoreLike {
  get(key: string): CandidateNodeLike | undefined
}

/** Select the latest durable candidate projection without reading hidden DOM state. */
export function latestTicketCandidateNode(
  order: readonly string[],
  nodes: CandidateNodeStoreLike,
): TicketCandidateNode | undefined {
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const key = order[index]
    if (key === undefined) continue
    const node = nodes.get(key)
    if (node?.kind === 'ticket-candidates' && node.data !== null && typeof node.data === 'object') {
      return node.data as TicketCandidateNode
    }
  }
  return undefined
}
