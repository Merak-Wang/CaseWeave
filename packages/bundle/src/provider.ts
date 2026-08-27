import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  DetailReadRequest,
  EvidenceReadRequest,
  ProviderCallOptions,
  TicketDetailResult,
  TicketEvidenceResult,
  TicketProviderStatus,
  TicketRetrievalRequest,
  TicketRetrievalSpec,
  TicketSearchOptions,
  TicketSearchPage,
  TicketSnapshot,
  TicketSnapshotId,
  TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { TicketRetrievalProviderService } from '@retrieval-agent/agent-plugin'
import { LocalTicketProvider, parseFixtureJsonl } from '@retrieval-agent/provider-local'

export interface Config {
  readonly dataPath: string
  readonly providerId?: string
  readonly defaultRequestedCount?: number
  readonly maxRequestedCount?: number
  readonly snapshotTtlMs?: number
}

export const Config: z<Config> = z.object({
  dataPath: z.string().required(),
  providerId: z.string().default('local-fixture-v1'),
  defaultRequestedCount: z.number().step(1).min(1).default(5),
  maxRequestedCount: z.number().step(1).min(1).default(20),
  snapshotTtlMs: z.number().step(1).min(1).default(900_000),
})

/** Fixture Provider adapter used by the shipped local preset only. */
export class LocalTicketProviderService extends TicketRetrievalProviderService {
  static Config = Config
  readonly #provider: LocalTicketProvider

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const records = parseFixtureJsonl(readFileSync(config.dataPath, 'utf8'))
    this.#provider = new LocalTicketProvider(records, {
      ...(config.providerId === undefined ? {} : { providerId: config.providerId }),
      ...(config.defaultRequestedCount === undefined ? {} : { defaultRequestedCount: config.defaultRequestedCount }),
      ...(config.maxRequestedCount === undefined ? {} : { maxRequestedCount: config.maxRequestedCount }),
      ...(config.snapshotTtlMs === undefined ? {} : { snapshotTtlMs: config.snapshotTtlMs }),
    })
  }

  get providerId(): string { return this.#provider.providerId }
  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec { return this.#provider.resolve(request) }
  openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot> { return this.#provider.openSnapshot(principal, options) }
  search(principal: TrustedPrincipalContext, snapshotId: TicketSnapshotId, spec: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> { return this.#provider.search(principal, snapshotId, spec, options) }
  readEvidence(principal: TrustedPrincipalContext, request: EvidenceReadRequest, options?: ProviderCallOptions): Promise<TicketEvidenceResult> { return this.#provider.readEvidence(principal, request, options) }
  readDetails(principal: TrustedPrincipalContext, request: DetailReadRequest, options?: ProviderCallOptions): Promise<TicketDetailResult> { return this.#provider.readDetails(principal, request, options) }
  status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshotId): Promise<TicketProviderStatus> { return this.#provider.status(principal, snapshotId) }
}

export default LocalTicketProviderService
