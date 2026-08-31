import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  EvidenceContextSelection,
  RetrievalState,
  TicketRetrievalRequest,
} from '@retrieval-agent/contracts'
import { compileDirectTicketQuery } from '@retrieval-agent/query-understanding'

const PLUGIN_NAME = 'retrieval-agent'
const SNAPSHOT_SECTION = 'retrieval-agent:state'

export interface AutomaticRetrievalApplication {
  currentOrUndefined(agent: Agent): RetrievalState | undefined
  start(agent: Agent, request: TicketRetrievalRequest, signal?: AbortSignal): Promise<RetrievalState>
  projectContext(agent: Agent): EvidenceContextSelection
}

export interface AutomaticRetrievalStartConfig {
  readonly adaptiveMaxResults: number
}

function acceptedDirectMessages(
  proposed: readonly UserMessage[],
  accepted: readonly UserMessage[],
): UserMessage[] {
  const acceptedIds = new Set(accepted
    .filter(message => message.source.kind === 'user')
    .map(message => String(message.id)))
  return proposed.filter(message => message.source.kind === 'user' && acceptedIds.has(String(message.id)))
}

/** Preserve direct-user text exactly; normalization belongs to the query compiler. */
function originalQuery(messages: readonly UserMessage[]): string | undefined {
  const messageTexts = messages.map(message => message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n'))
  const query = messageTexts.join('\n\n')
  return query.trim().length === 0 ? undefined : query
}

function insertAfterLastDirectUser(
  messages: readonly UserMessage[],
  context: UserMessage,
): UserMessage[] {
  let lastDirect = -1
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.source.kind === 'user') lastDirect = index
  }
  if (lastDirect < 0) return [...messages, context]
  return [...messages.slice(0, lastDirect + 1), context, ...messages.slice(lastDirect + 1)]
}

/**
 * DSH deliberately treats an admitted empty first step as a completed turn
 * without an LLM request. Persist the already-admitted messages ourselves so
 * that taking that public fast path does not remove the user's query or any
 * downstream durable context from the Session surface.
 */
function persistCompletedPreStep(agent: Agent, messages: readonly UserMessage[]): void {
  for (const message of messages) {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
}

/**
 * Start a new retrieval from accepted direct-user input before the first model
 * request, then append the durable state snapshot to that same request.
 */
export function installAutomaticRetrievalStart(
  ctx: Context,
  application: AutomaticRetrievalApplication,
  config: AutomaticRetrievalStartConfig,
): void {
  ctx.on('agent/pre-step', async (
    { agent, messages: proposed, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const direct = acceptedDirectMessages(proposed, decision.messages)
    const query = originalQuery(direct)
    if (query === undefined) return decision

    const current = application.currentOrUndefined(agent)
    if (current !== undefined && current.phase !== 'stopped') return decision

    const state = await application.start(agent, compileDirectTicketQuery(query, {
      adaptiveMaxResults: config.adaptiveMaxResults,
    }), signal)
    if (signal.aborted) return decision

    const selection = application.projectContext(agent)
    const snapshot = createUserMessage({
      content: [{ type: 'text', text: selection.rendered }],
      source: {
        kind: 'plugin',
        plugin: PLUGIN_NAME,
        form: 'snapshot',
        sections: [{ name: SNAPSHOT_SECTION, text: selection.rendered }],
      },
    })
    const messages = insertAfterLastDirectUser(decision.messages, snapshot)
    if (state.phase === 'stopped') {
      persistCompletedPreStep(agent, messages)
      return { kind: 'enter', messages: [] }
    }
    return {
      kind: 'enter',
      messages,
    }
  }, { prepend: true })
}
