import type { NormalizedTicketRecord, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { sha256, stableJson } from './hash.js'

export function principalBinding(principal: TrustedPrincipalContext): string {
  const attributes = Object.fromEntries(Object.entries(principal.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, [...new Set(values)].sort()]))
  return sha256(stableJson({
    tenantId: principal.tenantId,
    subjectId: principal.subjectId,
    entitlementVersion: principal.entitlementVersion,
    attributes,
  }))
}

/** Authorization is applied before any document crosses into the ranking boundary. */
export function canRead(record: NormalizedTicketRecord, principal: TrustedPrincipalContext): boolean {
  if (record.tenantId !== principal.tenantId) return false
  if (record.piiRedactionStatus === 'unreviewed') return false
  if (record.allowedSubjectIds.length > 0 && !record.allowedSubjectIds.includes(principal.subjectId)) return false
  for (const [attribute, required] of Object.entries(record.requiredAttributes)) {
    const actual = principal.attributes[attribute] ?? []
    if (required.length > 0 && !required.some(value => actual.includes(value))) return false
  }
  return true
}
