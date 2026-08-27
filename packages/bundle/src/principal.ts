import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  PrincipalResolutionRequest,
  ProviderCallOptions,
  TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { TicketPrincipalProviderService } from '@retrieval-agent/agent-plugin'

export interface Config {
  readonly tenantId?: string
  readonly subjectId?: string
  readonly entitlementVersion?: string
  readonly groups?: string[]
  readonly regions?: string[]
  readonly ttlMs?: number
}

export const Config: z<Config> = z.object({
  tenantId: z.string().default('demo'),
  subjectId: z.string().default('demo-user'),
  entitlementVersion: z.string().default('fixture-entitlements-v1'),
  groups: z.array(z.string()).default(['support']),
  regions: z.array(z.string()).default(['cn']),
  ttlMs: z.number().step(1).min(1).default(300_000),
})

/** Trusted static Principal for fixture mode. Production presets must replace this service. */
export class FixturePrincipalProviderService extends TicketPrincipalProviderService {
  static Config = Config
  readonly #config: Required<Config>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.#config = {
      tenantId: config.tenantId ?? 'demo',
      subjectId: config.subjectId ?? 'demo-user',
      entitlementVersion: config.entitlementVersion ?? 'fixture-entitlements-v1',
      groups: [...config.groups ?? ['support']],
      regions: [...config.regions ?? ['cn']],
      ttlMs: config.ttlMs ?? 300_000,
    }
  }

  resolve(request: PrincipalResolutionRequest, options?: ProviderCallOptions): Promise<TrustedPrincipalContext> {
    if (options?.signal?.aborted === true) return Promise.reject(new Error('principal resolution cancelled'))
    if (request.sessionId.trim().length === 0) return Promise.reject(new Error('trusted session id is required'))
    const now = new Date()
    return Promise.resolve({
      tenantId: this.#config.tenantId,
      subjectId: this.#config.subjectId,
      entitlementVersion: this.#config.entitlementVersion,
      purpose: 'ticket_retrieval',
      attributes: { group: this.#config.groups, region: this.#config.regions },
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#config.ttlMs).toISOString(),
    })
  }
}

export default FixturePrincipalProviderService
