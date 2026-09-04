import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  RetrievalError,
  type DetailReadRequest,
  type EvidenceReadRequest,
  type ProviderCallOptions,
  type TicketDetailResult,
  type TicketEvidenceResult,
  type TicketProviderStatus,
  type TicketRetrievalRequest,
  type TicketRetrievalSpec,
  type TicketSearchOptions,
  type TicketSearchPage,
  type TicketSnapshot,
  type TicketSnapshotId,
  type TrustedPrincipalContext,
} from '@retrieval-agent/contracts'
import { TicketRetrievalProviderService } from '@retrieval-agent/agent-plugin'
import { LocalTicketProvider, parseTicketDatasetJsonl, rankingDocuments } from '@retrieval-agent/provider-local'
import { HybridRankingEngine, type RetrievalRanker } from '@retrieval-agent/retrieval-ranking'

export interface Config {
  readonly dataPath: string
  readonly additionalDataPaths?: string[]
  readonly providerId?: string
  readonly maxRequestedCount?: number
  readonly maxPageSize?: number
  readonly snapshotTtlMs?: number
  readonly retrievalMode?: 'keyword' | 'dense' | 'hybrid'
  readonly modelServiceBaseUrl?: string
  readonly embeddingModel?: string
  readonly embeddingRevision?: string
  readonly embeddingDimensions?: number
  readonly modelDeadlineMs?: number
  readonly preparePollIntervalMs?: number
  readonly denseTopK?: number
  readonly rerankerEnabled?: boolean
  readonly rerankerModel?: string
  readonly rerankerRevision?: string
  readonly allowKeywordFallback?: boolean
  /** Non-serialized Provider seam used by deterministic composition tests. */
  readonly ranker?: RetrievalRanker
}

export const Config: z<Config> = z.object({
  dataPath: z.string().required(),
  additionalDataPaths: z.array(z.string()).default([]),
  providerId: z.string().default('local-fixture-v1'),
  // Existing persisted profiles used this name for both page and result limits. Read it as page capacity only.
  maxRequestedCount: z.number().step(1).min(1),
  maxPageSize: z.number().step(1).min(1),
  snapshotTtlMs: z.number().step(1).min(1).default(900_000),
  retrievalMode: z.union(['keyword', 'dense', 'hybrid'] as const).default('hybrid'),
  modelServiceBaseUrl: z.string().default('http://127.0.0.1:8012'),
  embeddingModel: z.string().default('Qwen/Qwen3-Embedding-0.6B'),
  embeddingRevision: z.string(),
  embeddingDimensions: z.number().step(1).min(1).default(1024),
  modelDeadlineMs: z.number().step(1).min(100).default(120_000),
  preparePollIntervalMs: z.number().step(1).min(100).default(1_000),
  denseTopK: z.number().step(1).min(1).max(100).default(15),
  rerankerEnabled: z.boolean().default(false),
  rerankerModel: z.string().default('Qwen/Qwen3-Reranker-0.6B'),
  rerankerRevision: z.string(),
  allowKeywordFallback: z.boolean().default(false),
})

/** Fixture Provider adapter used by the shipped local preset only. */
export class LocalTicketProviderService extends TicketRetrievalProviderService {
  static Config = Config
  private readonly provider: LocalTicketProvider
  private readonly preparation: Promise<void>
  private preparationError: unknown

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const records = [config.dataPath, ...(config.additionalDataPaths ?? [])]
      .flatMap(path => parseTicketDatasetJsonl(readFileSync(path, 'utf8')))
    const mode = config.retrievalMode ?? 'hybrid'
    const embeddingModel = config.embeddingModel ?? 'Qwen/Qwen3-Embedding-0.6B'
    const embeddingDimensions = config.embeddingDimensions ?? 1024
    const embeddingRevision = config.embeddingRevision?.trim()
    const rerankerModel = config.rerankerModel ?? 'Qwen/Qwen3-Reranker-0.6B'
    const rerankerRevision = config.rerankerRevision?.trim()
    if (config.rerankerEnabled === true && mode !== 'hybrid') {
      throw new TypeError('reranking requires hybrid retrieval mode')
    }
    if (mode !== 'keyword' && (embeddingRevision === undefined || embeddingRevision.length === 0)) {
      throw new TypeError('dense or hybrid retrieval requires a pinned embeddingRevision')
    }
    if (config.rerankerEnabled === true && (rerankerRevision === undefined || rerankerRevision.length === 0)) {
      throw new TypeError('enabled reranking requires a pinned rerankerRevision')
    }
    const ranker = config.ranker ?? new HybridRankingEngine({
      baseUrl: config.modelServiceBaseUrl ?? 'http://127.0.0.1:8012',
      ...(mode === 'keyword' ? {} : {
        embeddingIdentity: { model: embeddingModel, revision: embeddingRevision!, dimensions: embeddingDimensions },
      }),
      ...(config.rerankerEnabled !== true ? {} : {
        rerankerIdentity: { model: rerankerModel, revision: rerankerRevision! },
      }),
      modelDeadlineMs: config.modelDeadlineMs ?? 120_000,
      preparePollIntervalMs: config.preparePollIntervalMs ?? 1_000,
      denseTopK: config.denseTopK ?? 15,
      rerankerEnabled: config.rerankerEnabled ?? false,
      allowKeywordFallback: config.allowKeywordFallback ?? false,
    })
    this.provider = new LocalTicketProvider(records, {
      ...(config.providerId === undefined ? {} : { providerId: config.providerId }),
      ...((config.maxPageSize ?? config.maxRequestedCount) === undefined ? {} : { maxPageSize: config.maxPageSize ?? config.maxRequestedCount }),
      ...(config.snapshotTtlMs === undefined ? {} : { snapshotTtlMs: config.snapshotTtlMs }),
      defaultMode: mode,
      ranker,
    })
    this.preparation = (mode === 'keyword' || ranker.prepare === undefined
      ? Promise.resolve(undefined)
      : ranker.prepare(rankingDocuments(records)))
      .then(() => undefined, error => { this.preparationError = error })
  }

  private async ensurePrepared(): Promise<void> {
    await this.preparation
    if (this.preparationError !== undefined) {
      throw new RetrievalError('PROVIDER_UNAVAILABLE', '本地检索模型或全量向量索引尚未就绪。', {
        retryable: true,
        cause: this.preparationError,
      })
    }
  }

  get providerId(): string { return this.provider.providerId }
  resolve(request: TicketRetrievalRequest): TicketRetrievalSpec { return this.provider.resolve(request) }
  async openSnapshot(principal: TrustedPrincipalContext, options?: ProviderCallOptions): Promise<TicketSnapshot> {
    await this.ensurePrepared()
    return await this.provider.openSnapshot(principal, options)
  }
  async search(principal: TrustedPrincipalContext, snapshotId: TicketSnapshotId, spec: TicketRetrievalSpec, options: TicketSearchOptions): Promise<TicketSearchPage> {
    await this.ensurePrepared()
    return await this.provider.search(principal, snapshotId, spec, options)
  }
  readEvidence(principal: TrustedPrincipalContext, request: EvidenceReadRequest, options?: ProviderCallOptions): Promise<TicketEvidenceResult> { return this.provider.readEvidence(principal, request, options) }
  readDetails(principal: TrustedPrincipalContext, request: DetailReadRequest, options?: ProviderCallOptions): Promise<TicketDetailResult> { return this.provider.readDetails(principal, request, options) }
  async status(principal: TrustedPrincipalContext, snapshotId?: TicketSnapshotId): Promise<TicketProviderStatus> {
    await this.preparation
    if (this.preparationError !== undefined) {
      return { providerId: this.providerId, ready: false, readOnly: true, warnings: ['retrieval_index_unavailable'] }
    }
    return await this.provider.status(principal, snapshotId)
  }
}

export default LocalTicketProviderService
