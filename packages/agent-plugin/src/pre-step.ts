import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  EvidenceContextSelection,
  RetrievalState,
  TicketRetrievalRequest,
} from '@retrieval-agent/contracts'
import { buildFastTicketRequest } from '@retrieval-agent/query-understanding'
import type { TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'

const PLUGIN_NAME = 'retrieval-agent'
const SNAPSHOT_SECTION = 'retrieval-agent:state'

export interface AutomaticRetrievalApplication {
  currentOrUndefined(agent: Agent): RetrievalState | undefined
  start(agent: Agent, request: TicketRetrievalRequest, signal?: AbortSignal): Promise<RetrievalState>
  projectContext(agent: Agent): EvidenceContextSelection
}

export interface AutomaticRetrievalStartConfig {
  readonly analyzer: TicketQueryAnalyzer
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

/** 保留 direct-user 原文；请求装配最多派生 NFKC 检索视图，首轮向量通道仍使用这里返回的完整文本。 */
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
 * DSH 会把已准入但消息为空的第一步视为无需 LLM 的已完成轮次。
 * 因此这里主动持久化已经准入的消息，避免走公开快路径时从 Session 表面丢失用户 query 或后续持久上下文。
 */
function persistCompletedPreStep(agent: Agent, messages: readonly UserMessage[]): void {
  for (const message of messages) {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
}

/** 在第一次模型请求前用已接受的 direct-user 输入启动检索，并把持久化状态快照追加到同一次请求。 */
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

    // 在首次模型请求之前完成 spaCy 分析和固定 Hybrid 计划，模型只能在看到首轮知识状态后决定是否修复查询。
    const request = await buildFastTicketRequest(query, {
      analyzer: config.analyzer,
      signal,
    })
    const state = await application.start(agent, request, signal)
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
