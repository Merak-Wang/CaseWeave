export type RetrievalErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_INVALID'
  | 'CANDIDATE_NOT_FOUND'
  | 'FIELD_NOT_ALLOWED'
  | 'BUDGET_EXHAUSTED'
  | 'CAPACITY_EXCEEDED'
  | 'INVALID_TRANSITION'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROTOCOL_MISMATCH'
  | 'EXPORT_LIMIT_EXCEEDED'

/** Structured error safe for policy handling; cause/internal details are not exposed to users. */
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode
  readonly retryable: boolean
  readonly publicMessage: string

  constructor(code: RetrievalErrorCode, publicMessage: string, options: { readonly retryable?: boolean; readonly cause?: unknown } = {}) {
    super(publicMessage, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RetrievalError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.publicMessage = publicMessage
  }
}
export function asRetrievalError(error: unknown): RetrievalError {
  if (error instanceof RetrievalError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new RetrievalError('CANCELLED', '操作已取消。')
  }
  return new RetrievalError('PROVIDER_UNAVAILABLE', '工单数据源当前不可用。', { retryable: true, cause: error })
}
