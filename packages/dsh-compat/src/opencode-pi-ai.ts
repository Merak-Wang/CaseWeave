import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply as applyPiAi, PiAiAdapter, type Config as PiAiConfig, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

export { name, inject, Config } from '@deepseek-ai/dsh-llm-pi-ai'

const HEADER = 'x-opencode-session'
const UUID = '(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})'
const conversationUuid = new RegExp(`^(?:session-)?(${UUID})$`, 'iu')

/** Existing UUID conversations keep their identity; legacy/custom IDs map deterministically to UUID v5. */
export function openCodeSessionId(sessionId: string): string {
  const existing = conversationUuid.exec(sessionId)?.[1]
  if (existing) return existing.toLowerCase()
  const namespace = Buffer.from('4e7f6455086e4a3892cbaace799f8ad1', 'hex')
  const bytes = createHash('sha1').update(namespace).update(sessionId, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = bytes.toString('hex')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function isOpenCodeRoute(provider: string, baseUrl?: string): boolean {
  if (provider.toLowerCase().startsWith('opencode')) return true
  try { return baseUrl !== undefined && new URL(baseUrl).hostname.toLowerCase() === 'opencode.ai' }
  catch { return false }
}

// Pinned rc.2's shared direct/prepared-call seam is private TypeScript, but emitted as this method.
// Keep this dependency here; remove the facade when the upstream adapter passes the same wire tests.
interface Snapshot {
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  models: { getModel(provider: string, model: string): { baseUrl?: string } | undefined
    streamSimple(model: unknown, context: unknown, options: Record<string, unknown>): unknown }
}
type Stream = (this: PiAiAdapter, options: GenerateOptions, snapshot: Snapshot) => AsyncIterable<StreamChunk>
const prototype = PiAiAdapter.prototype as unknown as { streamWithSnapshot: Stream }
let owners = 0
let restore: (() => void) | undefined

export interface LocalProviderTransport {
  provider: string
  labelProbabilities?: boolean
  createFetch(baseURL: string, options: Record<string, unknown>): typeof fetch
}

export async function localProviderTransport(): Promise<LocalProviderTransport | undefined> {
  const path = process.env.RETRIEVAL_AGENT_MODEL_TRANSPORT_MODULE
  return path ? (await import(pathToFileURL(path).href)).default : undefined
}

function install(transport?: LocalProviderTransport): () => void {
  if (owners === 0) {
    const original = prototype.streamWithSnapshot
    if (typeof original !== 'function' || original.length !== 2) throw new Error('Pinned DSH pi-ai stream seam changed; review OpenCode compatibility before starting.')
    const wrapped: Stream = function (options, snapshot) {
      const model = snapshot.models.getModel(options.provider, options.model)
      if (transport && options.provider === transport.provider && model?.baseUrl) {
        // 私有驱动仅替换这一供应商的HTTP封装，模型选择、工具解析与计量仍由DSH处理。
        const models = Object.assign(Object.create(snapshot.models), {
          streamSimple: (value: unknown, context: unknown, request: Record<string, unknown>) => snapshot.models.streamSimple(value, context,
            { ...request, fetch: transport.createFetch(model.baseUrl!, request) }),
        }) as Snapshot['models']
        return original.call(this, options, { ...snapshot, models })
      }
      if (!isOpenCodeRoute(options.provider, model?.baseUrl)) return original.call(this, options, snapshot)
      if (!options.sessionId || !String(options.sessionId).trim()) {
        throw new LlmError('OpenCode inference requires a conversation sessionId.', 'INVALID_REQUEST')
      }
      const profile = snapshot.profiles.get(options.provider)
      if (!profile) return original.call(this, options, snapshot)
      const headers = { ...Object.fromEntries(Object.entries(profile.headers ?? {}).filter(([key]) => key.toLowerCase() !== HEADER)),
        [HEADER]: openCodeSessionId(String(options.sessionId)) }
      // Never mutate shared settings/profile snapshots: simultaneous conversations must not exchange IDs.
      const profiles = new Map(snapshot.profiles)
      profiles.set(options.provider, { ...profile, headers })
      // DSH把off解释为不传reasoning；该网关默认思考，需要在实际请求正文明确关闭。
      const disableThinking = options.reasoningEffort === 'off' && options.model.startsWith('deepseek-')
      const models = disableThinking ? Object.assign(Object.create(snapshot.models), {
        streamSimple: (model: unknown, context: unknown, request: Record<string, unknown>) => snapshot.models.streamSimple(model, context,
          { ...request, onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), thinking: { type: 'disabled' } }) }),
      }) as Snapshot['models'] : snapshot.models
      return original.call(this, options, { ...snapshot, profiles, models })
    }
    prototype.streamWithSnapshot = wrapped
    restore = () => { if (prototype.streamWithSnapshot === wrapped) prototype.streamWithSnapshot = original }
  }
  owners++
  return () => { if (--owners === 0) { restore?.(); restore = undefined } }
}

/** Same upstream config, credentials, catalog and request implementation; only adds per-call routing identity. */
export async function apply(ctx: Context, config: PiAiConfig): Promise<void> {
  const transport = await localProviderTransport()
  ctx.effect(() => install(transport))
  applyPiAi(ctx, config)
}
