import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SpacyQueryAnalyzer } from '@retrieval-agent/query-understanding'
import { installRetrievalRuntimeBudget } from './context-budget.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { installRetrievalPresentationAnchors } from './presentation.js'
import { RetrievalAgentService, type RetrievalAgentServiceConfig } from './service.js'
import { installRetrievalTools } from './tools.js'

export * from './compact.js'
export * from './context-budget.js'
export * from './provider-services.js'
export * from './pre-step.js'
export * from './presentation.js'
export * from './service.js'
export * from './session-journal.js'
export * from './tool-output-schema.js'
export * from './tools.js'

export const name = 'retrieval-agent'
export const inject = ['agents', 'llm', 'tokenMeter', 'ticketRetrievalProvider', 'ticketPrincipalProvider', 'tools', 'systemPrompt']

export interface Config extends RetrievalAgentServiceConfig {
  readonly maxFinishReminders?: number
  readonly queryAnalysisBaseUrl?: string
  readonly queryAnalysisDeadlineMs?: number
  readonly retrievalPolicyBaseUrl?: string
  readonly retrievalPolicyDeadlineMs?: number
}

export const Config: z<Config> = z.object({
  maxRounds: z.number().step(1).min(2).default(8),
  maxSearches: z.number().step(1).min(1).default(2_500),
  maxPromotions: z.number().step(1).min(1).default(3),
  maxEvidenceTokens: z.number().step(1).min(1).default(1_500),
  maxLatencyMs: z.number().step(1).min(100).default(120_000),
  noProgressLimit: z.number().step(1).min(1).default(2),
  searchTopK: z.number().step(1).min(1).max(50).default(20),
  searchMaxScan: z.number().step(1).min(1).default(50_000),
  contextTokenBudget: z.number().step(1).min(1),
  maxContextTokens: z.number().step(1).min(1),
  maxFinishReminders: z.number().step(1).min(0).default(3),
  queryAnalysisBaseUrl: z.string().default('http://127.0.0.1:8012'),
  queryAnalysisDeadlineMs: z.number().step(1).min(100).default(5_000),
  retrievalPolicyBaseUrl: z.string().default('http://127.0.0.1:8012'),
  retrievalPolicyDeadlineMs: z.number().step(1).min(100).default(5_000),
})

/** Cordis plugin entry: install one application service and its DSH extensions. */
export function apply(ctx: Context, config: Config = {}): void {
  const application = new RetrievalAgentService(ctx, config)
  installAutomaticRetrievalStart(ctx, application, {
    analyzer: new SpacyQueryAnalyzer({
      baseUrl: config.queryAnalysisBaseUrl ?? 'http://127.0.0.1:8012',
      deadlineMs: config.queryAnalysisDeadlineMs ?? 5_000,
    }),
  })
  installRetrievalTools(ctx, application, { maxFinishReminders: config.maxFinishReminders ?? 3 })
  installRetrievalRuntimeBudget(ctx, application)
  installRetrievalPresentationAnchors(ctx, application)
}
