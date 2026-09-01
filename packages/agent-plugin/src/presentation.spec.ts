import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  RETRIEVAL_PRESENTATION_EVENT_TYPE,
  RetrievalId,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { installDshSessionCompatibility } from '@retrieval-agent/dsh-compat'
import { describe, expect, it } from 'vitest'
import { installRetrievalPresentationAnchors } from './presentation.js'

const SIGNAL = new AbortController().signal

function fakeAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(SIGNAL),
    whenIdle: () => Promise.resolve(),
  }
}

function retrievalState(phase: 'assessed' | 'stopped'): RetrievalState {
  return {
    retrievalId: RetrievalId('retrieval-presentation-hook'),
    phase,
  } as unknown as RetrievalState
}

describe('retrieval presentation anchors', () => {
  it('records candidates after admitted messages and results after the turn drains', async () => {
    installDshSessionCompatibility()
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      let state = retrievalState('assessed')
      installRetrievalPresentationAnchors(ctx, { currentOrUndefined: () => state })
      const session = Session.create(SessionId('presentation-hook-session'))
      const agent = fakeAgent(session)
      const query = createUserMessage({
        content: [{ type: 'text', text: '副卡解绑后流量仍共享' }],
        source: { kind: 'user' },
      })
      const queryEvent = session.append('user/message', query, { surfaceOp: 'append' })

      await agentEvents(ctx, agent).waterfall(
        'agent/request',
        { turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ provider: 'test', model: 'test' }),
      )
      const candidateAnchor = session.events.find(event => event.type === RETRIEVAL_PRESENTATION_EVENT_TYPE)
      expect(candidateAnchor?.seq).toBeGreaterThan(queryEvent.seq)
      expect(candidateAnchor?.data).toMatchObject({ phase: 'candidates', turn: 1, step: 1 })

      const lateToolSurface = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'late tool surface placeholder' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), { surfaceOp: 'append' })
      state = retrievalState('stopped')
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })

      const anchors = session.events.filter(event => event.type === RETRIEVAL_PRESENTATION_EVENT_TYPE)
      expect(anchors).toHaveLength(2)
      expect(anchors[1]?.seq).toBeGreaterThan(lateToolSurface.seq)
      expect(anchors[1]?.data).toMatchObject({ phase: 'result', turn: 1 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('anchors a budget-stopped result when cancellation skips turn-stopping', async () => {
    installDshSessionCompatibility()
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      const state = retrievalState('stopped')
      installRetrievalPresentationAnchors(ctx, { currentOrUndefined: () => state })
      const session = Session.create(SessionId('presentation-cancel-session'))
      const agent = fakeAgent(session)
      session.append('turn/start', { turn: 3 })

      agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })

      expect(session.events.find(event => event.type === RETRIEVAL_PRESENTATION_EVENT_TYPE)?.data)
        .toMatchObject({ phase: 'result', turn: 3, retrievalId: state.retrievalId })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
