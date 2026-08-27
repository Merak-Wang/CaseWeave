import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TicketCandidateRef } from '@retrieval-agent/contracts'
import {
  EXPORT_CANDIDATES_ENDPOINT,
  type ExportCandidatesErrorResponse,
  type ExportCandidatesResponse,
} from '@retrieval-agent/product-api/protocol'
import { CandidatePanel, type CandidatePanelInjected } from './CandidatePanel.js'
import { ticketCandidateDefinition } from './definition.js'

export const inject = ['conversationEvents', 'slots']

async function exportCandidates(sessionId: string, retrievalId: string, refs: readonly TicketCandidateRef[]): Promise<void> {
  const response = await fetch(EXPORT_CANDIDATES_ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, retrievalId, candidateRefs: refs }),
  })
  const payload = await response.json() as ExportCandidatesResponse | ExportCandidatesErrorResponse
  if (!response.ok || !('contentUtf8' in payload)) {
    const message = 'message' in payload ? payload.message : `导出请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  const blob = new Blob([payload.contentUtf8], { type: payload.mediaType })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = payload.fileName
    anchor.rel = 'noopener'
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Register the durable candidate Definition and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(ticketCandidateDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'ticket-candidates',
    inject: (): CandidatePanelInjected => ({
      exportCandidates,
    }),
  }, CandidatePanel))
}
