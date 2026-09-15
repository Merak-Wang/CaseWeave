import { RetrievalError } from '@retrieval-agent/contracts'

/** Only structured failure metadata crosses the public boundary; provider bodies may contain credentials. */
export function modelFailure(failure: { code?: string; status?: number }): RetrievalError {
  const code = /^[A-Z][A-Z0-9_]{0,80}$/u.test(failure.code ?? '') ? failure.code : 'MODEL_FAILURE'
  const status = Number.isInteger(failure.status) && failure.status! >= 400 && failure.status! <= 599 ? failure.status : undefined
  const reason = status === 401 || status === 403 ? '模型服务未接受当前访问凭据，请检查模型设置中的密钥和访问权限。'
    : status === 404 || code === 'MODEL_NOT_FOUND' ? '当前模型或请求地址不可用，请在模型设置中选择有效模型并检查服务地址。'
    : status === 429 ? '模型服务暂时限流或额度不足，请检查供应商状态后继续。'
    : '模型请求失败，请检查模型设置和服务状态后继续。'
  return new RetrievalError('PROVIDER_UNAVAILABLE', `${reason}（${code}${status ? ` / HTTP ${status}` : ''}）查询与已确认结果已保留。`, { retryable: false })
}
