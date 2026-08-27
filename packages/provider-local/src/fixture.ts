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
