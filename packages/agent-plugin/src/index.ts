import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RetrievalAgentService, type RetrievalAgentServiceConfig } from './service.js'
import { installRetrievalTools } from './tools.js'

export * from './compact.js'
export * from './provider-services.js'
export * from './service.js'
export * from './session-journal.js'
export * from './tools.js'

export const name = 'retrieval-agent'
export const inject = ['ticketRetrievalProvider', 'ticketPrincipalProvider', 'tools', 'systemPrompt']

export interface Config extends RetrievalAgentServiceConfig {
  readonly maxFinishReminders?: number
}

export const Config: z<Config> = z.object({
  maxRounds: z.number().step(1).min(2).default(8),
  maxSearches: z.number().step(1).min(1).default(4),
  maxPromotions: z.number().step(1).min(1).default(3),
  maxEvidenceTokens: z.number().step(1).min(1).default(1_500),
  maxLatencyMs: z.number().step(1).min(100).default(120_000),
  noProgressLimit: z.number().step(1).min(1).default(2),
  searchTopK: z.number().step(1).min(1).max(50).default(8),
  searchMaxScan: z.number().step(1).min(1).default(50_000),
  contextTokenBudget: z.number().step(1).min(1).default(1_500),
  maxFinishReminders: z.number().step(1).min(0).default(3),
})

/** Cordis plugin entry: install one application service and its DSH extensions. */
export function apply(ctx: Context, config: Config = {}): void {
  const application = new RetrievalAgentService(ctx, config)
  installRetrievalTools(ctx, application, { maxFinishReminders: config.maxFinishReminders ?? 3 })
}
