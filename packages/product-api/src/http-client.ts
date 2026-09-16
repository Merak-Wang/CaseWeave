/** 保留服务端错误码，让页面按具体业务错误决定提示和是否重试。 */
export class ProductApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = new.target.name
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 四个浏览器入口共用传输处理；结果身份和业务字段由调用处核对。 */
export async function postProductApi<T>(
  endpoint: string, body: unknown, label: string,
  ErrorType: typeof ProductApiClientError, signal?: AbortSignal,
): Promise<{ payload: T; status: number }> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  } catch (cause) {
    throw new ErrorType('NETWORK_UNAVAILABLE', `无法连接${label}服务。`, true, undefined, { cause })
  }
  const { status } = response
  let payload: unknown
  try { payload = await response.json() }
  catch (cause) {
    throw new ErrorType('INVALID_RESPONSE', `${label}服务返回了无法解析的响应（HTTP ${status}）。`, status >= 500, status, { cause })
  }
  if (!response.ok) {
    if (isRecord(payload) && typeof payload.code === 'string'
      && typeof payload.message === 'string' && typeof payload.retryable === 'boolean') {
      throw new ErrorType(payload.code, payload.message, payload.retryable, status)
    }
    throw new ErrorType(`HTTP_${status}`, `${label}请求失败（HTTP ${status}）。`, status >= 500, status)
  }
  return { payload: payload as T, status }
}
