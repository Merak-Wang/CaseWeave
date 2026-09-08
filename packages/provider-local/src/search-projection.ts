import type { QueryDocument } from '@retrieval-agent/contracts'
import type { NormalizedTicketRecord, TicketFilter, TicketL0 } from '@retrieval-agent/contracts'
import type { RankingDocument } from '@retrieval-agent/retrieval-ranking'

/** Versioned local-provider projection shared by online ranking and the development index builder. */
export function rankingDocuments(records: readonly NormalizedTicketRecord[]): RankingDocument[] {
  return records.map(record => ({
    id: record.ticketId,
    contentHash: record.contentHash,
    title: record.title,
    summary: record.summary,
    body: [
      record.problemDescription,
      ...record.conversationOrUpdates,
      ...record.resolutionSteps,
      record.rootCause,
      record.answer,
      ...record.searchText ?? [],
    ].filter((value): value is string => value !== undefined).join('\n'),
    metadata: [
      record.product, record.component, record.category, record.type, record.region, record.status, record.priority,
      ...record.errorCodes,
      ...record.additionalFields?.map(field => field.value) ?? [],
    ].filter((value): value is string => value !== undefined).join(' '),
  }))
}

export function candidateL0(record: NormalizedTicketRecord): TicketL0 {
  return {
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
    ...(record.type === undefined ? {} : { type: record.type }),
    ...(record.category === undefined ? {} : { category: record.category }),
    ...(record.product === undefined ? {} : { product: record.product }),
    ...(record.component === undefined ? {} : { component: record.component }),
    ...(record.region === undefined ? {} : { region: record.region }),
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.priority === undefined ? {} : { priority: record.priority }),
    ...(record.language === undefined ? {} : { language: record.language }),
    ...(record.additionalFields === undefined ? {} : { additionalFields: record.additionalFields.map(field => ({ ...field })) }),
  }
}

function filterValue(record: NormalizedTicketRecord, field: string): string | readonly string[] | undefined {
  switch (field) {
    case 'displayId': return record.displayId
    case 'type': return record.type
    case 'category': return record.category
    case 'priority': return record.priority
    case 'status': return record.status
    case 'language': return record.language
    case 'region': return record.region
    case 'product': return record.product
    case 'component': return record.component
    case 'createdAt': return record.createdAt
    case 'updatedAt': return record.updatedAt
    case 'resolvedAt': return record.resolvedAt
    case 'errorCodes': return record.errorCodes
    default: return record.filterValues?.[field]
  }
}

export function matchesFilter(record: NormalizedTicketRecord, filter: TicketFilter): boolean {
  const actual = filterValue(record, filter.field)
  if (filter.op === 'contains') return actual !== undefined && typeof actual !== 'string'
    && actual.some(value => value.toLocaleLowerCase() === filter.value.toLocaleLowerCase())
  if (typeof actual !== 'string') return false
  if (filter.op === 'eq') return actual.toLocaleLowerCase() === filter.value.toLocaleLowerCase()
  if (filter.op === 'neq') return actual.toLocaleLowerCase() !== filter.value.toLocaleLowerCase()
  if (['createdAt', 'updatedAt', 'resolvedAt'].includes(filter.field)) {
    const timestamp = Date.parse(actual)
    const boundary = Date.parse(filter.value)
    return Number.isFinite(timestamp) && Number.isFinite(boundary)
      && (filter.op === 'gte' ? timestamp >= boundary : timestamp <= boundary)
  }
  if (filter.op === 'gte') return actual >= filter.value
  if (filter.op === 'lte') return actual <= filter.value
  return false
}

export function matchFragment(text: string, terms: readonly string[]): { text: string; truncated: boolean } | undefined {
  const normalized = text.toLocaleLowerCase()
  const position = terms.map(term => normalized.indexOf(term.toLocaleLowerCase())).filter(index => index >= 0).sort((a, b) => a - b)[0]
  if (position === undefined) return undefined
  const start = Math.max(0, position - 40)
  const end = Math.min(text.length, position + 100)
  return { text: text.slice(start, end), truncated: start > 0 || end < text.length }
}

/** Each source field/value stays separate: even one literal cannot bridge two fields. */
export function queryDocument(record: NormalizedTicketRecord): QueryDocument {
  const rawStrings: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { if (value.length) rawStrings.push(value); return }
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  // Search every authorized normalized-source field; legacy searchText was capped at 256 values.
  if (record.rawSource) visit(record.rawSource.payload)
  const texts: Record<string, readonly string[]> = {
    title: [record.title], summary: [record.summary],
    problemDescription: record.problemDescription === undefined ? [] : [record.problemDescription],
    resolution: [...record.resolutionSteps],
    body: [...new Set([record.problemDescription, ...record.conversationOrUpdates, ...record.resolutionSteps, record.rootCause, record.answer,
      ...record.searchText ?? [], ...rawStrings].filter((s): s is string => s !== undefined))],
  }
  for (const [key, values] of Object.entries(record.additionalEvidence ?? {})) texts[key] = values
  const fields: Record<string, string | readonly string[] | null> = { ...record.filterValues }
  for (const key of ['displayId', 'region', 'status', 'product', 'component', 'type', 'category', 'priority', 'language', 'createdAt', 'updatedAt', 'resolvedAt', 'errorCodes'] as const) {
    fields[key] = record[key] ?? null
  }
  for (const [key, value] of Object.entries(fields)) if (value !== null) texts[`metadata.${key}`] = typeof value === 'string' ? [value] : value
  fields.resolution = record.resolutionSteps.length ? record.resolutionSteps : null
  return { texts, fields }
}
