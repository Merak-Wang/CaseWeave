import type { Context } from '@deepseek-ai/cordis'
import { RetrievalError } from '@retrieval-agent/contracts'

type Profile = { baseURL?: string; api?: string; apiKeyEnv?: string; headers?: Record<string, string> }
type Settings = { describe(): { ns: string; value: unknown }[] }
type Credentials = { resolve(ref: string): Promise<{ value: string } | undefined> }

/** 仅从DSH当前可信配置读取端点和凭据；工单/模型输出不能选择网络目标。 */
export async function readLabelLogprobs(ctx: Context, provider: string, model: string,
  messages: readonly { role: string; content: string }[], manifestId: string, signal?: AbortSignal) {
  const settings = ctx.get('settings') as Settings | undefined
  const configured = settings?.describe().find(d => d.ns === 'retrieval-llm-pi-ai')?.value as { providers?: Record<string, Profile> } | undefined
  const profile = configured?.providers?.[provider]
  const unavailable = (reason: string) => ({ payload: { available: false, p_first: null, unavailable_reason: reason }, usage: {} })
  if (!profile?.baseURL || !['openai-completions', 'openai-chat-completions'].includes(profile.api ?? 'openai-completions')) return unavailable('provider_logprobs_route_unavailable')
  const credentials = ctx.get('credentials') as Credentials | undefined
  const key = profile.apiKeyEnv ? (await credentials?.resolve(profile.apiKeyEnv))?.value : undefined
  if (profile.apiKeyEnv && !key) return unavailable('provider_credential_unavailable')
  const headers = { ...profile.headers, 'Content-Type': 'application/json', 'x-opencode-session': manifestId,
    ...(key ? { Authorization: `Bearer ${key}` } : {}) }
  const body = { model, messages, stream: false, temperature: 1, top_p: 1, max_tokens: 1,
    thinking: { type: 'disabled' }, logprobs: true, top_logprobs: 20 }
  let response: Response
  try {
    response = await fetch(profile.baseURL.replace(/\/$/u, '') + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
  } catch {
    signal?.throwIfAborted()
    throw new RetrievalError('PROVIDER_UNAVAILABLE', '下一token判断服务请求失败。', { retryable: true })
  }
  if (!response.ok) return unavailable(`logprobs_http_${response.status}`)
  const value = await response.json() as { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }; choices?: { message?: { content?: string }; logprobs?: { content?: { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] }[] } }[] }
  const usage = { prompt_tokens: value.usage?.prompt_tokens ?? null,
    completion_tokens: value.usage?.completion_tokens ?? null, cached_prompt_tokens: value.usage?.prompt_tokens_details?.cached_tokens ?? null }
  const fail = (reason: string) => ({ ...unavailable(reason), usage })
  if (value.model !== model) return fail('model_identity_mismatch')
  const choice = value.choices?.[0], positions = choice?.logprobs?.content
  if (!positions || positions.length !== 1 || !['Y', 'N'].includes(choice?.message?.content ?? '')) return fail('answer_logprobs_unavailable')
  const entries = positions[0]!.top_logprobs ?? [], first = entries.filter(e => e.token === 'Y'), second = entries.filter(e => e.token === 'N')
  if (first.length !== 1 || second.length !== 1) return fail('label_pair_missing')
  const chosen = positions[0]!
  if (chosen.token !== choice?.message?.content || [first[0]!, second[0]!, chosen].some(e =>
    !Number.isFinite(e.logprob) || e.logprob > 0 || e.logprob <= -9999)) return fail('label_logprob_invalid')
  const difference = second[0]!.logprob - first[0]!.logprob
  const pFirst = difference >= 0 ? Math.exp(-difference) / (1 + Math.exp(-difference)) : 1 / (1 + Math.exp(difference))
  return { payload: { available: true, p_first: pFirst, unavailable_reason: '' }, usage }
}
