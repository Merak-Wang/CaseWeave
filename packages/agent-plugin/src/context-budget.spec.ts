import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  CallId,
  deepFreeze,
  isAgentLoopRequest,
  LlmAdapter,
  markAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { RetrievalState } from '@retrieval-agent/contracts'
import {
  installRetrievalRuntimeBudget,
  type RetrievalRuntimeBudgetApplication,
} from './context-budget.js'

const SIGNAL = new AbortController().signal

class CountingAdapter extends LlmAdapter {
  calls = 0
  constructor(private readonly delayMs = 0) { super() }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs))
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function fixtureAgent(ctx: Context): { readonly agent: Agent; readonly state: RetrievalState; readonly cancel: ReturnType<typeof vi.fn> } {
  const session = Session.create(SessionId('runtime-budget-agent'))
  const direct = createUserMessage({ content: [{ type: 'text', text: '帮我找副卡工单' }], source: { kind: 'user' } })
  session.append('request/header', {
    header: canonicalHeader({ config: { provider: 'mock', model: 'model' }, system: 'retrieval policy' }),
    reason: 'initial',
  })
  session.append('user/message', direct, { surfaceOp: 'append' })
  const state = {
    createdAt: new Date().toISOString(),
    phase: 'assessed',
  } as RetrievalState
  const cancel = vi.fn()
  const agent = {
    id: session.id,
    options: { provider: 'mock', model: 'model' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx,
    send() {}, followup() {}, steer() {}, inject() {}, cancel,
    runMaintenance: task => task(SIGNAL),
    whenIdle: () => Promise.resolve(),
  } satisfies Agent
  return { agent, state, cancel }
}

type RequestMarker = <T extends GenerateOptions>(request: T) => T

async function runtime(
  accepted: boolean,
  remainingWallClockMs = 60_000,
  adapterDelayMs = 0,
  options: {
    readonly markRequest?: RequestMarker
    readonly purpose?: GenerateOptions['purpose']
    readonly contextWindow?: number
  } = {},
) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const adapter = new CountingAdapter(adapterDelayMs)
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent, state, cancel } = fixtureAgent(ctx)
  if (options.contextWindow !== undefined) {
    agent.session.append('request/context', {
      provider: 'mock', model: 'model', contextWindow: options.contextWindow,
    })
  }
  ctx.agents.register(agent)
  const admitModelRequest = vi.fn(async (
    _agent: Agent,
    _input: Parameters<RetrievalRuntimeBudgetApplication['admitModelRequest']>[1],
  ) => ({ accepted, remainingWallClockMs }))
  const recordModelResponse = vi.fn(async (
    _agent: Agent,
    _input: Parameters<RetrievalRuntimeBudgetApplication['recordModelResponse']>[1],
  ) => state)
  const stopForWallClockBudget = vi.fn(async () => state)
  const recordToolCall = vi.fn(async () => state)
  const application: RetrievalRuntimeBudgetApplication = {
    currentOrUndefined: () => state,
    admitModelRequest,
    recordModelResponse,
    recordToolCall,
    stopForWallClockBudget,
  }
  installRetrievalRuntimeBudget(ctx, application)
  const request = (options.markRequest ?? markAgentLoopRequest)(deepFreeze({
    provider: 'mock', model: 'model', messages: [], system: 'retrieval policy',
    sessionId: agent.id, signal: SIGNAL,
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  }))
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
  return { ctx, agent, adapter, request, admitModelRequest, recordModelResponse, recordToolCall, stopForWallClockBudget, cancel, chunks }
}

describe('retrieval runtime budget boundary', () => {
  it('meters the full loop request and persists provider usage around the public stream', async () => {
    const result = await runtime(true, 60_000, 0, { contextWindow: 1_000_000 })
    try {
      expect(result.adapter.calls).toBe(1)
      expect(result.admitModelRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        estimatedInputTokens: expect.any(Number),
        serializationBytes: expect.any(Number),
        modelContextWindow: 1_000_000,
      }))
      expect(result.admitModelRequest.mock.calls[0]?.[1].estimatedInputTokens).toBeGreaterThan(0)
      expect(result.admitModelRequest.mock.calls[0]?.[1].serializationBytes).toBeGreaterThan(0)
      expect(result.recordModelResponse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        outputTokens: 7,
      }))
      expect(result.chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    } finally {
      await result.ctx.fiber.dispose()
    }
  })

  it('does not dispatch the adapter when Harness rejects request admission', async () => {
    const result = await runtime(false)
    try {
      expect(result.adapter.calls).toBe(0)
      expect(result.recordModelResponse).not.toHaveBeenCalled()
      expect(result.chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    } finally {
      await result.ctx.fiber.dispose()
    }
  })

  it('persists a wall-clock stop and cancels an in-flight model request at the admitted deadline', async () => {
    const foreignAgentLoopRequests = new WeakSet<object>()
    const result = await runtime(true, 1, 15, {
      markRequest: request => {
        foreignAgentLoopRequests.add(request)
        return request
      },
    })
    try {
      expect(foreignAgentLoopRequests.has(result.request)).toBe(true)
      expect(isAgentLoopRequest(result.request)).toBe(false)
      expect(result.admitModelRequest).toHaveBeenCalledTimes(1)
      expect(result.stopForWallClockBudget).toHaveBeenCalledTimes(1)
      expect(result.cancel).toHaveBeenCalledWith(
        { kind: 'hook', reason: 'retrieval wall-clock budget exhausted' },
        { keepInbox: true },
      )
    } finally {
      await result.ctx.fiber.dispose()
    }
  })

  it('leaves purpose-tagged auxiliary model requests outside the retrieval wall-clock budget', async () => {
    const result = await runtime(true, 1, 15, { markRequest: request => request, purpose: 'compaction' })
    try {
      expect(result.adapter.calls).toBe(1)
      expect(result.admitModelRequest).not.toHaveBeenCalled()
      expect(result.stopForWallClockBudget).not.toHaveBeenCalled()
      expect(result.cancel).not.toHaveBeenCalled()
    } finally {
      await result.ctx.fiber.dispose()
    }
  })

  it('records a failed ticket tool result separately from successful calls', async () => {
    const result = await runtime(true)
    try {
      await result.ctx.tools.execute({
        signal: SIGNAL, callId: CallId('missing-ticket-tool'), name: 'ticket_missing', arguments: {}, agent: result.agent,
      })
      await Promise.resolve()
      expect(result.recordToolCall).toHaveBeenCalledWith(result.agent, expect.objectContaining({ success: false }))
    } finally {
      await result.ctx.fiber.dispose()
    }
  })
})
