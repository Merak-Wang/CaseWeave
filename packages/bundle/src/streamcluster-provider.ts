import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  DetailReadRequest,
  EvidenceReadRequest,
  L3DetailsReadRequest,
  ProviderCallOptions,
  TicketDetailResult,
  TicketEvidenceResult,
  TicketL3DetailsResult,
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
import { StreamClusterTicketProvider } from '@retrieval-agent/provider-streamcluster'

export interface Config {
  readonly baseUrl: string
  readonly providerId?: string
  readonly apiKey?: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxRequestedCount?: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  providerId: z.string().default('streamcluster-v1'),
  apiKey: z.string(),
  timeoutMs: z.number().step(1).min(1).default(30_000),
  maxResponseBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  maxRequestedCount: z.number().step(1).min(1).max(100).default(20),
})

/** Cordis service wrapper for deployments that select the remote read-only Provider. */
export class StreamClusterTicketProviderService extends TicketRetrievalProviderService {
  static Config = Config
  private readonly provider: StreamClusterTicketProvider

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.provider = new StreamClusterTicketProvider({
      baseUrl: config.baseUrl,
      ...(config.providerId === undefined ? {} : { providerId: config.providerId }),
      ...(config.apiKey === undefined || config.apiKey.length === 0 ? {} : { authorization: `Bearer ${config.apiKey}` }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
      ...(config.maxRequestedCount === undefined ? {} : { maxRequestedCount: config.maxRequestedCount }),
    })
  }

  get providerId(): string { return this.provider.providerId }
  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec { return this.provider.resolve(request) }
  openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot> { return this.provider.openSnapshot(principal, options) }
  search(principal: TrustedPrincipalContext, snapshotId: TicketSnapshotId, query: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> { return this.provider.search(principal, snapshotId, query, options) }
  readEvidence(principal: TrustedPrincipalContext, request: EvidenceReadRequest, options?: ProviderCallOptions): Promise<TicketEvidenceResult> { return this.provider.readEvidence(principal, request, options) }
  readDetails(principal: TrustedPrincipalContext, request: DetailReadRequest, options?: ProviderCallOptions): Promise<TicketDetailResult> { return this.provider.readDetails(principal, request, options) }
  readL3Details(principal: TrustedPrincipalContext, request: L3DetailsReadRequest, options?: ProviderCallOptions): Promise<TicketL3DetailsResult> { return this.provider.readL3Details(principal, request, options) }
  status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshotId): Promise<TicketProviderStatus> { return this.provider.status(principal, snapshotId) }
}

export default StreamClusterTicketProviderService
