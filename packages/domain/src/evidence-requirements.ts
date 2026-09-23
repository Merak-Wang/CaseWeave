import { isReadableTicketField, RetrievalError, type SemanticQueryPlan, type RetrievalState, type TicketCandidate } from '@retrieval-agent/contracts'

/** 只向规划提供可读取的原文字段，避免把摘要当成来源证据。 */
export function sourceEvidenceFields(catalog: NonNullable<RetrievalState['snapshot']>['fieldCatalog'] = []) {
  return catalog.filter(field => ['L2', 'L3'].includes(field.accessLevel) && isReadableTicketField(field)
    && field.capability?.availability !== 'unavailable'
    && (!field.capability || field.capability.origin === 'source'))
}

export function operatorRequiredFields(plan: SemanticQueryPlan | undefined, catalog: NonNullable<RetrievalState['snapshot']>['fieldCatalog'] = []): string[] {
  return [...new Set((plan?.steps ?? []).filter(s => s.op === 'sem_filter').flatMap(s => {
    const fields = s.params.required_fields
    if (fields !== undefined && (!Array.isArray(fields) || fields.some(f => typeof f !== 'string' || !f.trim()))) {
      throw new RetrievalError('INVALID_REQUEST', '原文读取要求必须使用字段名列表。')
    }
    // 显式字段原样保留；旧计划只声明原文时，按当前目录选实际可读的来源字段。
    const readable = sourceEvidenceFields(catalog)
    const source = ['source.raw_dialogue', 'conversationOrUpdates', 'problemDescription'].find(key =>
      readable.some(f => f.key === key && f.capability?.availability === 'available'))
      // 旧目录没有可用性标记时仍先读对话，不能由字段排序选到空的处理结果。
      ?? readable.find(f => f.key === 'conversationOrUpdates')?.key
      ?? readable[0]?.key ?? 'conversationOrUpdates'
    return fields as string[] | undefined ?? (s.params.require_source === true ? [source] : [])
  }))]
}

export function requiredEvidenceFields(state: RetrievalState, candidate: TicketCandidate, planFields = operatorRequiredFields(state.query.contract?.semanticPlan, state.snapshot?.fieldCatalog)): string[] {
  return [...new Set([...planFields,
    ...(candidate.summaryOrigin?.verification === 'conflicting' ? candidate.summaryOrigin.requiredEvidenceFields ?? [] : [])])]
}
