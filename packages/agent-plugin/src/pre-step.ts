import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  EvidenceContextSelection,
  RetrievalState,
  TicketRetrievalRequest,
} from '@retrieval-agent/contracts'
import type { RetrievalClarificationAnswer } from '@retrieval-agent/domain'
import { buildFastTicketRequest, compileUserConditions, compileUserResultPolicy } from '@retrieval-agent/query-understanding'
import type { TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'

const PLUGIN_NAME = 'retrieval-agent'
const SNAPSHOT_SECTION = 'retrieval-agent:state'

export interface AutomaticRetrievalApplication {
  readonly coordinator?: { isExpert(agent: Agent): boolean }
  receiveUserInput?(agent: Agent, text: string, operationId: string): Promise<void>
  driveAllowed?(agent: Agent): boolean
  currentOrUndefined(agent: Agent): RetrievalState | undefined
  start(agent: Agent, request: TicketRetrievalRequest, signal?: AbortSignal): Promise<RetrievalState>
  resumeClarification(agent: Agent, answer: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState>
  applyUserFeedback(agent: Agent, answer: RetrievalClarificationAnswer, signal?: AbortSignal): Promise<RetrievalState>
  cancel(agent: Agent): Promise<RetrievalState>
  ensureModelAccess(agent: Agent, signal?: AbortSignal): Promise<RetrievalState | undefined>
  projectContext(agent: Agent): Promise<EvidenceContextSelection>
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

/**
 * 在最后一条 direct-user 输入处切开已准入消息；返回 DSH 时保留原文、快照、下游上下文的顺序。
 */
function splitAfterLastDirectUser(
  messages: readonly UserMessage[],
): { head: UserMessage[]; tail: UserMessage[] } {
  let lastDirect = -1
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.source.kind === 'user') lastDirect = index
  }
  return {
    head: [...messages.slice(0, lastDirect + 1)],
    tail: [...messages.slice(lastDirect + 1)],
  }
}

/**
 * Persist accepted input for immediate display, including turns that need no model.
 * DSH V3 alone admits model-surface messages after its protected system head.
 * This log-only fact never becomes a second model input or a product decision.
 */
function persistAcceptedMessages(agent: Agent, messages: readonly UserMessage[], turn: number): void {
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    if (agent.session.snapshotEvents().some(event => event.type === 'retrieval/input-accepted' && event.data.messageId === message.id)) continue
    agent.session.append('retrieval/input-accepted', { messageId: message.id,
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'), turn })
  }
}

/**
 * 在第一次模型请求前用已接受的 direct-user 输入启动检索，并把持久化状态快照追加到同一次请求。
 * 输入的显示回执在耗时分析前落库；模型消息交给 DSH 在合法步骤内写入。
 */
export function installAutomaticRetrievalStart(
  ctx: Context,
  application: AutomaticRetrievalApplication,
  config: AutomaticRetrievalStartConfig,
): void {
  ctx.on('agent/pre-step', async (
    { agent, messages: proposed, signal, turn },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (application.coordinator?.isExpert(agent)) return decision

    const direct = acceptedDirectMessages(proposed, decision.messages)
    const query = originalQuery(direct)

    if (query !== undefined && application.receiveUserInput) {
      await application.receiveUserInput(agent, query, String(direct.at(-1)!.id))
      persistAcceptedMessages(agent, decision.messages, turn)
      return { kind: 'enter', messages: [] }
    }
    if (application.driveAllowed && !application.driveAllowed(agent)) return { kind: 'reject' }

    const restored = application.currentOrUndefined(agent)?.accessValidation === 'required'
    const authorized = await application.ensureModelAccess(agent, signal)
    // 撤销与暂时不可用维持原边界；快照失效只有在没有新的用户输入时才结束本轮。
    // 有补充时落到下方重启检索，不再把输入吞进一个注定失败的重新授权。
    if (restored === true && authorized !== undefined && authorized.phase === 'stopped'
      && (['permission_blocked', 'backend_error'].includes(authorized.termination)
        || (authorized.termination === 'snapshot_invalid' && query === undefined))) {
      persistAcceptedMessages(agent, decision.messages, turn)
      return { kind: 'enter', messages: [] }
    }
    if (query === undefined) return decision

    // 用户输入先落库再进入 spaCy 分析与首轮 Hybrid 排名；长检索不再把消息藏到失败之后。
    const { head, tail } = splitAfterLastDirectUser(decision.messages)
    persistAcceptedMessages(agent, head, turn)

    const current = application.currentOrUndefined(agent)
    const active = current !== undefined && current.phase !== 'stopped'
    if (active && /^(?:取消|停止|算了|cancel|stop)[。.!！\s]*$/iu.test(query.trim())) {
      await application.cancel(agent)
      persistAcceptedMessages(agent, tail, turn)
      return { kind: 'enter', messages: [] }
    }

    // 在首次模型请求之前完成 spaCy 分析和固定 Hybrid 计划，模型只能在看到首轮知识状态后决定是否修复查询。
    // An explicit new-task marker ends the active task; ordinary free-form replies
    // return to the original state for semantic interpretation by the model.
    const newTask = /^(?:新任务|另一个任务|重新检索|new task)\s*[:：]?/iu.test(query.trim())
    if (active && newTask) await application.cancel(agent)
    const feedback = current !== undefined && !newTask
      && !['permission_blocked', 'snapshot_invalid', 'backend_error'].includes(current.termination)
      ? {
          accepted: true, answer: query,
          ...(() => {
            const conditions = compileUserConditions(query, [], new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)
            const result = compileUserResultPolicy(query)
            return { filters: conditions.filters, requirements: conditions.userRequirements, ambiguities: conditions.ambiguities,
              ...(result?.countPolicy === undefined ? {} : { result: { ...result, countPolicy: result.countPolicy } }),
            }
          })(),
        } : undefined

    // 快照已失效时原查询与已确认条件并入本次补充，同一轮完成重启检索。
    const restartAfterExpiry = async (expired: RetrievalState): Promise<RetrievalState> => {
      const original = expired.query.original.trim()
      const merged = original.length > 0 && `${original}\n\n${query}`.length <= 2_000 ? `${original}\n\n${query}` : query
      return await application.start(agent, await buildFastTicketRequest(merged, {
        analyzer: config.analyzer,
        signal,
        ...(expired.query.confirmedConstraints.length === 0 ? {} : { inheritedFilters: expired.query.confirmedConstraints }),
      }), signal)
    }

    let state: RetrievalState
    if (feedback !== undefined) {
      state = current?.termination === 'needs_clarification'
        ? await application.resumeClarification(agent, feedback, signal)
        : await application.applyUserFeedback(agent, feedback, signal)
      // 反馈路径上的快照失效同样不吞掉输入：用合并查询重启。
      if (state.phase === 'stopped' && state.termination === 'snapshot_invalid') {
        state = await restartAfterExpiry(state)
      }
    } else {
      state = current !== undefined && current.termination === 'snapshot_invalid' && !newTask
        ? await restartAfterExpiry(current)
        : await application.start(agent, await buildFastTicketRequest(query, { analyzer: config.analyzer, signal }), signal)
    }
    if (signal.aborted) return { kind: 'enter', messages: [] }

    if (state.phase === 'stopped' && ['permission_blocked', 'snapshot_invalid', 'backend_error'].includes(state.termination)) {
      persistAcceptedMessages(agent, tail, turn)
      return { kind: 'enter', messages: [] }
    }

    const selection = await application.projectContext(agent)
    const snapshot = createUserMessage({
      content: [{ type: 'text', text: selection.rendered }],
      source: {
        kind: 'plugin',
        plugin: PLUGIN_NAME,
        form: 'snapshot',
        sections: [{ name: SNAPSHOT_SECTION, text: selection.rendered }],
      },
    })
    if (state.phase === 'stopped') {
      persistAcceptedMessages(agent, tail, turn)
      return { kind: 'enter', messages: [] }
    }
    return {
      kind: 'enter',
      messages: [...head, snapshot, ...tail],
    }
  }, { prepend: true })
}
