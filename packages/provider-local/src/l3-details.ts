import {
  MAX_L3_DETAILS_PER_READ,
  RetrievalError,
  type L3DetailsReadRequest,
  type NormalizedTicketRecord,
  type TicketL3DetailsResult,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { canRead } from './authorization.js'

/** Validate and materialize one all-or-nothing L3 batch after snapshot authorization. */
export function l3DetailsResult(
  request: L3DetailsReadRequest,
  recordsByRef: ReadonlyMap<string, NormalizedTicketRecord>,
  principal: TrustedPrincipalContext,
): TicketL3DetailsResult {
  if (request.candidateRefs.length === 0 || request.candidateRefs.length > MAX_L3_DETAILS_PER_READ
    || new Set(request.candidateRefs).size !== request.candidateRefs.length) {
    throw new RetrievalError('INVALID_REQUEST', `L3 批量读取必须包含 1–${MAX_L3_DETAILS_PER_READ} 个不重复候选。`)
  }
  const records = request.candidateRefs.map(candidateRef => ({ candidateRef, record: recordsByRef.get(candidateRef) }))
  if (records.some(({ record }) => record === undefined || !canRead(record, principal))) {
    throw new RetrievalError('UNAUTHORIZED', '批次中存在不可访问的工单原始详情，请重新检索。')
  }
  if (records.some(({ record }) => record?.rawSource === undefined)) {
    throw new RetrievalError('FIELD_NOT_ALLOWED', '批次中存在没有声明 L3 原始来源的工单。')
  }
  return {
    snapshotId: request.snapshotId,
    requestedCandidateRefs: [...request.candidateRefs],
    details: records.map(({ candidateRef, record }) => ({
      candidateRef,
      displayId: record!.displayId,
      sourceVersion: record!.sourceVersion,
      contentHash: record!.contentHash,
      source: {
        datasetId: record!.rawSource!.datasetId,
        datasetVersion: record!.rawSource!.datasetVersion,
        schemaVersion: record!.rawSource!.schemaVersion,
        recordId: record!.rawSource!.recordId,
      },
      rawPayload: structuredClone(record!.rawSource!.payload),
      trust: 'untrusted_ticket_evidence',
    })),
    warnings: [],
  }
}
