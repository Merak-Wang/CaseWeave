import { RetrievalError, type SemanticQueryPlan, type RetrievalState, type TicketCandidate } from '@retrieval-agent/contracts'

export function operatorRequiredFields(plan: SemanticQueryPlan | undefined, catalog: NonNullable<RetrievalState['snapshot']>['fieldCatalog'] = []): string[] {
  return [...new Set((plan?.steps ?? []).filter(s => s.op === 'sem_filter').flatMap(s => {
    const fields = s.params.required_fields
    if (fields !== undefined && (!Array.isArray(fields) || fields.some(f => typeof f !== 'string' || !f.trim()))) {
      throw new RetrievalError('INVALID_REQUEST', '原文读取要求必须使用字段名列表。')
    }
    // 显式字段原样保留；旧计划只声明原文时，按当前目录选实际可读的来源字段。
    const source = ['source.raw_dialogue', 'conversationOrUpdates', 'problemDescription'].find(key =>
      catalog.some(f => f.key === key && f.capability?.availability === 'available')) ?? 'conversationOrUpdates'
    return fields as string[] | undefined ?? (s.params.require_source === true ? [source] : [])
  }))]
}

export function requiredEvidenceFields(state: RetrievalState, candidate: TicketCandidate, planFields = operatorRequiredFields(state.query.contract?.semanticPlan, state.snapshot?.fieldCatalog)): string[] {
  return [...new Set([...planFields,
    ...(candidate.summaryOrigin?.verification === 'conflicting' ? candidate.summaryOrigin.requiredEvidenceFields ?? [] : [])])]
}
