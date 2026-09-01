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

const POLICY = `You are a read-only ticket retrieval agent. Harness has already compiled a typed Query Contract, opened one authorized snapshot, and run the fixed first Hybrid search before the first model request. Use stable short aliases such as c1; never invent or copy opaque candidate refs. After each search or evidence read, call ticket_assess_state with one discriminated outcome. Omitted keep_aliases means keep every active candidate not newly excluded. System gaps are read-only; semantic_gaps are model-owned. Provider cursors, authorization, historical selections, exclusions, and stop semantics remain Harness-owned. A sufficient Top-K decision does not mean the source is exhausted. Never produce a natural-language final answer; Harness emits the terminal structured collection.`
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
  ticket_assess_state: { outcome: { verdict: 'sufficient' } },
  ticket_continue_ranking: {},
  ticket_keyword_search: { change: { type: 'add_terms', terms: ['副卡'] } },
  ticket_vector_search: { semantic_hint: '副卡异常' },
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
      properties: { verdict: { type: 'string', required: true, const: 'sufficient' }, ...COMMON_ASSESSMENT_PROPERTIES },
    },
    {
      type: 'object', additionalProperties: false,
      properties: { verdict: { type: 'string', required: true, const: 'no_result' }, exclude_new_aliases: ALIAS_LIST },
    },
    {
      type: 'object', additionalProperties: false,
      properties: { verdict: { type: 'string', required: true, const: 'partial' }, ...COMMON_ASSESSMENT_PROPERTIES },
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
  readonly type: 'add_terms' | 'exclude_terms' | 'add_filter' | 'remove_filter'
  readonly terms?: readonly string[]
  readonly field?: string
  readonly op?: string
  readonly value?: string
}

function keywordDelta(change: KeywordSearchArgs): TicketQueryDelta {
  switch (change.type) {
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
  const newlyExcluded = outcome.verdict === 'no_result'
    ? state.candidates.map(candidate => candidate.ref)
    : aliasesToActiveRefs(state, outcome.exclude_new_aliases ?? [], 'exclude_new_aliases', true)
  const excluded = new Set(newlyExcluded)
  const defaultSelected = state.candidates.map(candidate => candidate.ref).filter(ref => !excluded.has(ref))
  const selected = outcome.verdict === 'no_result'
    ? []
    : outcome.keep_aliases === undefined
      ? defaultSelected
      : aliasesToActiveRefs(state, outcome.keep_aliases, 'keep_aliases').filter(ref => !excluded.has(ref))
  const gaps = outcome.verdict === 'no_result'
    ? []
    : (outcome.semantic_gaps ?? []).map(gap => ({
        kind: gap.kind as RetrievalGapKind,
        status: gap.status,
        evidenceRefs: evidenceRefsForAliases(state, gap.evidence_aliases ?? []),
        evaluator: 'model' as const,
        ...(gap.description === undefined ? {} : { description: gap.description }),
      }))

  switch (outcome.verdict) {
    case 'sufficient': return {
      decision: 'sufficient', coverage: 1, candidateQuality: 1,
      selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded,
      gaps, nextAction: 'finish', stop: true,
    }
    case 'no_result': return {
      decision: 'no_result', coverage: 1, candidateQuality: 1,
      selectedCandidateRefs: [], excludedCandidateRefs: newlyExcluded,
      gaps: [], nextAction: 'finish', stop: true,
    }
    case 'partial': return {
      decision: 'partial', coverage: 0.5, candidateQuality: 0.5,
      selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded,
      gaps, nextAction: 'finish', stop: true,
    }
    case 'needs_clarification': return {
      decision: 'needs_clarification', coverage: 0.5, candidateQuality: 0.5,
      selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded,
      gaps, nextAction: 'clarify', stop: false,
    }
    case 'continue': return {
      decision: 'continue', coverage: 0.5, candidateQuality: 0.6,
      selectedCandidateRefs: selected, excludedCandidateRefs: newlyExcluded,
      gaps, nextAction: outcome.next.type, stop: false,
    }
    default: return outcome satisfies never
  }
}

/**
 * Model-visible tools for the state assembled before a pre-step hook runs.
 * DSH assembles tools before `agent/pre-step`; a missing/stopped state therefore
 * means a direct-user query may establish a fresh retrieval in that same step.
 * Keeping only assessment visible is safe because execute re-reads and validates
 * the post-pre-step state.
 */
export function visibleRetrievalTools(state: RetrievalState | undefined): ReadonlySet<string> {
  if (state === undefined || state.phase === 'stopped') return new Set(['ticket_assess_state'])

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
    description: 'Submit one incremental, idempotent judgment using stable candidate aliases. verdict fixes stop and next-action semantics; Harness owns scores, history, system gaps, opaque refs, and freezing.',
    parameters: {
      outcome: { ...ASSESSMENT_OUTCOME, required: true },
    },
    output: stateOrResultOutput(),
    ...presentation(application, '评估检索知识状态'),
    async execute(args, exec) {
      const agent = agentFor(exec.agent, 'ticket_assess_state')
      const state = await application.assess(agent, assessmentFromOutcome(application.current(agent), args.outcome))
      return terminalToolValue(state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_continue_ranking',
    description: 'Continue the current Provider-issued ranking. Harness owns and validates the hidden cursor, including the initial Hybrid cursor.',
    parameters: {},
    output: stateOrResultOutput(),
    ...presentation(application, '继续当前排名', 'search'),
    async execute(_args, exec) {
      const state = await application.continueRanking(agentFor(exec.agent, 'ticket_continue_ranking'), exec.signal)
      return terminalToolValue(state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_keyword_search',
    description: 'Run one independent lexical repair using exactly one typed change. This tool never accepts a cursor; Provider pagination remains Harness-owned.',
    parameters: {
      change: { ...KEYWORD_CHANGE, required: true },
    },
    output: stateOrResultOutput(),
    ...presentation(application, '关键词检索工单', 'search'),
    async execute(args, exec) {
      const state = await application.search(agentFor(exec.agent, 'ticket_keyword_search'), {
        mode: 'keyword',
        delta: keywordDelta(args.change),
      }, exec.signal)
      return terminalToolValue(state, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_vector_search',
    description: 'Run one independent semantic follow-up repair. This tool always fixes the channel to dense vector search; pagination is Harness-owned.',
    parameters: {
      semantic_hint: { type: 'string', required: true },
    },
    output: stateOrResultOutput(),
    ...presentation(application, '向量检索工单', 'search'),
    async execute(args, exec) {
      const delta: TicketQueryDelta | undefined = args.semantic_hint === undefined
        ? undefined
        : { kind: 'semantic_hint', text: args.semantic_hint }
      const state = await application.search(agentFor(exec.agent, 'ticket_vector_search'), {
        mode: 'dense',
        delta: delta!,
      }, exec.signal)
      return terminalToolValue(state, exec)
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
      return terminalToolValue(state, exec)
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
    execute(args, exec) {
      const agent = agentFor(exec.agent, 'ticket_request_clarification')
      const state = application.requestClarification(
        agent, args.facet, args.question,
        aliasesToActiveRefs(application.current(agent), args.candidate_aliases, 'candidate_aliases'),
      )
      return Promise.resolve(terminalToolValue(state, exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_answer_clarification',
    description: 'Apply or reject the pending clarification. Harness converts an accepted answer to an eq/contains filter for the exact declared facet.',
    parameters: { accepted: { type: 'boolean', required: true }, answer: { type: 'string' } },
    output: stateOrResultOutput(),
    ...presentation(application, '应用澄清答案'),
    execute(args, exec) {
      const state = application.answerClarification(agentFor(exec.agent, 'ticket_answer_clarification'), {
        accepted: args.accepted,
        ...(args.answer === undefined ? {} : { answer: args.answer }),
      })
      return Promise.resolve(terminalToolValue(state, exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ticket_state',
    description: 'Read the replayed state and its currently allowed actions.',
    parameters: {},
    output: stateOutput(),
    ...presentation(application, '读取检索状态', 'read'),
    execute(_args, exec) {
      return Promise.resolve(toolValue(compactRetrievalState(
        application.current(agentFor(exec.agent, 'ticket_state')), true,
      )))
    },
  }))
}
