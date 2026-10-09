import { RetrievalError, type SemanticQueryPlan } from '@retrieval-agent/contracts'

type Requirement = NonNullable<SemanticQueryPlan['unsupported_constraints']>[number]
const provenance = 'host-explicit-raw-request-v1' as const
// These phrases describe an actual raw source, not a business topic such as
// replacement, cause, response or processing. A bare topic never creates a gate.
const rawSources: readonly { readonly fields: readonly string[]; readonly phrase: RegExp }[] = [
  { fields: ['source.raw_dialogue', 'conversationOrUpdates'],
    phrase: /原始对话|对话原文|原始会话|会话原文|原始聊天记录|聊天原文|原始交互记录/g },
  { fields: ['source.resolution', 'resolutionSteps'],
    phrase: /处理过程原文|原始处理过程|处置过程原文|原始处置记录|解决步骤原文|原始解决步骤/g },
  { fields: ['rootCause'], phrase: /根因原文|原始根因记录/g },
  { fields: ['answer'], phrase: /答复原文|原始答复|答案原文|原始答案/g },
  { fields: ['problemDescription'], phrase: /问题描述原文|原始问题描述|工单原文|原始工单正文/g },
]
const requestVerb = /核对|查看|检查|检索|筛选|判断|查验|验证|对照|读取|逐字|仅|只|必须|需要|要求|基于|根据|依据|限定|限于|包含|提到|显示|记载/
const negatedRequest = /(?:不需要|不要求|不必|不用|无需|无须|不要|不查看|不核对|不依赖|不根据|不基于|不读取)[^，,。；;!?！？\n]{0,18}$/
const lexicalMention = /(?:标题|摘要|关键词)[^，,。；;!?！？\n]{0,18}(?:包含|含有|匹配|搜索|检索)[^，,。；;!?！？\n]{0,8}$/

/** The authoritative text is supplied by task state, never by model output. */
export function canonicalSourceRequirements(userText: string, unavailableFields: readonly string[]): Requirement[] {
  const unavailable = new Set(unavailableFields)
  const result: Requirement[] = []
  for (const sourceText of userText.split(/[，,。；;!?！？\n]/).map(text => text.trim()).filter(Boolean)) {
    for (const family of rawSources) {
      const field = family.fields.find(key => unavailable.has(key))
      if (!field) continue
      // matchAll does not retain the global expression's mutable lastIndex.
      for (const match of sourceText.matchAll(family.phrase)) {
        const before = sourceText.slice(0, match.index)
        if (negatedRequest.test(before)) {
          // Later user feedback can withdraw an earlier explicit raw requirement.
          // Text is ordered as original query, then subsequent user feedback.
          for (let index = result.length - 1; index >= 0; index--) {
            if (family.fields.includes(result[index]!.field)) result.splice(index, 1)
          }
          continue
        }
        if (lexicalMention.test(before)) continue
        const after = sourceText.slice((match.index ?? 0) + match[0].length)
        if (!requestVerb.test(sourceText) && !/^(?:中|里|内|的)/.test(after)) continue
        if (!result.some(item => item.field === field && item.source_text === sourceText)) {
          result.push({ field, source_text: sourceText, provenance })
        }
        break
      }
    }
  }
  return result
}

/** Recheck new and cached plans against the current real user request. */
export function canonicalSourceRequirementsMatch(plan: SemanticQueryPlan, userText: string, unavailableFields: readonly string[]): boolean {
  const expected = canonicalSourceRequirements(userText, unavailableFields)
  const actual = plan.unsupported_constraints ?? []
  const keys = (items: readonly Requirement[]) => items.map(item => [item.field, item.source_text, item.provenance])
  return JSON.stringify(keys(actual)) === JSON.stringify(keys(expected))
    && plan.steps.length === 1 && plan.steps[0]?.op === 'sem_filter'
    && plan.steps.every(step =>
      step.params.require_source === false && Array.isArray(step.params.required_fields) && step.params.required_fields.length === 0)
}

export function assertCanonicalSourceRequirements(plan: SemanticQueryPlan, userText: string, unavailableFields: readonly string[]): void {
  if (!canonicalSourceRequirementsMatch(plan, userText, unavailableFields)) {
    throw new RetrievalError('PROTOCOL_MISMATCH', '固定规划来源约束与当前用户明确要求不一致。')
  }
}
