import {
  RetrievalError,
  type NormalizedTicketRecord,
  type TicketDisplayField,
  type TicketFieldDescriptor,
} from '@retrieval-agent/contracts'
import { normalizeFixtureTicket, type FixtureTicketInput } from './fixture.js'
import { stableJson } from './hash.js'

export interface PublicSnapshotAccessOverlay {
  readonly tenantId: string
  readonly allowedSubjectIds: readonly string[]
  readonly requiredAttributes: Readonly<Record<string, readonly string[]>>
}

export const DEVELOPMENT_ADMIN_ACCESS: PublicSnapshotAccessOverlay = Object.freeze({
  tenantId: 'demo',
  allowedSubjectIds: [],
  requiredAttributes: { environment: ['development'], role: ['administrator'] },
})

const SOURCE_FIELD_CATALOG: readonly TicketFieldDescriptor[] = Object.freeze([
  { key: 'source.dataset', label: '数据集', valueKind: 'keyword', accessLevel: 'L0', filterOperators: ['eq', 'neq'], sensitivity: 'non_sensitive' },
  { key: 'source.kind', label: '来源类型', valueKind: 'keyword', accessLevel: 'L0', filterOperators: ['eq', 'neq'], sensitivity: 'non_sensitive' },
  { key: 'source.queue', label: '队列', valueKind: 'keyword', accessLevel: 'L0', filterOperators: ['eq', 'neq'], sensitivity: 'source_controlled' },
  { key: 'source.tags', label: '标签', valueKind: 'string_list', accessLevel: 'L0', filterOperators: ['contains'], sensitivity: 'source_controlled' },
  { key: 'source.near_duplicate_group', label: '近重复组', valueKind: 'keyword', accessLevel: 'L0', filterOperators: ['eq', 'neq'], sensitivity: 'source_controlled' },
  { key: 'source.resolution', label: '来源解决方案', valueKind: 'text', accessLevel: 'L2', filterOperators: [], sensitivity: 'source_controlled' },
  { key: 'source.raw', label: '原始载荷', valueKind: 'raw_json', accessLevel: 'L3', filterOperators: [], sensitivity: 'source_controlled' },
])

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetrievalError('INVALID_REQUEST', '来源记录必须是 JSON object。')
  }
  return value as Readonly<Record<string, unknown>>
}

function stringValue(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function stringList(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function searchableStrings(value: unknown, output: string[] = [], depth = 0): string[] {
  if (output.length >= 256 || depth > 5 || value === null) return output
  if (typeof value === 'string') {
    if (value.trim().length > 0) output.push(value)
    return output
  }
  if (typeof value !== 'object') return output
  if (Array.isArray(value)) {
    for (const item of value) searchableStrings(item, output, depth + 1)
    return output
  }
  for (const item of Object.values(value as Readonly<Record<string, unknown>>)) searchableStrings(item, output, depth + 1)
  return output
}

function displayField(key: string, label: string, value: string | undefined, sourcePath: string): TicketDisplayField | undefined {
  return value === undefined ? undefined : { key, label, value, sourcePath }
}

/**
 * Adapt one source-native normalized snapshot row into the small product
 * envelope. Every source key remains in `rawSource.payload`; unknown keys are
 * searchable without becoming shared contract fields.
 */
export function normalizePublicSnapshotTicket(
  input: unknown,
  access: PublicSnapshotAccessOverlay = DEVELOPMENT_ADMIN_ACCESS,
): NormalizedTicketRecord {
  const payload = objectValue(input)
  const ticketId = stringValue(payload, 'ticket_id')
  const sourceDataset = stringValue(payload, 'source_dataset')
  const datasetVersion = stringValue(payload, 'source_version')
  if (ticketId === undefined || sourceDataset === undefined || datasetVersion === undefined) {
    throw new RetrievalError('INVALID_REQUEST', '公开快照记录缺少 ticket_id、source_dataset 或 source_version。')
  }
  const title = stringValue(payload, 'title') ?? stringValue(payload, 'summary')
    ?? stringValue(payload, 'category') ?? stringValue(payload, 'type') ?? ticketId
  const summary = stringValue(payload, 'summary') ?? stringValue(payload, 'title')
    ?? stringValue(payload, 'category') ?? stringValue(payload, 'type') ?? ticketId
  const sourceKind = stringValue(payload, 'source_kind') ?? 'unknown'
  const queue = stringValue(payload, 'queue')
  const nearDuplicateGroup = stringValue(payload, 'near_duplicate_group')
  const resolution = stringValue(payload, 'resolution')
  const createdAt = stringValue(payload, 'created_at')
  const problemDescription = stringValue(payload, 'problem_description')
  const answer = stringValue(payload, 'answer')
  const category = stringValue(payload, 'category')
  const type = stringValue(payload, 'type')
  const priority = stringValue(payload, 'priority')
  const status = stringValue(payload, 'status')
  const language = stringValue(payload, 'language')
  const region = stringValue(payload, 'region')
  const tags = stringList(payload, 'tags')
  const additionalFields = [
    displayField('source.dataset', '数据集', sourceDataset, 'source_dataset'),
    displayField('source.kind', '来源类型', sourceKind, 'source_kind'),
    displayField('source.queue', '队列', queue, 'queue'),
  ].filter((value): value is TicketDisplayField => value !== undefined)
  const rawJson = stableJson(payload)
  const sourceIndex = payload.source_index
  return normalizeFixtureTicket({
    ticketId,
    displayId: ticketId,
    tenantId: access.tenantId,
    allowedSubjectIds: [...access.allowedSubjectIds],
    requiredAttributes: Object.fromEntries(Object.entries(access.requiredAttributes).map(([key, values]) => [key, [...values]])),
    sourceVersion: `${sourceDataset}@${datasetVersion}/normalized-v1`,
    ...(createdAt === undefined ? {} : { createdAt }),
    title,
    summary,
    ...(problemDescription === undefined ? {} : { problemDescription }),
    conversationOrUpdates: [],
    resolutionSteps: resolution === undefined ? [] : [resolution],
    ...(answer === undefined ? {} : { answer }),
    ...(category === undefined ? {} : { category }),
    ...(type === undefined ? {} : { type }),
    ...(priority === undefined ? {} : { priority }),
    ...(status === undefined ? {} : { status }),
    ...(language === undefined ? {} : { language }),
    ...(region === undefined ? {} : { region }),
    errorCodes: [],
    piiRedactionStatus: sourceKind === 'real' ? 'redacted' : 'not_applicable',
    rawSource: {
      datasetId: sourceDataset,
      datasetVersion,
      schemaVersion: 'normalized-v1',
      recordId: sourceIndex === null || sourceIndex === undefined ? ticketId : String(sourceIndex),
      payload,
    },
    searchText: searchableStrings(payload),
    additionalFields,
    filterValues: {
      'source.dataset': sourceDataset,
      'source.kind': sourceKind,
      ...(queue === undefined ? {} : { 'source.queue': queue }),
      ...(tags.length === 0 ? {} : { 'source.tags': tags }),
      ...(nearDuplicateGroup === undefined ? {} : { 'source.near_duplicate_group': nearDuplicateGroup }),
    },
    additionalEvidence: {
      'source.raw': [rawJson],
      ...(resolution === undefined ? {} : { 'source.resolution': [resolution] }),
    },
    fieldCatalog: SOURCE_FIELD_CATALOG,
  })
}

function parseJsonl(
  text: string,
  normalize: (value: unknown) => NormalizedTicketRecord,
  label: string,
): NormalizedTicketRecord[] {
  const result: NormalizedTicketRecord[] = []
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue
    try {
      result.push(normalize(JSON.parse(line) as unknown))
    } catch (error) {
      throw new RetrievalError('INVALID_REQUEST', `${label} JSONL 第 ${index + 1} 行无效。`, { cause: error })
    }
  }
  return result
}

export function parsePublicSnapshotJsonl(
  text: string,
  access: PublicSnapshotAccessOverlay = DEVELOPMENT_ADMIN_ACCESS,
): NormalizedTicketRecord[] {
  return parseJsonl(text, value => normalizePublicSnapshotTicket(value, access), '公开快照')
}

/** Parse either the legacy fixture envelope or a source-native public row. */
export function parseTicketDatasetJsonl(
  text: string,
  access: PublicSnapshotAccessOverlay = DEVELOPMENT_ADMIN_ACCESS,
): NormalizedTicketRecord[] {
  return parseJsonl(text, value => {
    const payload = objectValue(value)
    return 'tenantId' in payload
      ? normalizeFixtureTicket(payload as unknown as FixtureTicketInput)
      : normalizePublicSnapshotTicket(payload, access)
  }, '工单数据')
}
