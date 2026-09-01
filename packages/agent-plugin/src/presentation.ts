import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { appendRetrievalPresentationAnchor } from '@retrieval-agent/dsh-compat'

export interface RetrievalPresentationApplication {
  currentOrUndefined(agent: Agent): RetrievalState | undefined
}

function anchorStoppedResult(agent: Agent, application: RetrievalPresentationApplication, turn: number): void {
  const state = application.currentOrUndefined(agent)
  if (state?.phase !== 'stopped') return
  appendRetrievalPresentationAnchor(agent.session, { retrievalId: state.retrievalId, phase: 'result', turn })
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
    anchorStoppedResult(agent, application, turn)
  })

  // A wall-clock deadline cancels the active turn before turn-stopping runs.
  // Publish the same idempotent terminal anchor when that driver becomes idle.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const boundary = agent.session.events.findLast(event => event.type === 'turn/start')
    if (boundary?.type === 'turn/start') anchorStoppedResult(agent, application, boundary.data.turn)
  })
}
