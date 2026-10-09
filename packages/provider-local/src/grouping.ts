import type { NumericFeatureRowGroup } from '@retrieval-agent/contracts'
import { sha256, stableJson } from './hash.js'

export const GROUP_PROJECTION = 'business-and-canonical-nfkc-whitespace-v1' as const
export interface TicketGroupingSource {
  readonly tenantId?: unknown; readonly title?: unknown; readonly summary?: unknown
  readonly rawSource?: { readonly datasetId?: unknown; readonly payload?: Readonly<Record<string, unknown>> }
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
// Match Python Unicode \s (White_Space plus the four information separators).
const spaces = /[\p{White_Space}\u001c-\u001f]+/gu
const trimSource = (value: string) => value.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, '')
function canonicalPart(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.normalize('NFKC').replace(spaces, ' ').replace(/^ +| +$/gu, '')
  return result || undefined
}
function businessIdentity(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined
  return typeof value === 'string' ? trimSource(value) || undefined : undefined
}
/** Local group metadata; record IDs, versions and missing values never invent groups. */
export function ticketGroupHashes(record: TicketGroupingSource): NumericFeatureRowGroup {
  const payload = record.rawSource?.payload
  const title = canonicalPart(payload && own(payload, 'large_model_title') ? payload.large_model_title : record.title)
  const abstract = canonicalPart(payload && own(payload, 'large_model_abstract') ? payload.large_model_abstract : record.summary)
  const identity = payload && own(payload, 'group_id') ? businessIdentity(payload.group_id)
    : payload && own(payload, 'ticket_id') ? businessIdentity(payload.ticket_id) : undefined
  const tenant = typeof record.tenantId === 'string' ? trimSource(record.tenantId) : ''
  const source = typeof record.rawSource?.datasetId === 'string' ? trimSource(record.rawSource.datasetId) : ''
  return { group_projection: GROUP_PROJECTION,
    ...(identity && tenant && source ? { business_hash: sha256(stableJson({ business: identity, projection: GROUP_PROJECTION, source, tenant })) } : {}),
    ...(title && abstract ? { canonical_hash: sha256(stableJson({ abstract, projection: GROUP_PROJECTION, title })) } : {}) }
}
