import { Context, Service } from '@deepseek-ai/cordis'
import type {
  DetailReadRequest,
  EvidenceReadRequest,
  L3DetailsReadRequest,
  PrincipalResolutionRequest,
  ProviderCallOptions,
  TicketDetailResult,
  TicketEvidenceResult,
  TicketL3DetailsResult,
  TicketProviderStatus,
  TicketRetrievalProvider,
  TicketRetrievalRequest,
  TicketRetrievalSpec,
  TicketSearchOptions,
  TicketSearchPage,
  TicketSnapshot,
  TicketSnapshotId,
  TrustedPrincipalContext,
  TrustedPrincipalProvider,
} from '@retrieval-agent/contracts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ticketRetrievalProvider: TicketRetrievalProviderService
    ticketPrincipalProvider: TicketPrincipalProviderService
    retrievalAgent: import('./service.js').RetrievalAgentService
  }
}

/** Cordis bridge for the provider port defined in `contracts`. */
export abstract class TicketRetrievalProviderService extends Service implements TicketRetrievalProvider {
  abstract readonly providerId: string

  constructor(ctx: Context) {
    super(ctx, 'ticketRetrievalProvider')
  }

  abstract resolve(request: TicketRetrievalRequest): TicketRetrievalSpec
  abstract openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot>
  abstract search(principal: TrustedPrincipalContext, snapshotId: TicketSnapshotId, spec: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage>
  abstract readEvidence(principal: TrustedPrincipalContext, request: EvidenceReadRequest, options?: ProviderCallOptions): Promise<TicketEvidenceResult>
  abstract readDetails(principal: TrustedPrincipalContext, request: DetailReadRequest, options?: ProviderCallOptions): Promise<TicketDetailResult>
  abstract readL3Details(principal: TrustedPrincipalContext, request: L3DetailsReadRequest, options?: ProviderCallOptions): Promise<TicketL3DetailsResult>
  abstract status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshotId): Promise<TicketProviderStatus>
}

/** Cordis bridge for the trusted Host identity port defined in `contracts`. */
export abstract class TicketPrincipalProviderService extends Service implements TrustedPrincipalProvider {
  constructor(ctx: Context) {
    super(ctx, 'ticketPrincipalProvider')
  }

  abstract resolve(request: PrincipalResolutionRequest, options?: ProviderCallOptions): Promise<TrustedPrincipalContext>
}
