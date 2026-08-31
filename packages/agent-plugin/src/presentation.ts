import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { appendRetrievalPresentationAnchor } from '@retrieval-agent/dsh-compat'

export interface RetrievalPresentationApplication {
  currentOrUndefined(agent: Agent): RetrievalState | undefined
}

/**
 * Persist conversational placement after DSH has admitted the user messages
 * and after all live tool calls have drained. Retrieval execution remains in
 * pre-step; these events only tell the client where its one evolving node is
 * allowed to appear.
 */
export function installRetrievalPresentationAnchors(
  ctx: Context,
  application: RetrievalPresentationApplication,
): void {
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const config = await next()
    const state = application.currentOrUndefined(agent)
    if (state !== undefined && state.phase !== 'stopped') {
      appendRetrievalPresentationAnchor(agent.session, {
        retrievalId: state.retrievalId,
        phase: 'candidates',
        turn,
        step,
      })
    }
    return config
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = application.currentOrUndefined(agent)
    if (state?.phase !== 'stopped') return
    appendRetrievalPresentationAnchor(agent.session, {
      retrievalId: state.retrievalId,
      phase: 'result',
      turn,
    })
  })
}
