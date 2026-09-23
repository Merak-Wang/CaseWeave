import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RetrievalError, RetrievalStateId, type RetrievalDecision, type RetrievalState } from '@retrieval-agent/contracts'
import { DECISION_PARAMETERS, decisionFromArguments, decisionArgumentRepair, activeRef } from './assessment.js'
import { compactTerminalReceipt } from './compact.js'
import { EVIDENCE_REVIEW_POLICY } from './evidence-review-policy.js'

const POLICY = `你负责只读工单检索，首轮搜索已完成。用 ticket_read 补证、ticket_search 补召回、ticket_decide 提交判断、缺口和一个下一动作。使用最新 state_id，串行修改任务。
按用户要求判断充分性；指定数量满足即停，未要求全集时不必逐条审完候选。只为具体缺口继续搜索，未知全局召回本身不算缺口。满足用 satisfied，核实范围内均排除用 no_result，否则说明 incomplete；finish 填 coverage。通过工具提交，不用文字答复替代。`

const OPERATOR_POLICY = `你协调只读工单检索，原句向量搜索与查询规划已完成。完整原句和用户补充决定范围，关键词与改写只用于召回。
用 sem_filter 判断相关性，结果已保存，不逐条重判；缺证用 ticket_read 读取最少字段，随后自动复核。材料未变的未决项不重复判断；needs_selection_coverage 时再次 sem_filter 续补选型样本，复用已有标签和模型；needs_coverage 且 discovery_remaining_records>0 时可继续下一个排序窗口，无需重复补搜。
指定 ID 只核实该工单；指定数量满足即停；未指定数量对关键词 OR 全部命中与语义召回按工单身份去重后的召回并集进行学习筛选。关键词分支完整枚举命中，未进入召回并集的授权工单不参与该次学习预测。抽样初判与命中复核累计最多 128 次独立判断请求，自动重试不重复占用额度，续跑共用额度，不再独立抽验。quality_passed 表示选择集达标；quality_fallback 表示未达原目标，采用训练效果最好的模型预测，选择集查准率至少 60%。两者均可交付模型确认集合，不宣称全局语义查全。
model_unknown 表示不知道：最佳模型选择集查准率低于 60% 或额度内证据不足，只交付已确认工单，以 incomplete 结束；不得用补搜或定向判断绕过额度。使用最新 state_id，串行修改任务。ticket_decide 提交缺口和下一动作，通常 judgments=[]，只自行处置明确专家分歧。finish 填 coverage：满足用 satisfied，核实范围内均排除用 no_result，其余说明 incomplete。故障如实报告；通过工具提交，不用文字答复替代。`

export interface RetrievalToolApplication {
  readonly operators?: import('./semantic-operators.js').SemanticOperators
  readonly coordinator?: { isExpert(agent: Agent): boolean; waitForExperts?(agent: Agent, taskIds: readonly string[], signal?: AbortSignal): Promise<void>;
    settlePending?(agent: Agent, signal?: AbortSignal): Promise<void>; cancelPending?(agent: Agent): void }
  prepareExperts?(agent: Agent, signal?: AbortSignal): Promise<void>
  setCoordinatorWaiting?(agent: Agent, waiting: boolean): Promise<RetrievalState>
  currentOrUndefined(agent: Agent): RetrievalState | undefined
  current(agent: Agent): RetrievalState
  projectContext(agent: Agent): Promise<{ readonly rendered: string }>
  decide(agent: Agent, decision: RetrievalDecision, signal?: AbortSignal): Promise<RetrievalState>
  recordToolCall(agent: Agent, input: { readonly success: boolean; readonly serializationBytes: number; readonly failureSignature?: string }): Promise<RetrievalState>
  stopIncomplete(agent: Agent, reason: string): Promise<RetrievalState>
}
/** One public ToolRuntime submission owns judgment and its next action. */
export function installRetrievalTools(ctx: Context, application: RetrievalToolApplication): void {
  if (application.operators) {
    ctx.tools.register(defineTool({ name: 'sem_search',
      description: '补充召回：keywords 做字面 OR 检索并枚举全部命中，或 expression 做一次向量检索，二选一；命中仍待判断。关键词全集指字面命中，不代表扫描全部授权工单。',
      parameters: { keywords: { type: 'array', items: { type: 'string' } }, expression: { type: 'string' }, reason: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.state }] },
      presentCall: () => ({ card: 'generic', title: '检索补充候选', kind: 'execute' }),
      async execute(args, exec) {
        if (!exec.agent || application.coordinator?.isExpert(exec.agent)) throw new RetrievalError('UNAUTHORIZED', '算子需要主任务。')
        if (Boolean(args.keywords?.length) === Boolean(args.expression?.trim())) throw new RetrievalError('INVALID_REQUEST', '选择关键词列表或一个向量检索表达。')
        await application.operators!.search(exec.agent, args.keywords?.length ? { keywords: args.keywords } : { expression: args.expression! }, exec.signal)
        return { state: (await application.projectContext(exec.agent)).rendered }
      },
    }))
    for (const operation of ['sem_extract', 'sem_agg'] as const) ctx.tools.register(defineTool({ name: operation,
      description: `${operation}：对指定当前候选提取字段或汇总依据。field_map 直接提取已读字段；numeric_fields 由代码计算；evidence_window 选择代表性已确认案例。只生成派生产物，相关性用 sem_filter。`,
      parameters: { candidate_aliases: { type: 'array', items: { type: 'string' }, required: true }, instruction: { type: 'string', required: true },
        output_schema: { type: 'object', additionalProperties: true, properties: {} },
        field_map: { type: 'object', additionalProperties: true, properties: {} },
        numeric_fields: { type: 'array', items: { type: 'string' } },
        evidence_window: { type: 'integer' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { artifact: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.artifact }] },
      presentCall: () => ({ card: 'generic', title: operation, kind: 'execute' }),
      async execute(args, exec) {
        if (!exec.agent || application.coordinator?.isExpert(exec.agent)) throw new RetrievalError('UNAUTHORIZED', '算子需要主任务。')
        const state = application.current(exec.agent), refs = args.candidate_aliases.map(a => activeRef(state, a))
        const params = operation === 'sem_extract' ? { output_schema: args.output_schema, ...(args.field_map ? { field_map: args.field_map } : {}) }
          : { ...(args.numeric_fields ? { numeric_fields: args.numeric_fields } : {}), ...(args.evidence_window ? { evidence_window: args.evidence_window } : {}) }
        const artifact = await application.operators!.operate(exec.agent, operation, refs, args.instruction, params, exec.signal)
        return { artifact: JSON.stringify(artifact) }
      },
    }))
    ctx.tools.register(defineTool({ name: 'sem_filter',
      description: '省略 candidate_aliases：累计最多 128 次抽样请求后用最佳模型预测，选择集查准率低于 60% 则返回不知道及已确认工单；或指定数量任务的下一批判断。传入别名：定向判断。自动重试不重复占用额度；续跑复用额度、标签和模型，不做独立抽验。',
      parameters: { candidate_aliases: { type: 'array', items: { type: 'string' } } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.state }] },
      presentCall: () => ({ card: 'generic', title: '批量复核工单', kind: 'execute' }),
      async execute(args, exec) {
        if (!exec.agent || application.coordinator?.isExpert(exec.agent)) throw new RetrievalError('UNAUTHORIZED', '此算子由主任务调度。')
        const state = application.current(exec.agent)
        await application.operators!.filter(exec.agent, args.candidate_aliases?.map(a => activeRef(state, a)), exec.signal)
        return { state: (await application.projectContext(exec.agent)).rendered }
      },
    }))
  }
  ctx.systemPrompt.section({ name: 'retrieval-agent:evidence-review', order: 56,
    text: context => context.agent?.session.header.origin === 'subagent' ? '' : application.operators ? EVIDENCE_REVIEW_POLICY.replace('直接用本条 cN 作 accept/exclude', '调用 sem_filter 作 accept/exclude') : EVIDENCE_REVIEW_POLICY })
  const completionRepairs = new WeakMap<Agent, { generation: number; attempts: number; reply: string }>()
  const finalizeContent = (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (!result.isError) return undefined
    const state = exec.agent === undefined ? undefined : application.currentOrUndefined(exec.agent)
    const message = result.error.message
    const repair = message.includes('状态版本') ? '使用最新 state_id 和 knowledgeState 重交；本次未保存判断。'
      : message.includes('专家分歧') ? '在 conflict_resolution 填 kind、reason、evidence_aliases，以主 Agent 已读原文 eN 解决分歧；自行裁决时省略 adopted_finding_id。'
        : message.includes('invalid arguments') || message.includes('finish.coverage') ? decisionArgumentRepair(exec.arguments, message)
          : message.includes('semantic_gaps 中 coverage') ? '所需数量/范围已满足时将 coverage 标为 resolved；缺具体事实则补证。未知全局召回本身不是缺口。本次判断未保存。'
            : '修正报错字段或引用；缺证时 ticket_read 后使用返回的 cN/eN。本次判断未保存。'
    return [{ type: 'text' as const, text: JSON.stringify({ type: 'retrieval_tool_error', tool: exec.name,
      code: result.error.info?.code ?? 'TOOL_ERROR', message, state_id: state?.stateId,
      availableTools: ['ticket_read', 'ticket_search', 'ticket_decide', 'ticket_wait', ...(application.operators ? ['sem_filter', 'sem_search'] : [])], repair }) }]
  }
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, tools: assembled.tools.map(tool => {
      if (tool.name !== 'ticket_decide') return tool
      // SystemPrompt can cache this before the first task starts. The workbench
      // initializes a catalog, so advertise its finish requirement from the start.
      const parameters = structuredClone(tool.parameters)
      const properties = parameters.properties as Record<string, unknown> | undefined
      if (application.operators) {
        const judgments = properties?.judgments as { items?: { properties?: Record<string, unknown> } } | undefined
        if (judgments?.items?.properties) delete judgments.items.properties.exclusion_checks
      }
      const action = properties?.action as { oneOf?: { properties?: { kind?: { const?: string } }; required?: string[] }[] } | undefined
      for (const form of action?.oneOf ?? []) if (form.properties?.kind?.const === 'finish') form.required = [...new Set([...(form.required ?? []), 'coverage'])]
      return { ...tool, parameters }
    }) }
  }, { global: true })
  const runAction = async (agent: Agent | undefined, stateId: string, action: RetrievalDecision['action'], signal: AbortSignal) => {
    if (!agent || application.coordinator?.isExpert(agent)) throw new RetrievalError('UNAUTHORIZED', '此工具供主检索 Agent 使用。')
    const current = application.current(agent)
    const gaps = current.gaps.filter(g => g.evaluator === 'model')
    const state = await application.decide(agent, { stateId: RetrievalStateId(stateId), judgments: [], gaps, action }, signal)
    const rendered = state.phase === 'stopped' ? JSON.stringify(compactTerminalReceipt(state)) : (await application.projectContext(agent)).rendered
    await application.recordToolCall(agent, { success: true, serializationBytes: Buffer.byteLength(rendered, 'utf8') })
    completionRepairs.delete(agent)
    return { state: rendered }
  }
  const output = { schema: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', required: true } } },
    render: (_args: unknown, value: { state: string }) => [{ type: 'text' as const, text: value.state }] } as const
  const wait = async (agent: Agent, ids: readonly string[], signal: AbortSignal): Promise<void> => {
    if (!application.coordinator?.waitForExperts || application.coordinator.isExpert(agent)) throw new RetrievalError('INVALID_REQUEST', '当前没有可等待的专家执行器。')
    await application.setCoordinatorWaiting?.(agent, true)
    try { await application.coordinator.waitForExperts(agent, ids, signal) }
    finally { if (!signal.aborted) await application.setCoordinatorWaiting?.(agent, false) }
  }
  ctx.tools.register(defineTool({ name: 'ticket_wait', finalizeContent,
    description: '等待 task_ids 中首个专家返回或失败，随后返回最新共享状态。先完成独立工作；不要重复委派或轮询。',
    parameters: { task_ids: { type: 'array', required: true, items: { type: 'string' } } }, output,
    presentCall: () => ({ card: 'generic', title: '等待所需专家结果', kind: 'execute' }),
    async execute(args, exec) {
      if (!exec.agent) throw new RetrievalError('INVALID_REQUEST', '需要当前 Agent。')
      await wait(exec.agent, args.task_ids, exec.signal)
      completionRepairs.delete(exec.agent)
      const rendered = (await application.projectContext(exec.agent)).rendered
      await application.recordToolCall(exec.agent, { success: true, serializationBytes: Buffer.byteLength(rendered, 'utf8') })
      return { state: rendered }
    },
  }))
  ctx.systemPrompt.section({ name: 'retrieval-agent:collaboration', order: 56, text: context => context.agent?.session.header.origin === 'subagent' ? '' :
    '仅为独立领域缺口委派专家，复用共享证据；等待期间继续独立工作，依赖未完成结果时用 ticket_wait。只在缺少必要且用户独有的信息时提问；已有回答持续有效，按原问题和选项解释，不把举例或地点自动变成筛选条件。补充后只重审受影响判断，旧专家结论不能直接当作当前结论。零结果先核对实际查询、字段和通道错误。' })
  ctx.tools.register(defineTool({ name: 'ticket_read',
    finalizeContent,
    description: '读取指定候选：fields=[] 重载标题/摘要，原文字段取 evidenceState.inspectFields，reason 写具体缺项；或单独 next_window=true 翻页。先保存本批判断再翻页；调用后使用新 state_id。',
    parameters: { state_id: DECISION_PARAMETERS.state_id, candidate_aliases: { type: 'array', items: { type: 'string' } },
      fields: { type: 'array', items: { type: 'string' } }, next_window: { type: 'boolean' }, reason: { type: 'string', required: true },
      position: { type: 'object', additionalProperties: false, properties: { candidate_alias: { type: 'string', required: true },
        field: { type: 'string', required: true }, part: { type: 'integer', required: true }, start: { type: 'integer', required: true } } } }, output,
    presentCall: () => ({ card: 'generic', title: '读取工单依据', kind: 'execute' }),
    async execute(args, exec) {
      if (!exec.agent) throw new RetrievalError('INVALID_REQUEST', '需要当前 Agent。')
      if (args.next_window && (args.candidate_aliases || args.fields || args.position)) throw new RetrievalError('INVALID_REQUEST', 'next_window 不与指定候选、字段或位置合用。')
      if (!args.next_window && !args.candidate_aliases?.length) throw new RetrievalError('INVALID_REQUEST', '请指定 candidate_aliases 或 next_window=true。')
      const state = application.current(exec.agent)
      const result = await runAction(exec.agent, args.state_id, args.next_window ? { kind: 'inspect', nextWindow: true } : {
        kind: 'inspect', candidateRefs: args.candidate_aliases!.map(a => activeRef(state, a)), fields: args.fields ?? [], history: !args.fields?.length,
        ...(args.position ? { position: { candidateRef: activeRef(state, args.position.candidate_alias), field: args.position.field, part: args.position.part, start: args.position.start } } : {}) }, exec.signal)
      if (application.operators && args.candidate_aliases?.length && args.fields?.length && application.current(exec.agent).phase !== 'stopped') {
        await application.operators.filter(exec.agent, args.candidate_aliases.map(a => activeRef(state, a)), exec.signal)
        return { state: (await application.projectContext(exec.agent)).rendered }
      }
      return result
    },
  }))
  ctx.tools.register(defineTool({ name: 'ticket_search',
    finalizeContent,
    description: '补充工单召回：query + mode=keyword 做字面检索，mode=dense 做语义检索；或单独 continue_ranking=true 取下一页。结果待判断，用户条件不变。',
    parameters: { state_id: DECISION_PARAMETERS.state_id, reason: { type: 'string', required: true }, query: { type: 'string' },
      mode: { type: 'string', enum: ['keyword', 'dense'] }, operator: { type: 'string', enum: ['or', 'and'], description: '仅 keyword：默认 or，明确需要交集才用 and。' }, continue_ranking: { type: 'boolean' } }, output,
    presentCall: args => ({ card: 'generic', title: args.query ? `搜索：${args.query}` : '继续检索下一页', kind: 'execute' }),
    async execute(args, exec) {
      if (args.continue_ranking ? args.query !== undefined || args.mode !== undefined || args.operator !== undefined : !args.query?.trim()) throw new RetrievalError('INVALID_REQUEST', '指定 query 和 mode，或单独 continue_ranking=true。')
      if (args.operator && args.mode !== 'keyword') throw new RetrievalError('INVALID_REQUEST', 'operator 只适用于 mode=keyword。')
      return runAction(exec.agent, args.state_id, args.continue_ranking ? { kind: 'search', continueRanking: true } : {
        kind: 'search', mode: args.mode ?? 'dense', delta: args.mode === 'keyword'
          ? { kind: 'batch', changes: [{ kind: 'replace_terms', terms: args.query!.trim().split(/\s+/u), operator: args.operator ?? 'or' }] }
          : { kind: 'rewrite_semantic_query', text: args.query! } }, exec.signal)
    },
  }))
  ctx.systemPrompt.section({ name: 'retrieval-agent:policy', order: 55, text: context => context.agent?.session.header.origin === 'subagent' ? '' : application.operators ? OPERATOR_POLICY : POLICY })
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (application.coordinator?.isExpert(agent)) return
    if (signal.aborted) { application.coordinator?.cancelPending?.(agent); return }
    const state = application.currentOrUndefined(agent)
    if (signal.aborted || state === undefined || state.phase === 'stopped' || state.termination === 'needs_clarification') return
    const pending = state.expertTasks?.filter(t => t.inputGeneration === (state.inputGeneration ?? 0) && ['pending', 'running'].includes(t.status)) ?? []
    if (pending.length && application.coordinator?.waitForExperts) {
      await wait(agent, pending.map(t => t.id), signal)
      const text = `专家已有结果，请复用返回的证据继续核对；其余分支可继续并行。\n${(await application.projectContext(agent)).rendered}`
      agent.inject(createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot', sections: [{ name: 'retrieval-agent:expert-ready', text }] }, content: [{ type: 'text', text }] }))
      return
    }
    const generation = state.inputGeneration ?? 0, previous = completionRepairs.get(agent)
    const last = [...agent.session.snapshotEvents()].reverse().find(e => e.type === 'assistant/message')
    const reply = last?.type === 'assistant/message' ? JSON.stringify(last.data.message.content) : ''
    const attempts = previous?.generation === generation && previous.reply === reply ? previous.attempts : 0
    if (attempts >= 2) { await application.stopIncomplete(agent, '模型连续三次重复相同答复且未提交有效动作，检测到无进展循环；已保存任务与证据，可调整模型后继续。'); return }
    completionRepairs.set(agent, { generation, attempts: attempts + 1, reply })
    const rendered = (await application.projectContext(agent)).rendered
    const text = `文字答复未保存结果。请用工具继续处理缺口，或用 ticket_decide 提交 judgments、semantic_gaps 和 finish；沿用原业务条件。\n${rendered}`
    agent.inject(createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot', sections: [{ name: 'retrieval-agent:completion-repair', text }] }, content: [{ type: 'text', text }] }))
  })
  // Keep the schema available before pre-step admits a reply or starts a task;
  // execution below validates the current Agent and authoritative state.
  ctx.tools.register(defineTool({
    name: 'ticket_decide',
    description: '提交当前证据判断和一个下一动作。cN 引用本条摘要，eN 引用已读原文。按 action 对应格式填写；筛选字段限 filterCapabilities，不放宽用户条件。',
    parameters: DECISION_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.state }],
    },
    presentCall: () => ({ card: 'generic', title: '判断证据并执行下一步', kind: 'execute' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '检索动作未执行' : '检索状态已更新' }),
    finalizeContent,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new RetrievalError('INVALID_REQUEST', 'ticket_decide 需要当前 Agent。')
      const agent = exec.agent
      if (application.coordinator?.isExpert(agent)) throw new RetrievalError('UNAUTHORIZED', '专家只能提交其分配的产物。')
      if (args.action.kind === 'finish' && !application.current(agent).expertTasks?.some(t => t.inputGeneration === (application.current(agent).inputGeneration ?? 0) && ['pending', 'running'].includes(t.status))) {
        await application.coordinator?.settlePending?.(agent, exec.signal)
      }
      const decision = decisionFromArguments(application.current(agent), args)
      if (application.operators && decision.judgments.some(j => !application.current(agent).expertConflicts?.some(
        conflict => conflict.status === 'open' && conflict.candidateRef === j.candidateRef))) {
        throw new RetrievalError('INVALID_REQUEST', '普通候选判断由 sem_filter 提交，不能在 ticket_decide 覆盖算子结论。缺证请 ticket_read 后重新过滤；已有足够确认结果时 judgments=[]，直接提交下一动作。只有当前明确的专家分歧可提交主 Agent 判断。')
      }
      let state = await application.decide(agent, decision, exec.signal)
      if (application.operators && decision.action.kind === 'inspect' && decision.action.fields?.length && decision.action.candidateRefs?.length && state.phase !== 'stopped') {
        state = await application.operators.filter(agent, decision.action.candidateRefs, exec.signal)
      }
      completionRepairs.delete(agent)
      if (args.action.kind === 'delegate') await application.prepareExperts?.(agent, exec.signal)
      const rendered = state.phase === 'stopped' ? JSON.stringify(compactTerminalReceipt(state)) : (await application.projectContext(agent)).rendered
      await application.recordToolCall(agent, { success: true, serializationBytes: Buffer.byteLength(rendered, 'utf8') })
      const current = application.current(agent)
      const text = current.phase === 'stopped' ? JSON.stringify(compactTerminalReceipt(current)) : (await application.projectContext(agent)).rendered
      if (current.phase === 'stopped' || current.termination === 'needs_clarification') exec.concludeTurn()
      return { state: text }
    },
  }))
}
