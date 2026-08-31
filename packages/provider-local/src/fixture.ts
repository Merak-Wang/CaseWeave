import {
  RetrievalError,
  TicketId,
  type NormalizedTicketRecord,
} from '@retrieval-agent/contracts'
import { sha256, stableJson } from './hash.js'

export interface FixtureTicketInput extends Omit<NormalizedTicketRecord, 'ticketId' | 'contentHash'> {
  readonly ticketId: string
  readonly contentHash?: string
}
export function normalizeFixtureTicket(input: FixtureTicketInput): NormalizedTicketRecord {
  if (input.title.trim().length === 0 || input.summary.trim().length === 0) {
    throw new RetrievalError('INVALID_REQUEST', 'Fixture 工单必须包含标题和摘要。')
  }
  if (input.tenantId.trim().length === 0 || input.sourceVersion.trim().length === 0) {
    throw new RetrievalError('INVALID_REQUEST', 'Fixture 工单必须包含租户和来源版本。')
  }
  const ticketId = TicketId(input.ticketId)
  const base = {
    ...input,
    ticketId,
    allowedSubjectIds: [...input.allowedSubjectIds],
    requiredAttributes: Object.fromEntries(Object.entries(input.requiredAttributes).map(([key, values]) => [key, [...values]])),
    conversationOrUpdates: [...input.conversationOrUpdates],
    resolutionSteps: [...input.resolutionSteps],
    errorCodes: [...input.errorCodes],
    ...(input.searchText === undefined ? {} : { searchText: [...input.searchText] }),
    ...(input.additionalFields === undefined ? {} : { additionalFields: input.additionalFields.map(field => ({ ...field })) }),
    ...(input.filterValues === undefined ? {} : {
      filterValues: Object.fromEntries(Object.entries(input.filterValues).map(([key, value]) => [key, typeof value === 'string' ? value : [...value]])),
    }),
    ...(input.additionalEvidence === undefined ? {} : {
      additionalEvidence: Object.fromEntries(Object.entries(input.additionalEvidence).map(([key, values]) => [key, [...values]])),
    }),
    ...(input.fieldCatalog === undefined ? {} : { fieldCatalog: input.fieldCatalog.map(field => ({ ...field, filterOperators: [...field.filterOperators] })) }),
    ...(input.rawSource === undefined ? {} : {
      rawSource: { ...input.rawSource, payload: { ...input.rawSource.payload } },
    }),
  }
  const contentHash = input.contentHash ?? sha256(stableJson(base))
  return { ...base, contentHash }
}

export function parseFixtureJsonl(text: string): NormalizedTicketRecord[] {
  const result: NormalizedTicketRecord[] = []
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue
    try {
      result.push(normalizeFixtureTicket(JSON.parse(line) as FixtureTicketInput))
    } catch (error) {
      throw new RetrievalError('INVALID_REQUEST', `Fixture JSONL 第 ${index + 1} 行无效。`, { cause: error })
    }
  }
  return result
}
