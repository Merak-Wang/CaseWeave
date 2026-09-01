import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isAgentLoopRequest, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { RetrievalState } from '@retrieval-agent/contracts'

export interface RetrievalRuntimeBudgetApplication {
  currentOrUndefined(agent: Agent): RetrievalState | undefined
  admitModelRequest(agent: Agent, input: {
    readonly estimatedInputTokens: number
    readonly serializationBytes: number
    readonly wallClockElapsedMs: number
  }): Promise<{ readonly accepted: boolean; readonly remainingWallClockMs: number }>
  recordModelResponse(agent: Agent, input: {
    readonly modelLatencyMs: number
    readonly outputTokens: number
    readonly wallClockElapsedMs: number
  }): Promise<RetrievalState>
  recordToolCall(agent: Agent, input: { readonly success: boolean; readonly serializationBytes: number }): Promise<RetrievalState>
  stopForWallClockBudget(agent: Agent): Promise<RetrievalState>
}

function elapsedSince(state: RetrievalState): number {
  return Math.max(0, Date.now() - Date.parse(state.createdAt))
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

function rejectedStream(): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** Meter the exact public model/tool boundaries without changing the DSH loop. */
export function installRetrievalRuntimeBudget(
  ctx: Context,
  application: RetrievalRuntimeBudgetApplication,
): void {
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next()
    const agent = ctx.agents.get(options.sessionId)
    const initial = agent === undefined ? undefined : application.currentOrUndefined(agent)
    if (agent === undefined || initial === undefined || initial.phase === 'stopped') return next()

    return (async function* (): AsyncIterable<StreamChunk> {
      const admission = await application.admitModelRequest(agent, {
        estimatedInputTokens: ctx.tokenMeter.measure(agent.session).totalTokens,
        serializationBytes: serializedBytes({ system: options.system, tools: options.tools, messages: options.messages }),
        wallClockElapsedMs: elapsedSince(initial),
      })
      if (!admission.accepted) {
        yield* rejectedStream()
        return
      }

      const startedAt = Date.now()
      let outputTokens = 0
      const timeout = setTimeout(() => {
        void application.stopForWallClockBudget(agent).then(() => {
          agent.cancel({ kind: 'hook', reason: 'retrieval wall-clock budget exhausted' }, { keepInbox: true })
        }).catch(error => { ctx.logger.warn('retrieval wall-clock stop failed', error) })
      }, Math.max(1, admission.remainingWallClockMs))
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') outputTokens = chunk.usage.outputTokens
          yield chunk
        }
      } finally {
        clearTimeout(timeout)
        await application.recordModelResponse(agent, {
          modelLatencyMs: Date.now() - startedAt,
          outputTokens,
          wallClockElapsedMs: elapsedSince(initial),
        })
      }
    })()
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || !exec.name.startsWith('ticket_')) return
    void application.recordToolCall(exec.agent, {
      success: !result.isError,
      serializationBytes: serializedBytes(result.content),
    }).catch(error => { ctx.logger.warn('retrieval tool metric failed', error) })
  })
}
