import { createHash } from 'node:crypto'
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
  models: { getModel(provider: string, model: string): { baseUrl?: string } | undefined }
}
type Stream = (this: PiAiAdapter, options: GenerateOptions, snapshot: Snapshot) => AsyncIterable<StreamChunk>
const prototype = PiAiAdapter.prototype as unknown as { streamWithSnapshot: Stream }
let owners = 0
let restore: (() => void) | undefined

function install(): () => void {
  if (owners === 0) {
    const original = prototype.streamWithSnapshot
    if (typeof original !== 'function' || original.length !== 2) throw new Error('Pinned DSH pi-ai stream seam changed; review OpenCode compatibility before starting.')
    const wrapped: Stream = function (options, snapshot) {
      const model = snapshot.models.getModel(options.provider, options.model)
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
      return original.call(this, options, { ...snapshot, profiles })
    }
    prototype.streamWithSnapshot = wrapped
    restore = () => { if (prototype.streamWithSnapshot === wrapped) prototype.streamWithSnapshot = original }
  }
  owners++
  return () => { if (--owners === 0) { restore?.(); restore = undefined } }
}

/** Same upstream config, credentials, catalog and request implementation; only adds per-call routing identity. */
export function apply(ctx: Context, config: PiAiConfig): void {
  ctx.effect(install)
  applyPiAi(ctx, config)
}
