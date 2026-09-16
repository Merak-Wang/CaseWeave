import { RetrievalError, type SemanticQueryPlan, type RetrievalState, type TicketCandidate } from '@retrieval-agent/contracts'

export function operatorRequiredFields(plan: SemanticQueryPlan | undefined): string[] {
  return [...new Set((plan?.steps ?? []).filter(s => s.op === 'sem_filter').flatMap(s => {
    const fields = s.params.required_fields
    if (fields !== undefined && (!Array.isArray(fields) || fields.some(f => typeof f !== 'string' || !f.trim()))) {
      throw new RetrievalError('INVALID_REQUEST', '原文读取要求必须使用字段名列表。')
    }
    // v1 plans used require_source specifically for original dialogue.
    return fields as string[] | undefined ?? (s.params.require_source === true ? ['conversationOrUpdates'] : [])
  }))]
}

export function requiredEvidenceFields(state: RetrievalState, candidate: TicketCandidate, planFields = operatorRequiredFields(state.query.contract?.semanticPlan)): string[] {
  return [...new Set([...planFields,
    ...(candidate.summaryOrigin?.verification === 'conflicting' ? candidate.summaryOrigin.requiredEvidenceFields ?? [] : [])])]
}
