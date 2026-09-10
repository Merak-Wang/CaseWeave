import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { requestManifest } from './request-manifest.js'
import { contextCompactions, contextCompressionStats, inputContextTokens, installContextRecovery, requestTokens } from './context-recovery.js'
export { contextCompressionStats } from './context-recovery.js'

export interface RetrievalRuntimeBudgetApplication {
  modelContextTokenLimit?(agent: Agent): number | undefined
  projectContext?(agent: Agent, tokenBudget?: number): Promise<{ rendered: string }>
  updateExpert?(agent: Agent, generation: number, update: import('@retrieval-agent/domain').ExpertUpdate): Promise<RetrievalState>
  readonly coordinator?: { isExpert(agent: Agent): boolean }
  currentOrUndefined(agent: Agent): RetrievalState | undefined
  admitModelRequest(agent: Agent, input: {
    readonly estimatedInputTokens: number
    readonly serializationBytes: number
    readonly wallClockElapsedMs: number
    readonly modelContextWindow?: number
    readonly outputReservedTokens?: number
    readonly protocolMarginTokens?: number
    readonly compactionCount?: number
    readonly compression?: import('@retrieval-agent/contracts').ContextCompressionStats
  }): Promise<{ readonly accepted: boolean }>
  recordModelResponse(agent: Agent, input: {
    readonly modelLatencyMs: number
    readonly outputTokens: number
    readonly inputTokens?: number
    readonly wallClockElapsedMs: number
  }): Promise<RetrievalState>
  recordToolCall(agent: Agent, input: { readonly success: boolean; readonly serializationBytes: number; readonly failureSignature?: string }): Promise<RetrievalState>
}

function elapsedSince(state: RetrievalState): number {
  const clock = state.executionClock
  const waiting = clock?.waitingSince === undefined ? 0 : Date.now() - Date.parse(clock.waitingSince)
  return Math.max(0, Date.now() - Date.parse(state.createdAt) - (clock?.totalWaitingMs ?? 0) - waiting)
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/** Parameter order and measurement state IDs are not progress; changed arguments/evidence are. */
export function toolFailureSignature(name: string, args: unknown, message: string, state: RetrievalState): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'state_id').sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : value
  return createHash('sha256').update(JSON.stringify({ name, args: canonical(args), message, generation: state.inputGeneration ?? 0,
    evidence: state.promotedEvidence.map(e => e.evidenceId), candidates: state.candidates.map(c => c.ref),
    judgments: state.judgments, conflicts: state.expertConflicts })).digest('hex')
}

function rejectedStream(): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function isOrdinaryConversationRequest(options: GenerateOptions): boolean {
  // `isAgentLoopRequest()` is backed by a module-private WeakSet. A linked
  // out-of-tree plugin and the DSH host can load distinct physical copies of
  // dsh-llm, making the host's marker invisible here. `purpose` is the public,
  // structural discriminator: loop conversation requests leave it unset,
  // while compaction and session-title requests must set it.
  return options.purpose === undefined
}

/** Meter the exact public model/tool boundaries without changing the DSH loop. */
export function installRetrievalRuntimeBudget(
  ctx: Context,
  application: RetrievalRuntimeBudgetApplication,
): void {
  if (application.projectContext) installContextRecovery(ctx, {
    owns: agent => Boolean(application.currentOrUndefined(agent)) && !application.coordinator?.isExpert(agent),
    limit: agent => application.modelContextTokenLimit?.(agent), render: async (agent, budget) => (await application.projectContext!(agent, budget)).rendered,
  })
  const pendingToolMetrics = new WeakMap<Agent, Promise<void>>()
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (!isOrdinaryConversationRequest(options) || options.sessionId === undefined) return next()
    const agent = ctx.agents.get(options.sessionId)
    if (agent && application.coordinator?.isExpert(agent)) return next()
    const initial = agent === undefined ? undefined : application.currentOrUndefined(agent)
    if (agent === undefined || initial === undefined) return next()

    return (async function* (): AsyncIterable<StreamChunk> {
      // rc.2 tools/result is a synchronous observation event. Join its persistent commit before the next model dispatch.
      await pendingToolMetrics.get(agent)
      if (application.currentOrUndefined(agent)?.phase === 'stopped') { yield* rejectedStream(); return }
      const modelContextWindow = agent.session.requestContext()?.contextWindow
      const outputReservedTokens = options.maxTokens ?? Math.min(2048, Math.floor((modelContextWindow ?? 32000) * 0.15))
      const protocolMarginTokens = Math.min(512, Math.floor((modelContextWindow ?? 32000) * 0.05))
      const estimatedInputTokens = requestTokens(ctx, options)
      await application.updateExpert?.(agent, initial.inputGeneration ?? 0, { kind: 'manifest', manifest: requestManifest(initial, options, 'main', estimatedInputTokens) })
      const admission = await application.admitModelRequest(agent, {
        estimatedInputTokens,
        compactionCount: contextCompactions(agent),
        compression: contextCompressionStats(agent),
        outputReservedTokens, protocolMarginTokens,
        serializationBytes: serializedBytes({ system: options.system, tools: options.tools, messages: options.messages }),
        wallClockElapsedMs: elapsedSince(initial),
        ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
      })
      if (!admission.accepted) {
        yield* rejectedStream()
        return
      }

      const startedAt = Date.now()
      let outputTokens = 0
      let inputTokens: number | undefined
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') { outputTokens = chunk.usage.outputTokens; inputTokens = inputContextTokens(chunk.usage) }
          yield chunk
        }
      } finally {
        await application.recordModelResponse(agent, {
          modelLatencyMs: Date.now() - startedAt,
          outputTokens,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          wallClockElapsedMs: elapsedSince(initial),
        })
      }
    })()
  }, { global: true })

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || !exec.name.startsWith('ticket_')) return
    if (application.coordinator?.isExpert(exec.agent)) return
    if (!result.isError) return
    const agent = exec.agent
    const record = () => {
      const state = application.currentOrUndefined(agent)
      return application.recordToolCall(agent, { success: false, serializationBytes: serializedBytes(result.content),
        ...(state ? { failureSignature: toolFailureSignature(exec.name, exec.arguments, result.error.message, state) } : {}) })
    }
    const previous = pendingToolMetrics.get(agent)
    const work = (previous ? previous.then(record) : record()).then(() => {}, error => { ctx.logger.warn('retrieval tool metric failed', error) })
    pendingToolMetrics.set(agent, work)
    void work.finally(() => { if (pendingToolMetrics.get(agent) === work) pendingToolMetrics.delete(agent) })
  }, { global: true })
}
