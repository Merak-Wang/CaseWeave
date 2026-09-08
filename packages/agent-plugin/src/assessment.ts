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
  state_id: { type: 'string', required: true, description: 'Copy the complete current knowledgeState.stateId exactly, including its revision suffix. A task ID or a shortened state ID is invalid.' },
  judgments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    candidate_alias: { type: 'string', required: true }, verdict: { type: 'string', required: true, enum: ['accept', 'exclude', 'undetermined'] },
    evidence_aliases: { ...STRINGS, required: true, description: 'Nonempty for every judgment, including exclude/undetermined. Cite this ticket\'s received cN overview or eN source spans. For candidate_alias c2, ["c2"] is an overview citation; ["c1"] belongs to another ticket and is invalid.' }, reason: { type: 'string', required: true },
    adopted_finding_id: { type: 'string', description: 'Optional: adopt this exact finding\'s verdict for the same candidate, citing only its listed evidenceAliases. When making your own judgment or adding your own evidence, omit this field and cite evidence the main Agent received.' },
    conflict_resolution: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true, enum: ['fact', 'business_scope', 'knowledge_conflict', 'coverage', 'source_conflict'] },
      reason: { type: 'string', required: true }, evidence_aliases: { ...STRINGS, required: true },
    } },
  } } },
  semantic_gaps: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, enum: ['coverage', 'constraint', 'depth', 'boundary', 'ambiguity', 'conflict', 'version_or_prior'] },
    status: { type: 'string', required: true, enum: ['open', 'resolved', 'not_applicable', 'unknown'] },
    evidence_aliases: { ...STRINGS, required: true }, description: { type: 'string', required: true },
  } } },
  action: { oneOf: [
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'delegate', required: true }, assignments: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: { domain_id: { type: 'string', required: true },
          goal: { type: 'string', required: true }, scope: { type: 'string', required: true },
          candidate_aliases: { ...STRINGS, required: true }, knowledge_ids: { ...STRINGS, description: 'Optional: omit to retrieve domain knowledge automatically. If present use up to 3 exact entryIds from this domain only.' } },
      } },
    } },
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
      kind: { type: 'string', const: 'inspect', required: true }, next_window: { type: 'boolean', const: true, required: true, description: 'Use alone: {kind:"inspect",next_window:true}. Moves the context window over already retrieved evidence or candidate summaries; never combine with candidate_aliases, fields, level or position.' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'inspect', required: true },
      candidate_aliases: { ...STRINGS, required: true }, fields: { ...STRINGS, required: true, description: 'Use exact evidenceState.inspectFields names, not queryPlan search field names. A source read needs an open depth gap citing these cN aliases; history=true, fields=[] reopens an overview. Omit next_window for this source-read form. To continue a long field, copy its returned continuation into position.' }, token_budget: { type: 'integer' },
      history: { type: 'boolean' }, level: { type: 'string', enum: ['L2', 'L3'] },
      position: { type: 'object', additionalProperties: false, properties: { candidate_alias: { type: 'string', required: true },
        field: { type: 'string', required: true }, part: { type: 'integer', required: true }, start: { type: 'integer', required: true } } },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'clarify', required: true }, question: { type: 'string', required: true },
      candidate_aliases: { ...STRINGS, required: true }, evidence_aliases: { ...STRINGS, required: true },
      facet: { type: 'string' }, options: STRINGS,
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'finish', required: true }, reason: { type: 'string', required: true, enum: ['satisfied', 'no_result', 'incomplete'] },
      explanation: { type: 'string', required: true },
      coverage: { type: 'object', additionalProperties: false, description: 'Required after the knowledge catalog is loaded, including an empty catalog. Remaining means unresolved requirements affecting this answer. Explicitly review any failed or unresolved expert scope with evidence.', properties: {
        checked: { ...STRINGS, required: true }, remaining: { ...STRINGS, required: true },
        nextAction: { type: 'string', required: true }, nextActionValue: { type: 'string', required: true, enum: ['useful', 'low', 'none'] },
        expertReviews: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          taskId: { type: 'string', required: true }, reason: { type: 'string', required: true }, evidenceRefs: { ...STRINGS, required: true, description: 'Main-visible cN/eN aliases supporting the scope review.' },
        } } },
      } },
    } },
  ], required: true },
} as const
export type DecisionArguments = InferValue<{ type: 'object'; additionalProperties: false; properties: typeof DECISION_PARAMETERS }>

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
      ...(judgment.adopted_finding_id ? { adoptedFindingId: judgment.adopted_finding_id } : {}),
      ...(judgment.conflict_resolution ? { conflictResolution: { kind: judgment.conflict_resolution.kind,
        reason: judgment.conflict_resolution.reason, evidenceRefs: evidenceRefs(state, judgment.conflict_resolution.evidence_aliases) } } : {}) })),
    gaps: args.semantic_gaps.map(gap => ({ kind: gap.kind, status: gap.status, evaluator: 'model',
      evidenceRefs: evidenceRefs(state, gap.evidence_aliases), description: gap.description })), action: next,
  }
}
