/** Nominal string identity used at trust and snapshot boundaries. */
export type BrandedString<Name extends string> = string & { readonly __brand: Name }

function brand<Name extends string>(label: Name, value: string): BrandedString<Name> {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`${label} must be non-empty`)
  if (normalized.length > 512) throw new TypeError(`${label} is too long`)
  return normalized as BrandedString<Name>
}

export type RetrievalId = BrandedString<'RetrievalId'>
export type TicketId = BrandedString<'TicketId'>
export type TicketSnapshotId = BrandedString<'TicketSnapshotId'>
export type TicketCandidateRef = BrandedString<'TicketCandidateRef'>
export type TicketEvidenceId = BrandedString<'TicketEvidenceId'>
export type RetrievalStateId = BrandedString<'RetrievalStateId'>

export const RetrievalId = (value: string): RetrievalId => brand('RetrievalId', value)
export const TicketId = (value: string): TicketId => brand('TicketId', value)
export const TicketSnapshotId = (value: string): TicketSnapshotId => brand('TicketSnapshotId', value)
export const TicketCandidateRef = (value: string): TicketCandidateRef => brand('TicketCandidateRef', value)
export const TicketEvidenceId = (value: string): TicketEvidenceId => brand('TicketEvidenceId', value)
export const RetrievalStateId = (value: string): RetrievalStateId => brand('RetrievalStateId', value)
