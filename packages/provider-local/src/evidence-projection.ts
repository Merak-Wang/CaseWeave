import { RetrievalError, isReadableTicketField, assertTrustedPrincipal, TicketEvidenceId,
  type TicketSnapshot, type TrustedPrincipalContext, type NormalizedTicketRecord, type ProviderCallOptions,
  type EvidenceReadRequest, type DetailReadRequest, type TicketEvidenceResult, type TicketDetailResult,
  type TicketDetail, type TicketEvidenceField } from '@retrieval-agent/contracts'
import { canRead, principalBinding } from './authorization.js'
import { evidenceFieldValues } from './fields.js'
import { candidateL0 } from './search-projection.js'
import { sha256, shortOpaque } from './hash.js'
import { estimateTokens, truncateToEstimatedTokens } from './text.js'

/** Stateless projection of a source-validated, bounded record window. Never owns a corpus. */
export interface TicketProjection {
  readonly snapshot: TicketSnapshot
  readonly candidateRefs: ReadonlyMap<string, NormalizedTicketRecord>
  readonly now?: () => Date
}
function authorizeProjection(projection: TicketProjection, principal: TrustedPrincipalContext, snapshotId: TicketSnapshot['snapshotId']) {
  assertTrustedPrincipal(principal, projection.now?.().getTime())
  if (projection.snapshot.snapshotId !== snapshotId || projection.snapshot.principalBindingHash !== principalBinding(principal)) {
    throw new RetrievalError('UNAUTHORIZED', '投影的快照与当前身份不一致。')
  }
  return { ...projection, readableFields: new Set(projection.snapshot.fieldCatalog.filter(isReadableTicketField).map(f => f.key)) }
}
function abortIfNeeded(options?: ProviderCallOptions): void {
  if (options?.signal?.aborted) throw new RetrievalError('CANCELLED', '操作已取消。')
}
export function overviewOrigin(record: NormalizedTicketRecord, field: 'title' | 'summary'): import('@retrieval-agent/contracts').TicketContentOrigin {
  const declared = field === 'title' ? record.titleOrigin : record.summaryOrigin
  if (declared) return declared
  const raw = record.rawSource
  const transform = raw?.payload?.transformation as { source_row_sha256?: string } | undefined
  if (raw?.datasetId === 'deepseek-ai/ESFT' && transform?.source_row_sha256 === 'd7425406886a93fa80892af8c8cb58f721f25df164be608550f057e5b5ef15db') {
    return { kind: field === 'title' ? 'generated' : 'unknown', verification: 'conflicting', requiredEvidenceFields: ['source.raw_dialogue'],
      sourceFields: ['source.raw_dialogue'], description: '上游摘要描述宽带包年，原始对话为手机网络排查；须依据对话核实业务对象，不能凭该摘要确认。' }
  }
  if (record.rawSource?.datasetId === 'deepseek-ai/ESFT') return field === 'title'
    ? { kind: 'generated', sourceFields: ['summary'], description: '由上游摘要首句派生的定位标题。' }
    : { kind: 'unknown', verification: 'unverified', sourceFields: ['summary'], description: '上游提供的摘要，非对话原文，未逐条核实；与对话冲突时以对话取证。' }
  return { kind: 'unknown' }
}
export async function projectEvidence(
    projection: TicketProjection,
    principal: TrustedPrincipalContext,
    request: EvidenceReadRequest,
    options?: ProviderCallOptions,
  ): Promise<TicketEvidenceResult> {
    abortIfNeeded(options)
    const entry = authorizeProjection(projection, principal, request.snapshotId)
    if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget < 1) throw new RetrievalError('INVALID_REQUEST', '证据 token 预算无效。')
    for (const field of request.fields) if (!entry.readableFields.has(field)) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了不允许的证据字段。')
    let remaining = request.tokenBudget
    let tokensUsed = 0
    const position = request.position
    if (position && (!request.candidateRefs.includes(position.candidateRef) || !request.fields.includes(position.field)
      || !Number.isSafeInteger(position.part) || position.part < 0 || !Number.isSafeInteger(position.start) || position.start < 0)) {
      throw new RetrievalError('INVALID_REQUEST', '续读位置不属于本次候选和字段。')
    }
    let reached = position === undefined
    let nextPosition: TicketEvidenceResult['nextPosition']
    const evidence: TicketEvidenceResult['evidence'][number][] = []
    const rejected: typeof request.candidateRefs[number][] = []
    reading: for (const ref of request.candidateRefs) {
      abortIfNeeded(options)
      const record = entry.candidateRefs.get(ref)
      if (record === undefined || !canRead(record, principal)) {
        rejected.push(ref)
        continue
      }
      for (const field of request.fields) {
        for (const [part, value] of evidenceFieldValues(record, field).entries()) {
          if (!reached) {
            if (ref !== position!.candidateRef || field !== position!.field || part !== position!.part) continue
            if (position!.start > value.length) throw new RetrievalError('INVALID_REQUEST', '续读位置超出来源字段。')
            reached = true
          }
          let start = position && ref === position.candidateRef && field === position.field && part === position.part ? position.start : 0
          while (start < value.length) {
          if (remaining <= 0) { nextPosition = { candidateRef: ref, field, part, start }; break reading }
          const selected = truncateToEstimatedTokens(value.slice(start), Math.min(remaining, 1200))
          if (selected.text.length === 0) { nextPosition = { candidateRef: ref, field, part, start }; break reading }
          const end = start + selected.text.length
          const evidenceId = TicketEvidenceId(shortOpaque('ev', request.snapshotId, ref, field, String(part), record.contentHash, String(start), String(end)))
          evidence.push({
            projectionVersion: 2, projectionLevel: field === 'summary' ? 'L1' : request.level ?? 'L2', part, fieldLength: value.length,
            datasetId: record.rawSource?.datasetId ?? projection.snapshot.providerId, spanHash: sha256(selected.text),
            origin: field === 'summary' ? overviewOrigin(record, 'summary') : { kind: 'source', sourceFields: [field] },
            evidenceId,
            candidateRef: ref,
            displayId: record.displayId,
            sourceVersion: record.sourceVersion,
            contentHash: record.contentHash,
            field,
            text: selected.text,
            start,
            end,
            estimatedTokens: selected.tokens,
            trust: 'untrusted_ticket_evidence',
            truncated: start > 0 || end < value.length,
            evidenceLevel: ['title', 'summary'].includes(field) ? 'L1' : 'L2',
            readers: ['provider'], snapshotId: request.snapshotId,
            authorizationVersion: entry.snapshot.authorizationVersion,
            principalBindingHash: entry.snapshot.principalBindingHash,
          })
          remaining -= selected.tokens
          tokensUsed += selected.tokens
          start = end
          }
        }
      }
    }
    if (!reached) throw new RetrievalError('INVALID_REQUEST', '续读字段或分段已不存在。')
    return {
      ...(nextPosition === undefined ? {} : { nextPosition }),
      snapshotId: request.snapshotId,
      evidence,
      requestedCandidateRefs: [...request.candidateRefs],
      rejectedCandidateRefs: rejected,
      tokenBudget: request.tokenBudget,
      tokensUsed,
      warnings: remaining === 0 ? ['token_budget_exhausted'] : [],
    }
  }

export async function projectDetails(
    projection: TicketProjection,
    principal: TrustedPrincipalContext,
    request: DetailReadRequest,
    options?: ProviderCallOptions,
  ): Promise<TicketDetailResult> {
    abortIfNeeded(options)
    const entry = authorizeProjection(projection, principal, request.snapshotId)
    for (const field of request.fields) if (!entry.readableFields.has(field)) throw new RetrievalError('FIELD_NOT_ALLOWED', '请求了不允许的详情字段。')
    const details: TicketDetail[] = []
    const evidence: TicketEvidenceResult['evidence'][number][] = []
    const rejected: typeof request.candidateRefs[number][] = []
    for (const ref of request.candidateRefs) {
      abortIfNeeded(options)
      const record = entry.candidateRefs.get(ref)
      if (record === undefined || !canRead(record, principal)) {
        rejected.push(ref)
        continue
      }
      const fields: Partial<Record<TicketEvidenceField, readonly string[]>> = {}
      const unavailableFields: TicketEvidenceField[] = []
      for (const field of request.fields) {
        const values = evidenceFieldValues(record, field)
        if (values.length === 0) unavailableFields.push(field)
        else fields[field] = [...values]
        for (const [part, text] of values.entries()) evidence.push({
          projectionVersion: 2, projectionLevel: field === 'summary' ? 'L1' : 'L3', part, fieldLength: text.length,
          datasetId: record.rawSource?.datasetId ?? projection.snapshot.providerId, spanHash: sha256(text),
          origin: field === 'summary' ? overviewOrigin(record, 'summary') : { kind: 'source', sourceFields: [field] },
          evidenceId: TicketEvidenceId(shortOpaque('ev', request.snapshotId, ref, field, String(part), record.contentHash, '0', String(text.length))),
          candidateRef: ref, displayId: record.displayId, sourceVersion: record.sourceVersion, contentHash: record.contentHash,
          field, text, start: 0, end: text.length, estimatedTokens: estimateTokens(text),
          trust: 'untrusted_ticket_evidence', truncated: false,
          evidenceLevel: ['title', 'summary'].includes(field) ? 'L1' : 'L2', readers: ['provider'],
          snapshotId: request.snapshotId, authorizationVersion: entry.snapshot.authorizationVersion,
          principalBindingHash: entry.snapshot.principalBindingHash,
        })
      }
      details.push({
        candidateRef: ref,
        displayId: record.displayId,
        sourceVersion: record.sourceVersion,
        title: record.title,
        summary: record.summary,
        l0: candidateL0(record),
        fields,
        unavailableFields,
      })
    }
    return { snapshotId: request.snapshotId, details, evidence, rejectedCandidateRefs: rejected, warnings: [] }
  }
