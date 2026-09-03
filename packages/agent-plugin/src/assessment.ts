import type { InferValue } from '@deepseek-ai/dsh-tools'
import {
  RetrievalError,
  type RetrievalGapKind,
  type RetrievalKnowledgeAssessment,
  type RetrievalState,
} from '@retrieval-agent/contracts'
import { candidateRefForAlias } from './compact.js'

const ALIAS_LIST = { type: 'array', items: { type: 'string' } } as const
const SEMANTIC_GAPS = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      kind: {
        type: 'string', required: true,
        enum: ['coverage', 'constraint', 'depth', 'boundary', 'ambiguity', 'conflict', 'version_or_prior'],
      },
      status: { type: 'string', required: true, enum: ['open', 'resolved', 'not_applicable', 'unknown'] },
      evidence_aliases: ALIAS_LIST,
      description: { type: 'string' },
    },
  },
} as const
const COMMON_PROPERTIES = { semantic_gaps: SEMANTIC_GAPS } as const

export const ASSESSMENT_OUTCOME = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: { verdict: { type: 'string', required: true, const: 'finish_current_results' }, ...COMMON_PROPERTIES },
    },
    {
      type: 'object', additionalProperties: false,
      properties: { verdict: { type: 'string', required: true, const: 'needs_clarification' }, ...COMMON_PROPERTIES },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        verdict: { type: 'string', required: true, const: 'continue' },
        ...COMMON_PROPERTIES,
        next: {
          type: 'object', additionalProperties: false, required: true,
          properties: {
            type: {
              type: 'string', required: true,
              enum: ['continue_ranking', 'keyword_search', 'vector_search', 'read_l3_details'],
            },
          },
        },
      },
    },
  ],
} as const

export type AssessmentOutcome = InferValue<typeof ASSESSMENT_OUTCOME>

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

export function assessmentFromOutcome(
  state: RetrievalState,
  outcome: AssessmentOutcome,
): RetrievalKnowledgeAssessment {
  // Candidate membership is owned by the deterministic ranking expression.
  // The model judges query/evidence sufficiency; it never classifies an
  // unbounded alias list that may not fit in its current input window.
  const selected = state.candidates.map(candidate => candidate.ref)
  const gaps = (outcome.semantic_gaps ?? []).map(gap => ({
    kind: gap.kind as RetrievalGapKind,
    status: gap.status,
    evidenceRefs: evidenceRefsForAliases(state, gap.evidence_aliases ?? []),
    evaluator: 'model' as const,
    ...(gap.description === undefined ? {} : { description: gap.description }),
  }))

  if (outcome.verdict === 'finish_current_results') {
    if (state.task.completenessRequirement === 'exhaustive') {
      const exhausted = state.lastPage?.boundary?.resultPagesExhausted
        ?? (state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined)
      const canContinue = state.allowedActions.some(action => action.kind === 'search_next')
      if (!exhausted && canContinue) {
        throw new RetrievalError('INVALID_TRANSITION', '未指定结果数量的检索仍有后续页，不能提前结束。')
      }
      if (state.candidates.length === 0) {
        return {
          decision: 'no_result', evaluator: 'system',
          selectedCandidateRefs: [], excludedCandidateRefs: [],
          gaps: [], nextAction: 'finish_no_result',
        }
      }
      return {
        decision: 'return_partial', evaluator: 'system',
        selectedCandidateRefs: selected, excludedCandidateRefs: [],
        gaps: [], nextAction: 'finish_partial',
      }
    }
    return {
      decision: 'accept_current_top_k', evaluator: 'model',
      selectedCandidateRefs: selected, excludedCandidateRefs: [],
      gaps, nextAction: 'accept_current_top_k',
    }
  }
  if (outcome.verdict === 'needs_clarification') {
    return {
      decision: 'needs_clarification', evaluator: 'model',
      selectedCandidateRefs: selected, excludedCandidateRefs: [],
      gaps, nextAction: 'clarify',
    }
  }
  return {
    decision: 'continue', evaluator: 'model',
    selectedCandidateRefs: selected, excludedCandidateRefs: [],
    gaps, nextAction: outcome.next.type,
  }
}
