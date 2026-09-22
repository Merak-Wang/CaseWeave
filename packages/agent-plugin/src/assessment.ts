import type { InferValue } from '@deepseek-ai/dsh-tools'
import { RetrievalError, RetrievalStateId, type RetrievalDecision, type RetrievalState, type TicketQueryChange } from '@retrieval-agent/contracts'
import { candidateRefForAlias } from './compact.js'

const STRINGS = { type: 'array', items: { type: 'string' } } as const
const CHANGE = { oneOf: [
  { type: 'object', additionalProperties: false, properties: {
    type: { type: 'string', required: true, const: 'replace_terms' }, terms: { ...STRINGS, required: true },
    operator: { type: 'string', required: true, enum: ['and', 'or'] },
  } },
  { type: 'object', additionalProperties: false, properties: {
    type: { type: 'string', required: true, enum: ['add_terms', 'exclude_terms'] }, terms: { ...STRINGS, required: true },
  } },
  { type: 'object', additionalProperties: false, properties: {
    type: { type: 'string', required: true, const: 'add_filter' }, field: { type: 'string', required: true },
    op: { type: 'string', required: true, enum: ['eq', 'neq', 'contains', 'gte', 'lte'] }, value: { type: 'string', required: true },
  } },
  { type: 'object', additionalProperties: false, properties: {
    type: { type: 'string', required: true, const: 'remove_filter' }, field: { type: 'string', required: true },
  } },
] } as const

export const DECISION_PARAMETERS = {
  state_id: { type: 'string', required: true, description: '原样填写最新 knowledgeState.stateId（含版本）。' },
  judgments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    candidate_alias: { type: 'string', required: true }, verdict: { type: 'string', required: true, enum: ['accept', 'exclude', 'undetermined'] },
    exclusion_checks: { type: 'array', description: 'accept 前逐项核对 semanticExclusions，保留完整条件与或/且、时序；yes/uncertain 不得 accept，无排除项可省略。', items: { type: 'object', additionalProperties: false, properties: {
      requirement_id: { type: 'string', required: true }, source_text: { type: 'string', required: true, description: '原样复制 semanticExclusions 的完整 source_text。' },
      applies: { type: 'string', required: true, enum: ['yes', 'no', 'uncertain'] },
      reason: { type: 'string', required: true, description: '简述实际操作、已完成/待办事项与排除条件的关系；明确后续纠正优先。' },
      evidence_aliases: { ...STRINGS, required: true, description: '引用本条已收到的 cN/eN，证据充分无需重读。' },
    } } },
    evidence_aliases: { ...STRINGS, required: true, description: '必填本条已收到的 cN/eN；例如 c2 可引用 c2，不能用 c1 的摘要。' }, reason: { type: 'string', required: true, description: '简述决定性事实，核对完整排除条件，不复制原文。' },
    adopted_finding_id: { type: 'string', description: '仅直接采用同候选专家结论时填写，并只用该结论的引用；自行判断则省略。' },
    conflict_resolution: { type: 'object', additionalProperties: false, description: '有未解决专家分歧时，accept/exclude 必填；引用主 Agent 已读原文 eN，摘要不够。', properties: {
      kind: { type: 'string', required: true, enum: ['fact', 'business_scope', 'knowledge_conflict', 'coverage', 'source_conflict'] },
      reason: { type: 'string', required: true }, evidence_aliases: { ...STRINGS, required: true },
    } },
  } } },
  semantic_gaps: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, enum: ['coverage', 'constraint', 'depth', 'boundary', 'ambiguity', 'conflict', 'version_or_prior'] },
    status: { type: 'string', required: true, enum: ['open', 'resolved', 'not_applicable', 'unknown'], description: '针对实际用户要求；范围满足则 coverage=resolved，未知全局召回写入说明。' },
    evidence_aliases: { ...STRINGS, required: true }, description: { type: 'string', required: true },
  } } },
  action: { oneOf: [
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'delegate', required: true }, assignments: { type: 'array', required: true, description: '并行委派独立范围，复用共享证据，不重复委派等待中的专家。', items: {
        type: 'object', additionalProperties: false, properties: { domain_id: { type: 'string', required: true },
          goal: { type: 'string', required: true }, scope: { type: 'string', required: true, description: '该专家负责的独立未决问题。' },
          candidate_aliases: { ...STRINGS, required: true }, knowledge_ids: { ...STRINGS, description: '省略则自动选知识；填写时限本领域至多3个真实 entryId。' } },
      } },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'search', required: true },
      continue_ranking: { type: 'boolean', const: true, required: true, description: '仅 nextPageAvailable=true 时单独使用，继续当前查询。' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'search', required: true }, mode: { type: 'string', enum: ['keyword', 'dense'] },
      changes: { type: 'array', items: CHANGE, required: true, description: '非空的关键词/字段变更，不与 query 或 continue_ranking 混用。' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'search', required: true },
      mode: { type: 'string', const: 'dense', description: '语义检索模式。' },
      query: { type: 'string', required: true, description: '新的语义检索表达，不与 changes 或 continue_ranking 混用。' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'inspect', required: true }, next_window: { type: 'boolean', const: true, required: true, description: '单独翻阅已检索候选/证据，不与 candidate_aliases、fields、position 混用。' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'inspect', required: true },
      candidate_aliases: { ...STRINGS, required: true }, fields: { ...STRINGS, required: true, description: '字段取 evidenceState.inspectFields；history=true 且 fields=[] 重载摘要，续读用返回的 position。' }, token_budget: { type: 'integer' },
      history: { type: 'boolean' }, level: { type: 'string', enum: ['L2', 'L3'] },
      position: { type: 'object', additionalProperties: false, properties: { candidate_alias: { type: 'string', required: true },
        field: { type: 'string', required: true }, part: { type: 'integer', required: true }, start: { type: 'integer', required: true } } },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'clarify', required: true }, question: { type: 'string', required: true, description: '仅询问必要且用户独有的缺失信息，复用已有回答。' },
      candidate_aliases: { ...STRINGS, required: true }, evidence_aliases: { ...STRINGS, required: true },
      facet: { type: 'string' }, options: STRINGS,
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'finish', required: true }, reason: { type: 'string', required: true, enum: ['satisfied', 'no_result', 'incomplete'], description: 'satisfied：有确认结果且数量/范围满足；no_result：范围已核实、候选均排除且无缺口；incomplete：仍未完成。' },
      explanation: { type: 'string', required: true, description: '在 action 内简述实际停止原因。' },
      coverage: { type: 'object', additionalProperties: false, description: '知识目录加载后必填。remaining 只写实际缺口；评估下一动作价值，未知全局召回或翻页结束不代表资源耗尽。', properties: {
        checked: { ...STRINGS, required: true }, remaining: { ...STRINGS, required: true },
        nextAction: { type: 'string', required: true }, nextActionValue: { type: 'string', required: true, enum: ['useful', 'low', 'none'] },
        expertReviews: { type: 'array', description: '逐项覆盖 requiredExpertReviews 的 taskId，写明依据和处理结论。', items: { type: 'object', additionalProperties: false, properties: {
          taskId: { type: 'string', required: true }, reason: { type: 'string', required: true }, evidenceRefs: { ...STRINGS, required: true, description: '主 Agent 已收到的 cN/eN。' },
        } } },
      } },
    } },
  ], required: true },
} as const
export type DecisionArguments = InferValue<{ type: 'object'; additionalProperties: false; properties: typeof DECISION_PARAMETERS }>

export function exclusionChecksFromArguments(state: RetrievalState, checks: DecisionArguments['judgments'][number]['exclusion_checks']) {
  return checks === undefined ? {} : { exclusionChecks: checks.map(check => ({ requirementId: check.requirement_id,
    sourceText: check.source_text, applies: check.applies, reason: check.reason, evidenceRefs: evidenceRefs(state, check.evidence_aliases) })) }
}

/** Explain the selected action branch, rather than echoing an unhelpful oneOf failure. */
export function decisionArgumentRepair(input: unknown, message: string): string {
  const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const args = record(input), action = record(args.action)
  const atomic = '本次判断未保存；修正动作后一起重交，已有有效证据无需重读。'
  if (typeof args.action === 'string') return `action 必须为对象 {kind,...}，不要序列化成字符串。 ${atomic}`
  if (/judgments\[|semantic_gaps\[/u.test(message)) return `修正报错字段；conflict_resolution 仅填 kind、reason、evidence_aliases。 ${atomic}`
  if (!action.kind) return `action.kind 必填：delegate、inspect、search、clarify 或 finish。 ${atomic}`
  if (action.kind === 'delegate') {
    const missing = Array.isArray(action.assignments) ? action.assignments.flatMap((v, i) => ['domain_id', 'goal', 'scope', 'candidate_aliases']
      .filter(key => record(v)[key] === undefined).map(key => `action.assignments[${i}].${key}`)) : ['action.assignments']
    return `assignments 每项填写 domain_id、goal、scope、candidate_aliases。 ${missing.length ? `Missing: ${missing.join(', ')}.` : '按声明类型填写。'} knowledge_ids 可省略自动选择，或填本领域真实 ID。 ${atomic}`
  }
  if (action.kind === 'finish') return `finish 填 reason（satisfied/no_result/incomplete）、explanation、coverage（checked/remaining/nextAction/nextActionValue）。nextActionValue 取 low/none/useful；满足且有确认结果才用 satisfied，核实后均排除用 no_result；按 actionState 填 expertReviews。 ${atomic}`
  if (action.kind === 'inspect') return `inspect 二选一：{kind:"inspect",next_window:true} 或 {kind:"inspect",candidate_aliases:["c1"],fields:[]}；空字段读摘要，补证选实际原文字段。 ${atomic}`
  if (action.kind === 'search') return `search 三选一：continue_ranking:true、query 语义表达、changes:[{type:"replace_terms",terms:["词"],operator:"or"}]。 ${atomic}`
  return `按 schema 修正报错字段。 ${atomic}`
}

export function activeRef(state: RetrievalState, alias: string) {
  const ref = candidateRefForAlias(state, alias)
  if (ref === undefined || !state.candidates.some(candidate => candidate.ref === ref)) {
    throw new RetrievalError('CANDIDATE_NOT_FOUND', `候选 ${alias} 不在当前有效集合中。`)
  }
  return ref
}
export function evidenceRefs(state: RetrievalState, aliases: readonly string[]): string[] {
  return aliases.map(alias => {
    if (/^c[1-9]\d*$/u.test(alias)) return activeRef(state, alias)
    const match = /^e([1-9]\d*)$/u.exec(alias)
    const evidence = match === null ? undefined : state.promotedEvidence[Number(match[1]) - 1]
    if (evidence === undefined) throw new RetrievalError('INVALID_REQUEST', `未知证据别名 ${alias}。`)
    return evidence.evidenceId
  })
}
function queryChange(change: InferValue<typeof CHANGE>): TicketQueryChange {
  switch (change.type) {
    case 'replace_terms': return { kind: 'replace_terms', terms: change.terms, operator: change.operator }
    case 'add_terms': case 'exclude_terms': return { kind: change.type, terms: change.terms }
    case 'remove_filter': return { kind: 'remove_filter', field: change.field }
    case 'add_filter': return { kind: 'add_filter', filter: { field: change.field, op: change.op, value: change.value } }
  }
}
export function decisionFromArguments(state: RetrievalState, args: DecisionArguments): RetrievalDecision {
  const action = args.action
  let next: RetrievalDecision['action']
  switch (action.kind) {
    case 'delegate': next = { kind: 'delegate', assignments: action.assignments.map(a => ({ domainId: a.domain_id,
      goal: a.goal, scope: a.scope, candidateRefs: a.candidate_aliases.map(alias => activeRef(state, alias)),
      ...(a.knowledge_ids === undefined ? {} : { knowledgeIds: a.knowledge_ids }) })) }; break
    case 'search': {
      const choices = Number('continue_ranking' in action) + Number('changes' in action) + Number('query' in action)
      if (choices !== 1) throw new RetrievalError('INVALID_REQUEST', 'search 必须且只能指定继续排名、条件/关键词变更或语义查询之一。')
      if ('changes' in action && action.changes.length === 0) throw new RetrievalError('INVALID_REQUEST', 'search changes 不能为空。')
      next = 'continue_ranking' in action ? { kind: 'search', continueRanking: true }
        : 'query' in action ? { kind: 'search', mode: 'dense', delta: { kind: 'rewrite_semantic_query', text: action.query } }
          : { kind: 'search', mode: action.mode ?? 'keyword', delta: { kind: 'batch', changes: action.changes.map(queryChange) } }
      break
    }
    case 'inspect': next = 'next_window' in action ? { kind: 'inspect', nextWindow: true } : { kind: 'inspect',
      candidateRefs: action.candidate_aliases.map(alias => activeRef(state, alias)), fields: action.fields,
      ...(action.token_budget === undefined ? {} : { tokenBudget: action.token_budget }),
      ...(action.history === undefined ? {} : { history: action.history }),
      ...(action.level === undefined ? {} : { level: action.level }),
      ...(action.position === undefined ? {} : { position: { candidateRef: activeRef(state, action.position.candidate_alias),
        field: action.position.field, part: action.position.part, start: action.position.start } }),
    }; break
    case 'clarify': next = { kind: 'clarify', question: action.question,
      candidateRefs: action.candidate_aliases.map(alias => activeRef(state, alias)), evidenceRefs: evidenceRefs(state, action.evidence_aliases),
      ...(action.facet === undefined ? {} : { facet: action.facet }), ...(action.options === undefined ? {} : { options: action.options }),
    }; break
    case 'finish': next = { ...action, ...(action.coverage ? { coverage: { ...action.coverage,
      ...(action.coverage.expertReviews ? { expertReviews: action.coverage.expertReviews.map(r => ({ ...r, evidenceRefs: evidenceRefs(state, r.evidenceRefs) })) } : {}) } } : {}) }; break
  }
  return { stateId: RetrievalStateId(args.state_id),
    judgments: args.judgments.map(judgment => ({ candidateRef: activeRef(state, judgment.candidate_alias),
      verdict: judgment.verdict, evidenceRefs: evidenceRefs(state, judgment.evidence_aliases), reason: judgment.reason,
      ...exclusionChecksFromArguments(state, judgment.exclusion_checks),
      ...(judgment.adopted_finding_id ? { adoptedFindingId: judgment.adopted_finding_id } : {}),
      ...(judgment.conflict_resolution ? { conflictResolution: { kind: judgment.conflict_resolution.kind,
        reason: judgment.conflict_resolution.reason, evidenceRefs: evidenceRefs(state, judgment.conflict_resolution.evidence_aliases) } } : {}) })),
    gaps: args.semantic_gaps.map(gap => ({ kind: gap.kind, status: gap.status, evaluator: 'model',
      evidenceRefs: evidenceRefs(state, gap.evidence_aliases), description: gap.description })), action: next,
  }
}
