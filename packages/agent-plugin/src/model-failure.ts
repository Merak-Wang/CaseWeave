import { RetrievalError } from '@retrieval-agent/contracts'

export interface ModelFailureCause {
  modelFailure: { code: string; status?: number; diagnostic?: string; retryAfterMs?: number }
  usage?: { prompt_tokens?: number; completion_tokens?: number; cached_prompt_tokens?: number | null }
}

/** 请求层按暂态错误恢复；Agent 已由 DSH 处理重试，最终错误不再触发整任务重跑。 */
export function modelFailure(failure: { code?: string; status?: number; message?: string; providerRetryAfterMs?: number },
  retryRequest = false, usage?: ModelFailureCause['usage']): RetrievalError {
  const code = /^[A-Z][A-Z0-9_]{0,80}$/u.test(failure.code ?? '') ? failure.code! : 'MODEL_FAILURE'
  const status = Number.isInteger(failure.status) && failure.status! >= 400 && failure.status! <= 599 ? failure.status : undefined
  const permanent = /AUTH|CREDENTIAL|QUOTA|BILLING|INVALID_REQUEST|MODEL_NOT_FOUND|CONTEXT_WINDOW/u.test(code)
    || status === 400 || status === 401 || status === 403 || status === 404 || status === 413
  const transient = !permanent && (['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'OUTPUT_SCHEMA'].includes(code)
    || status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500))
  // 仅提取稳定的网络原因，不把供应商正文、URL 或凭据写入错误记录。
  const message = failure.message ?? ''
  const diagnostic = message.match(/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_[A-Z_]+)\b/u)?.[0]
    ?? (/terminated|premature close|stream ended|other side closed/iu.test(message) ? 'STREAM_INTERRUPTED'
      : /fetch failed|connection error|network error/iu.test(message) ? 'CONNECTION_FAILED' : undefined)
  const detail: ModelFailureCause['modelFailure'] = { code, ...(status ? { status } : {}), ...(diagnostic ? { diagnostic } : {}),
    ...(Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs! > 0 ? { retryAfterMs: failure.providerRetryAfterMs } : {}) }
  const reason = status === 401 || status === 403 || /AUTH|CREDENTIAL/u.test(code) ? '模型服务未接受当前访问凭据，请检查模型设置中的密钥和访问权限。'
    : status === 404 || code === 'MODEL_NOT_FOUND' ? '当前模型或请求地址不可用，请在模型设置中选择有效模型并检查服务地址。'
    : /QUOTA|BILLING/u.test(code) ? '模型服务额度不足，请检查供应商额度后继续。'
    : status === 429 || code === 'RATE_LIMIT' ? '模型服务暂时限流，请稍后继续。'
    : code === 'OUTPUT_SCHEMA' ? '模型返回的结构化结果缺少必填字段或格式不符合要求，正在重试本次判断。'
    : code === 'TRANSPORT' ? '模型连接或响应传输中断，请稍后继续。'
    : code === 'TIMEOUT' ? '模型请求超时，请稍后继续。'
    : '模型请求失败，请检查模型设置和服务状态后继续。'
  return new RetrievalError('PROVIDER_UNAVAILABLE', `${reason}（${code}${status ? ` / HTTP ${status}` : ''}）查询与已确认结果已保留。`,
    { retryable: retryRequest && transient, cause: { modelFailure: detail, ...(usage ? { usage } : {}) } satisfies ModelFailureCause })
}
