import { RetrievalError } from './errors.js'
import type { TicketFilter, TicketRetrievalRequest, TrustedPrincipalContext } from './types.js'

const RESERVED_FILTER_FIELDS = new Set([
  'tenantId', 'subjectId', 'allowedSubjectIds', 'requiredAttributes', 'piiRedactionStatus',
  'contentHash', 'rawSource', 'rawSource.payload',
])
const DATE_FILTER_FIELDS = new Set(['createdAt', 'updatedAt', 'resolvedAt'])
const CATEGORICAL_FILTER_FIELDS = new Set([
  'type', 'category', 'priority', 'status', 'language', 'region', 'product', 'component',
])

export function assertTrustedPrincipal(principal: TrustedPrincipalContext, now = Date.now()): void {
  if (principal.purpose !== 'ticket_retrieval') throw new RetrievalError('UNAUTHORIZED', '当前身份不允许执行工单检索。')
  if (principal.tenantId.trim().length === 0 || principal.subjectId.trim().length === 0 || principal.entitlementVersion.trim().length === 0) {
    throw new RetrievalError('UNAUTHORIZED', '身份上下文不完整。')
  }
  if (Number.isNaN(Date.parse(principal.issuedAt))) throw new RetrievalError('UNAUTHORIZED', '身份上下文时间无效。')
  if (principal.expiresAt !== undefined) {
    const expiry = Date.parse(principal.expiresAt)
    if (Number.isNaN(expiry) || expiry <= now) throw new RetrievalError('UNAUTHORIZED', '身份上下文已失效。')
  }
}

export function assertTicketFilterField(field: unknown): asserts field is TicketFilter['field'] {
  if (typeof field !== 'string'
    || !/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u.test(field)
    || RESERVED_FILTER_FIELDS.has(field)) {
    throw new RetrievalError('INVALID_REQUEST', '包含不支持的工单筛选字段。')
  }
}

export function assertTicketFilter(filter: TicketFilter): void {
  const candidate = filter as { readonly field?: unknown; readonly op?: unknown; readonly value?: unknown }
  assertTicketFilterField(candidate.field)
  if (typeof candidate.value !== 'string' || candidate.value.trim().length === 0 || candidate.value.length > 256) {
    throw new RetrievalError('INVALID_REQUEST', '工单筛选值无效。')
  }
  if (!['eq', 'neq', 'gte', 'lte', 'contains'].includes(String(candidate.op))) {
    throw new RetrievalError('INVALID_REQUEST', '工单筛选操作无效。')
  }
  if (CATEGORICAL_FILTER_FIELDS.has(candidate.field) && candidate.op !== 'eq' && candidate.op !== 'neq') {
    throw new RetrievalError('INVALID_REQUEST', '枚举工单字段只支持 eq/neq。')
  }
  if (DATE_FILTER_FIELDS.has(candidate.field)) {
    if (candidate.op !== 'gte' && candidate.op !== 'lte') throw new RetrievalError('INVALID_REQUEST', '时间字段只支持 gte/lte。')
    if (Number.isNaN(Date.parse(candidate.value))) throw new RetrievalError('INVALID_REQUEST', '时间筛选值必须是有效时间。')
  }
  if (candidate.field === 'errorCodes' && candidate.op !== 'contains') {
    throw new RetrievalError('INVALID_REQUEST', '错误码字段只支持 contains。')
  }
}

export function assertTicketRetrievalRequest(request: TicketRetrievalRequest): void {
  if (request.query.trim().length === 0) throw new RetrievalError('INVALID_REQUEST', '检索问题不能为空。')
  if (request.query.length > 4_000) throw new RetrievalError('INVALID_REQUEST', '检索问题过长。')
  if (request.retrievalQuery !== undefined
    && (request.retrievalQuery.trim().length === 0 || request.retrievalQuery.length > 4_000)) {
    throw new RetrievalError('INVALID_REQUEST', '结构化后的检索文本无效。')
  }
  if (request.requestedCount !== undefined && (!Number.isSafeInteger(request.requestedCount) || request.requestedCount < 1 || request.requestedCount > 100)) {
    throw new RetrievalError('INVALID_REQUEST', '候选数量无效。')
  }
  if (request.mode !== undefined && !['keyword', 'dense', 'hybrid'].includes(request.mode)) {
    throw new RetrievalError('INVALID_REQUEST', '检索模式无效。')
  }
  if (request.countPolicy !== undefined && !['explicit', 'adaptive'].includes(request.countPolicy)) {
    throw new RetrievalError('INVALID_REQUEST', '候选数量策略无效。')
  }
  if (request.countPolicy === 'explicit' && request.requestedCount === undefined) {
    throw new RetrievalError('INVALID_REQUEST', '显式数量策略必须包含候选数量。')
  }
  for (const ambiguity of request.ambiguities ?? []) {
    if (!['reference', 'quantity', 'boundary', 'constraint'].includes(ambiguity.kind)
      || ambiguity.text.trim().length === 0 || ambiguity.text.length > 500) {
      throw new RetrievalError('INVALID_REQUEST', '查询歧义无效。')
    }
  }
  for (const filter of request.filters ?? []) assertTicketFilter(filter)
}
