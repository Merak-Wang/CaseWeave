import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  defineTool,
  type InferValue,
  type ToolExecution,
  type ToolExecutionResult,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import {
  RetrievalError,
  type RetrievalGapKind,
  type RetrievalKnowledgeAssessment,
  type RetrievalState,
  type TicketCandidateRef,
  type TicketEvidenceField,
  type TicketFilter,
  type TicketQueryDelta,
  type TicketRetrievalMode,
} from '@retrieval-agent/contracts'
import {
  candidateRefForAlias,
  compactRetrievalState,
  compactTerminalReceipt,
} from './compact.js'
import { RETRIEVAL_TOOL_OUTPUT_SCHEMA } from './tool-output-schema.js'
const POLICY = `You are a read-only ticket retrieval agent. Before the first model request, Harness opened one authorized snapshot and ran a zero-rewrite fast search: the keyword channel used the recorded direct-user keyword terms, while the vector channel embedded the exact original query. Use stable aliases such as c1; never invent opaque refs. You may directly continue the hidden Provider cursor, rewrite a later keyword/vector query, promote L2 evidence, clarify, or submit one semantic assessment. Omitted keep_aliases keeps every active candidate not newly excluded. System gaps and boundary facts are read-only. When an adaptive Top-K has more pages and the first batch is useful, use present_current_top_k so the user can inspect it and continue later; accept_current_top_k is terminal and never proves corpus recall. Never produce a natural-language final answer; Harness emits terminal collections.`
const SEARCH_TOOLS = ['ticket_keyword_search', 'ticket_vector_search'] as const
const TOOL_NAMES = new Set([
  ...SEARCH_TOOLS,
  'ticket_assess_state',
  'ticket_continue_ranking',
  'ticket_promote',
  'ticket_request_clarification',
  'ticket_answer_clarification',
  'ticket_state',
])
const REPAIR_EXAMPLES: Readonly<Record<string, unknown>> = {
  ticket_assess_state: { outcome: { verdict: 'accept_current_top_k' } },
  ticket_continue_ranking: {},
  ticket_keyword_search: { change: { type: 'replace_terms', terms: ['副卡', '跨域'], operator: 'and' } },
  ticket_vector_search: { query: '副卡办理后跨省使用异常' },
  ticket_promote: { candidate_aliases: ['c1'], fields: ['problemDescription'], token_budget: 200 },
  ticket_request_clarification: { facet: 'category', question: '请选择工单类别', candidate_aliases: ['c1', 'c2'] },
  ticket_answer_clarification: { accepted: true, answer: '移动业务' },
  ticket_state: {},
}
type ToolValue = InferValue<typeof RETRIEVAL_TOOL_OUTPUT_SCHEMA>
type TicketSearchChannel = Extract<TicketRetrievalMode, 'keyword' | 'dense'>
const ALIAS_LIST = { type: 'array', items: { type: 'string' } } as const
const SEMANTIC_GAPS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string', required: true,
        enum: ['constraint', 'depth', 'boundary', 'ambiguity', 'conflict', 'version_or_prior'],
      },
      status: { type: 'string', required: true, enum: ['open', 'resolved', 'not_applicable', 'unknown'] },
      evidence_aliases: ALIAS_LIST,
      description: { type: 'string' },
    },
  },
} as const
const COMMON_ASSESSMENT_PROPERTIES = {
  keep_aliases: ALIAS_LIST,
  exclude_new_aliases: ALIAS_LIST,
  semantic_gaps: SEMANTIC_GAPS,
} as const
const NEXT_ACTION = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { type: { type: 'string', required: true, const: 'continue_ranking' } } },
    { type: 'object', additionalProperties: false, properties: { type: { type: 'string', required: true, const: 'keyword_search' } } },
    { type: 'object', additionalProperties: false, properties: { type: { type: 'string', required: true, const: 'vector_search' } } },
    { type: 'object', additionalProperties: false, properties: { type: { type: 'string', required: true, const: 'promote' } } },
    { type: 'object', additionalProperties: false, properties: { type: { type: 'string', required: true, const: 'clarify' } } },
  ],
} as const
const ASSESSMENT_OUTCOME = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: { verdict: { type: 'string', required: true, const: 'present_current_top_k' }, ...COMMON_ASSESSMENT_PROPERTIES },
    },
    {
      type: 'object', additionalProperties: false,
      properties: { verdict: { type: 'string', required: true, const: 'accept_current_top_k' }, ...COMMON_ASSESSMENT_PROPERTIES },
    },
    {
      type: 'object', additionalProperties: false,
      properties: { verdict: { type: 'string', required: true, const: 'needs_clarification' }, ...COMMON_ASSESSMENT_PROPERTIES },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        verdict: { type: 'string', required: true, const: 'continue' },
        ...COMMON_ASSESSMENT_PROPERTIES,
        next: { ...NEXT_ACTION, required: true },
      },
    },
  ],
} as const
type AssessmentOutcome = InferValue<typeof ASSESSMENT_OUTCOME>
const KEYWORD_CHANGE = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: {
        type: { type: 'string', required: true, const: 'replace_terms' },
        terms: { ...ALIAS_LIST, required: true },
        operator: { type: 'string', required: true, enum: ['and', 'or'] },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        type: { type: 'string', required: true, const: 'add_terms' },
        terms: { ...ALIAS_LIST, required: true },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        type: { type: 'string', required: true, const: 'exclude_terms' },
        terms: { ...ALIAS_LIST, required: true },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        type: { type: 'string', required: true, const: 'add_filter' },
        field: { type: 'string', required: true },
        op: { type: 'string', required: true, enum: ['eq', 'neq', 'contains', 'gte', 'lte'] },
        value: { type: 'string', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        type: { type: 'string', required: true, const: 'remove_filter' },
        field: { type: 'string', required: true },
      },
    },
  ],
} as const
export interface RetrievalToolApplication {
  readonly contextTokenBudget: number
  currentOrUndefined(agent: Agent): RetrievalState | undefined
  current(agent: Agent): RetrievalState
  search(agent: Agent, input: {
    readonly mode: TicketSearchChannel
    readonly delta: TicketQueryDelta
  }, signal?: AbortSignal): Promise<RetrievalState>
  continueRanking(agent: Agent, signal?: AbortSignal): Promise<RetrievalState>
  assess(agent: Agent, assessment: RetrievalKnowledgeAssessment): Promise<RetrievalState>
  promote(agent: Agent, refs: readonly TicketCandidateRef[], fields: readonly TicketEvidenceField[], tokenBudget: number, signal?: AbortSignal): Promise<RetrievalState>
  requestClarification(agent: Agent, facet: string, question: string, refs: readonly TicketCandidateRef[]): RetrievalState
  answerClarification(agent: Agent, input: { readonly accepted: boolean; readonly answer?: string }): RetrievalState
  recordToolCall(agent: Agent, input: { readonly success: boolean; readonly serializationBytes: number }): Promise<RetrievalState>
}
export interface RetrievalToolConfig {
  /** @deprecated Reminders are no longer used as normal control flow. */
  readonly maxFinishReminders?: number
}
function agentFor(agent: Agent | undefined, tool: string): Agent {
  if (agent === undefined) throw new Error(`${tool} requires a calling Agent`)
  return agent
}
function toolValue(value: unknown): ToolValue {
  return JSON.parse(JSON.stringify(value)) as ToolValue
}

function output<const S extends ValueSchemaSpec>(schema: S, compact: (value: unknown) => unknown = value => value) {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text' as const, text: JSON.stringify(compact(value)) }],
  }
}
function stateOutput() {
  return output(RETRIEVAL_TOOL_OUTPUT_SCHEMA)
}
function stateOrResultOutput() {
  return output(RETRIEVAL_TOOL_OUTPUT_SCHEMA)
}
function presentation(
  application: RetrievalToolApplication,
  title: string,
  kind: 'search' | 'read' | 'execute' = 'execute',
) {
  return {
    presentCall: (_args: unknown) => ({ card: 'generic' as const, title, kind }),
    presentResult: (_args: unknown, result: { readonly isError: boolean }) => ({
      card: 'generic' as const,
      title: result.isError ? `${title}失败` : `${title}完成`,
    }),
    finalizeContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) {
      if (!result.isError) return undefined
      const state = exec.agent === undefined ? undefined : application.currentOrUndefined(exec.agent)
      return [{ type: 'text' as const, text: JSON.stringify({
        type: 'retrieval_tool_error',
        tool: exec.name,
        code: result.error.info?.code ?? 'TOOL_ERROR',
        message: result.error.message,
        allowedActions: state?.allowedActions.map(action => action.kind) ?? [],
        repairExample: REPAIR_EXAMPLES[exec.name] ?? {},
      }) }]
    },
  }
}
interface KeywordSearchArgs {
  readonly type: 'replace_terms' | 'add_terms' | 'exclude_terms' | 'add_filter' | 'remove_filter'
  readonly terms?: readonly string[]
  readonly operator?: 'and' | 'or'
  readonly field?: string
  readonly op?: string
  readonly value?: string
}
function keywordDelta(change: KeywordSearchArgs): TicketQueryDelta {
  switch (change.type) {
    case 'replace_terms': return { kind: 'replace_terms', terms: change.terms ?? [], operator: change.operator ?? 'and' }
    case 'add_terms': return { kind: 'add_terms', terms: change.terms ?? [] }
    case 'exclude_terms': return { kind: 'exclude_terms', terms: change.terms ?? [] }
    case 'remove_filter': return { kind: 'remove_filter', field: change.field as TicketFilter['field'] }
    case 'add_filter': return {
      kind: 'add_filter',
      filter: { field: change.field, op: change.op, value: change.value } as TicketFilter,
    }
    default: return change.type satisfies never
  }
}
function terminalToolValue(state: RetrievalState, exec: { concludeTurn(): void }): ToolValue {
  if (state.phase !== 'stopped') return toolValue(compactRetrievalState(state))
  exec.concludeTurn()
  return toolValue(compactTerminalReceipt(state))
}
async function measuredToolValue(
  application: RetrievalToolApplication,
  agent: Agent,
  state: RetrievalState,
  exec: { concludeTurn(): void },
  concludeCurrentTurn = false,
): Promise<ToolValue> {
  const preview = state.phase === 'stopped' ? compactTerminalReceipt(state) : compactRetrievalState(state)
  const measured = await application.recordToolCall(agent, {
    success: true,
    serializationBytes: Buffer.byteLength(JSON.stringify(preview), 'utf8'),
  })
  if (concludeCurrentTurn && measured.phase !== 'stopped') exec.concludeTurn()
  return terminalToolValue(measured, exec)
}
function aliasesToActiveRefs(
  state: RetrievalState,
  aliases: readonly string[],
  label: string,
  idempotentExcluded = false,
): TicketCandidateRef[] {
  const active = new Set(state.candidates.map(candidate => candidate.ref))
  const excluded = new Set(state.excludedCandidateRefs)
  const refs: TicketCandidateRef[] = []
  for (const alias of [...new Set(aliases)]) {
    const ref = candidateRefForAlias(state, alias)
    if (ref === undefined) throw new RetrievalError('CANDIDATE_NOT_FOUND', `${label} 包含未知候选别名 ${alias}；请从 activeAliases 选择。`)
    if (idempotentExcluded && excluded.has(ref)) continue
    if (!active.has(ref)) throw new RetrievalError('CANDIDATE_NOT_FOUND', `${label} 包含非 active 候选别名 ${alias}；请从 activeAliases 选择。`)
    refs.push(ref)
  }
  return refs
}
function evidenceRefsForAliases(state: RetrievalState, aliases: readonly string[]): string[] {
  return [...new Set(aliases)].map((alias) => {
    const candidateRef = candidateRefForAlias(state, alias)
    if (candidateRef !== undefined) return candidateRef
    const match = /^e([1-9]\d*)$/u.exec(alias)
    const evidence = match === null ? undefined : state.promotedEvidence[Number(match[1]) - 1]
    if (evidence === undefined) throw new RetrievalError('INVALID_REQUEST', `semantic_gaps 包含未知证据别名 ${alias}。`)
    return evidence.evidenceId
  })
}
function assessmentFromOutcome(state: RetrievalState, outcome: AssessmentOutcome): RetrievalKnowledgeAssessment {
  const newlyExcluded = aliasesToActiveRefs(state, outcome.exclude_new_aliases ?? [], 'exclude_new_aliases', true)
  const excluded = new Set(newlyExcluded)
  const defaultSelected = state.candidates.map(candidate => candidate.ref).filter(ref => !excluded.has(ref))
  const selected = outcome.keep_aliases === undefined
      ? defaultSelected
      : aliasesToActiveRefs(state, outcome.keep_aliases, 'keep_aliases').filter(ref => !excluded.has(ref))
  const gaps = (outcome.semantic_gaps ?? []).map(gap => ({
        kind: gap.kind as RetrievalGapKind,
        status: gap.status,
        evidenceRefs: evidenceRefsForAliases(state, gap.evidence_aliases ?? []),
        evaluator: 'model' as const,
        ...(gap.description === undefined ? {} : { description: gap.description }),
      }))

  switch (outcome.verdict) {
    case 'present_current_top_k': return {
      decision: 'present_current_top_k', evaluator: 'model',
      selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded,
      gaps, nextAction: 'present_current_top_k',
    }
    case 'accept_current_top_k': return {
      decision: 'accept_current_top_k', evaluator: 'model',
      selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded,
      gaps, nextAction: 'accept_current_top_k',
    }
    case 'needs_clarification': return {
      decision: 'needs_clarification', evaluator: 'model',
      selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded,
      gaps, nextAction: 'clarify',
    }
    case 'continue': return {
      decision: 'continue', evaluator: 'model',
      selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded,
      gaps, nextAction: outcome.next.type,
    }
    default: return outcome satisfies never
  }
}
/**
 * Model-visible tools for the state assembled before a pre-step hook runs.
 * DSH assembles tools before `agent/pre-step`; a missing/stopped state therefore
 * means a direct-user query may establish a fresh retrieval in that same step.
 * The first request therefore exposes the bounded retrieval tool family; every
 * execute path re-reads and validates the post-pre-step state and allowlist.
 */
export function visibleRetrievalTools(state: RetrievalState | undefined): ReadonlySet<string> {
  if (state === undefined || state.phase === 'stopped') return new Set([
    'ticket_assess_state', 'ticket_continue_ranking', 'ticket_keyword_search',
    'ticket_vector_search', 'ticket_promote', 'ticket_request_clarification', 'ticket_state',
  ])

  const allowed = new Set(state.allowedActions.map(action => action.kind))
  const visible = new Set<string>()
  if (allowed.has('assess')) visible.add('ticket_assess_state')
  if (allowed.has('search_next')) visible.add('ticket_continue_ranking')
  if (allowed.has('repair_search')) {
    if (state.lastAssessment?.nextAction === 'keyword_search') visible.add('ticket_keyword_search')
    else if (state.lastAssessment?.nextAction === 'vector_search') visible.add('ticket_vector_search')
    else for (const tool of SEARCH_TOOLS) visible.add(tool)
  }
  if (allowed.has('promote')) visible.add('ticket_promote')
  if (allowed.has('request_clarification')) visible.add('ticket_request_clarification')
  if (allowed.has('answer_clarification')) visible.add('ticket_answer_clarification')
  if (visible.size === 0 || allowed.has('read_state')) visible.add('ticket_state')
  return visible
}
/** Install model policy, state-focused visibility, completion enforcement, and tools. */
export function installRetrievalTools(ctx: Context, application: RetrievalToolApplication, _config: RetrievalToolConfig = {}): void {
  ctx.systemPrompt.section({ name: 'retrieval-agent:policy', order: 55, text: () => POLICY })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (context.agent === undefined) return assembled
    const visible = visibleRetrievalTools(application.currentOrUndefined(context.agent))
    return { ...assembled, tools: assembled.tools.filter(tool => !TOOL_NAMES.has(tool.name) || visible.has(tool.name)) }
  })
  ctx.tools.register(defineTool({
    name: 'ticket_assess_state',
    description: 'Submit a semantic suggestion using stable aliases. No verdict creates a score or proves recall; Harness validates boundary facts and decides whether freezing is legal.',
    parameters: {
      outcome: { ...ASSESSMENT_OUTCOME, required: true },
    },
    output: stateOrResultOutput(),
    ...presentation(application, '评估检索知识状态'),
    async execute(args, exec) {
      const agent = agentFor(exec.agent, 'ticket_assess_state')
      const state = await application.assess(agent, assessmentFromOutcome(application.current(agent), args.outcome))
      return await measuredToolValue(application, agent, state, exec, args.outcome.verdict === 'present_current_top_k')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_continue_ranking',
    description: 'Continue the current Provider-issued ranking. Harness owns and validates the hidden cursor, including the initial Hybrid cursor.',
    parameters: {},
    output: stateOrResultOutput(),
    ...presentation(application, '继续当前排名', 'search'),
    async execute(_args, exec) {
      const agent = agentFor(exec.agent, 'ticket_continue_ranking')
      const state = await application.continueRanking(agent, exec.signal)
      return await measuredToolValue(application, agent, state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_keyword_search',
    description: 'Run one post-fast-path lexical repair. replace_terms is an explicit Agent rewrite and is persisted separately from the immutable initial keyword terms.',
    parameters: {
      change: { ...KEYWORD_CHANGE, required: true },
    },
    output: stateOrResultOutput(),
    ...presentation(application, '关键词检索工单', 'search'),
    async execute(args, exec) {
      const agent = agentFor(exec.agent, 'ticket_keyword_search')
      const state = await application.search(agent, {
        mode: 'keyword',
        delta: keywordDelta(args.change),
      }, exec.signal)
      return await measuredToolValue(application, agent, state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_vector_search',
    description: 'Run one post-fast-path dense search using the Agent-rewritten query. The immutable initial vector query remains the exact direct-user text.',
    parameters: {
      query: { type: 'string', required: true },
    },
    output: stateOrResultOutput(),
    ...presentation(application, '向量检索工单', 'search'),
    async execute(args, exec) {
      const delta: TicketQueryDelta | undefined = args.query === undefined
        ? undefined
        : { kind: 'rewrite_semantic_query', text: args.query }
      const agent = agentFor(exec.agent, 'ticket_vector_search')
      const state = await application.search(agent, {
        mode: 'dense',
        delta: delta!,
      }, exec.signal)
      return await measuredToolValue(application, agent, state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_promote',
    description: 'Read allowlisted L2 fields for stable candidate aliases within the issued budget.',
    parameters: {
      candidate_aliases: { type: 'array', required: true, items: { type: 'string' } },
      fields: { type: 'array', required: true, items: { type: 'string' } },
      token_budget: { type: 'integer', required: true },
    },
    output: stateOrResultOutput(),
    ...presentation(application, '读取工单证据', 'read'),
    async execute(args, exec) {
      const agent = agentFor(exec.agent, 'ticket_promote')
      const state = await application.promote(
        agent,
        aliasesToActiveRefs(application.current(agent), args.candidate_aliases, 'candidate_aliases'),
        args.fields as TicketEvidenceField[], args.token_budget, exec.signal,
      )
      return await measuredToolValue(application, agent, state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_request_clarification',
    description: 'Ask one question based on a provider-declared, real differing L0 facet among current candidates.',
    parameters: {
      facet: { type: 'string', required: true },
      question: { type: 'string', required: true },
      candidate_aliases: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: stateOrResultOutput(),
    ...presentation(application, '请求用户澄清'),
    async execute(args, exec) {
      const agent = agentFor(exec.agent, 'ticket_request_clarification')
      const state = application.requestClarification(
        agent, args.facet, args.question,
        aliasesToActiveRefs(application.current(agent), args.candidate_aliases, 'candidate_aliases'),
      )
      return await measuredToolValue(application, agent, state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_answer_clarification',
    description: 'Apply or reject the pending clarification. Harness converts an accepted answer to an eq/contains filter for the exact declared facet.',
    parameters: { accepted: { type: 'boolean', required: true }, answer: { type: 'string' } },
    output: stateOrResultOutput(),
    ...presentation(application, '应用澄清答案'),
    async execute(args, exec) {
      const agent = agentFor(exec.agent, 'ticket_answer_clarification')
      const state = application.answerClarification(agent, {
        accepted: args.accepted,
        ...(args.answer === undefined ? {} : { answer: args.answer }),
      })
      return await measuredToolValue(application, agent, state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_state',
    description: 'Read the replayed state and its currently allowed actions.',
    parameters: {},
    output: stateOutput(),
    ...presentation(application, '读取检索状态', 'read'),
    async execute(_args, exec) {
      const agent = agentFor(exec.agent, 'ticket_state')
      const state = application.current(agent)
      const preview = compactRetrievalState(state, true)
      await application.recordToolCall(agent, {
        success: true,
        serializationBytes: Buffer.byteLength(JSON.stringify(preview), 'utf8'),
      })
      return toolValue(compactRetrievalState(application.current(agent), true))
    },
  }))
}
