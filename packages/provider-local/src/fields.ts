import type {
  NormalizedTicketRecord,
  TicketEvidenceField,
  TicketFieldDescriptor,
} from '@retrieval-agent/contracts'
import { estimateTokens } from './text.js'

export const LEGACY_FIELD_CATALOG: readonly TicketFieldDescriptor[] = [
  { key: 'displayId', label: '工单编号', valueKind: 'keyword', accessLevel: 'L0', filterOperators: ['eq', 'neq'], sensitivity: 'non_sensitive' },
  ...['type', 'category', 'priority', 'status', 'language', 'region', 'product', 'component'].map(key => ({
    key, label: key, valueKind: 'keyword' as const, accessLevel: 'L0' as const,
    filterOperators: ['eq', 'neq'] as const, sensitivity: 'non_sensitive' as const,
  })),
  ...['createdAt', 'updatedAt', 'resolvedAt'].map(key => ({
    key, label: key, valueKind: 'datetime' as const, accessLevel: 'L0' as const,
    filterOperators: ['gte', 'lte'] as const, sensitivity: 'non_sensitive' as const,
  })),
  { key: 'errorCodes', label: 'errorCodes', valueKind: 'string_list', accessLevel: 'L0', filterOperators: ['contains'], sensitivity: 'non_sensitive' },
  ...['problemDescription', 'conversationOrUpdates', 'resolutionSteps', 'rootCause', 'answer'].map(key => ({
    key, label: key, valueKind: 'text' as const, accessLevel: 'L2' as const,
    filterOperators: [] as const, sensitivity: 'source_controlled' as const,
  })),
  { key: 'summary', label: '摘要', valueKind: 'text', accessLevel: 'L1', filterOperators: [], sensitivity: 'source_controlled' },
  { key: 'source.raw_dialogue', label: '完整对话（按说话人和顺序）', valueKind: 'text', accessLevel: 'L3', filterOperators: [], sensitivity: 'source_controlled' },
]

export function evidenceFieldValues(record: NormalizedTicketRecord, field: TicketEvidenceField): readonly string[] {
  switch (field) {
    case 'source.raw_dialogue': {
      const turns = record.rawSource?.payload.raw_dialogue
      return Array.isArray(turns) ? turns.flatMap(turn => typeof turn === 'object' && turn !== null
        && typeof turn.text === 'string' ? [JSON.stringify({ speaker: typeof turn.speaker === 'string' ? turn.speaker : 'unknown', text: turn.text })] : []) : []
    }
    case 'summary': return [record.summary]
    case 'problemDescription': return record.problemDescription === undefined ? [] : [record.problemDescription]
    case 'conversationOrUpdates': return record.conversationOrUpdates
    case 'resolutionSteps': return record.resolutionSteps
    case 'rootCause': return record.rootCause === undefined ? [] : [record.rootCause]
    case 'answer': return record.answer === undefined ? [] : [record.answer]
    default: return record.additionalEvidence?.[field] ?? []
  }
}

export function evidenceTextCost(record: NormalizedTicketRecord, fields: readonly TicketEvidenceField[]): number {
  return fields.reduce((total, field) => total + evidenceFieldValues(record, field).reduce((sum, value) => sum + estimateTokens(value), 0), 0)
}
