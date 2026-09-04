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
  state_id: { type: 'string', required: true },
  judgments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    candidate_alias: { type: 'string', required: true }, verdict: { type: 'string', required: true, enum: ['accept', 'exclude', 'undetermined'] },
    evidence_aliases: { ...STRINGS, required: true }, reason: { type: 'string', required: true },
  } } },
  semantic_gaps: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, enum: ['coverage', 'constraint', 'depth', 'boundary', 'ambiguity', 'conflict', 'version_or_prior'] },
    status: { type: 'string', required: true, enum: ['open', 'resolved', 'not_applicable', 'unknown'] },
    evidence_aliases: { ...STRINGS, required: true }, description: { type: 'string', required: true },
  } } },
  action: { oneOf: [
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'search', required: true },
      continue_ranking: { type: 'boolean', const: true, required: true, description: 'Fetch the next Provider page of the unchanged current query. Use alone, only when nextPageAvailable is true.' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'search', required: true }, mode: { type: 'string', enum: ['keyword', 'dense'] },
      changes: { type: 'array', items: CHANGE, required: true, description: 'Apply a nonempty atomic set of keyword or structured-filter changes. Do not combine with query or continue_ranking.' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'search', required: true },
      query: { type: 'string', required: true, description: 'A new semantic expression for vector search. Do not combine with changes or continue_ranking.' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'inspect', required: true }, next_window: { type: 'boolean', const: true, required: true },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'inspect', required: true },
      candidate_aliases: { ...STRINGS, required: true }, fields: { ...STRINGS, required: true }, token_budget: { type: 'integer' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'clarify', required: true }, question: { type: 'string', required: true },
      candidate_aliases: { ...STRINGS, required: true }, evidence_aliases: { ...STRINGS, required: true },
      facet: { type: 'string' }, options: STRINGS,
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'finish', required: true }, reason: { type: 'string', required: true, enum: ['satisfied', 'no_result', 'incomplete'] },
      explanation: { type: 'string', required: true },
    } },
  ], required: true },
} as const
export type DecisionArguments = InferValue<{ type: 'object'; additionalProperties: false; properties: typeof DECISION_PARAMETERS }>

function activeRef(state: RetrievalState, alias: string) {
  const ref = candidateRefForAlias(state, alias)
  if (ref === undefined || !state.candidates.some(candidate => candidate.ref === ref)) {
    throw new RetrievalError('CANDIDATE_NOT_FOUND', `候选 ${alias} 不在当前有效集合中。`)
  }
  return ref
}
function evidenceRefs(state: RetrievalState, aliases: readonly string[]): string[] {
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
    }; break
    case 'clarify': next = { kind: 'clarify', question: action.question,
      candidateRefs: action.candidate_aliases.map(alias => activeRef(state, alias)), evidenceRefs: evidenceRefs(state, action.evidence_aliases),
      ...(action.facet === undefined ? {} : { facet: action.facet }), ...(action.options === undefined ? {} : { options: action.options }),
    }; break
    case 'finish': next = action; break
  }
  return { stateId: RetrievalStateId(args.state_id),
    judgments: args.judgments.map(judgment => ({ candidateRef: activeRef(state, judgment.candidate_alias),
      verdict: judgment.verdict, evidenceRefs: evidenceRefs(state, judgment.evidence_aliases), reason: judgment.reason })),
    gaps: args.semantic_gaps.map(gap => ({ kind: gap.kind, status: gap.status, evaluator: 'model',
      evidenceRefs: evidenceRefs(state, gap.evidence_aliases), description: gap.description })), action: next,
  }
}
