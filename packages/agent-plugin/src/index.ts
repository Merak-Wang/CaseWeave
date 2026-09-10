import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SpacyQueryAnalyzer } from '@retrieval-agent/query-understanding'
import { installRetrievalRuntimeBudget } from './context-budget.js'
import { installAutomaticRetrievalStart } from './pre-step.js'
import { installRetrievalPresentationAnchors } from './presentation.js'
import { RetrievalAgentService, type RetrievalAgentServiceConfig } from './service.js'
import { installRetrievalTools } from './tools.js'
import { DurableRetrievalAgentService } from './durable-service.js'
import { MySqlTaskStore } from './task-store.js'
import { ExpertCoordinator } from './experts.js'
import { installWorkingContext } from './working-context.js'
import { WikiLearningService } from './wiki-learning.js'
export * from './wiki-learning.js'
export * from './experts.js'
export * from './working-context.js'
export * from './task-store.js'
export * from './durable-service.js'
export * from './task-worker.js'

export * from './compact.js'
export * from './context-budget.js'
export * from './provider-services.js'
export * from './pre-step.js'
export * from './presentation.js'
export * from './service.js'
export * from './session-journal.js'
export * from './tools.js'

export const name = 'retrieval-agent'
export const inject = ['agents', 'llm', 'tokenMeter', 'ticketRetrievalProvider', 'ticketPrincipalProvider', 'tools', 'systemPrompt']

export interface Config extends RetrievalAgentServiceConfig {
  readonly taskPersistence?: 'session' | 'mysql'
  readonly mysqlUrl?: string
  readonly queryAnalysisBaseUrl?: string
  readonly queryAnalysisDeadlineMs?: number
  readonly wikiRoot?: string
  readonly wikiLearning?: boolean
}

export const Config: z<Config> = z.object({
  taskPersistence: z.union(['session', 'mysql'] as const).default('session'),
  mysqlUrl: z.string(),
  wikiRoot: z.string(),
  wikiLearning: z.boolean().default(true),
  maxSearches: z.number().step(1).min(1).default(2_500),
  maxRepeatedToolErrors: z.number().step(1).min(1),
  searchTopK: z.number().step(1).min(1).max(50).default(20),
  searchMaxScan: z.number().step(1).min(1).default(50_000),
  contextTokenBudget: z.number().step(1).min(1),
  maxContextTokens: z.number().step(1).min(1),
  queryAnalysisBaseUrl: z.string().default('http://127.0.0.1:8012'),
  queryAnalysisDeadlineMs: z.number().step(1).min(100).default(5_000),
})

/** Cordis plugin entry: install one application service and its DSH extensions. */
export { MySqlDeliveryStore, type DeliverySpec, type DeliveryRecord } from './delivery-store.js'
export { callReportModel } from './report-model.js'

export function apply(ctx: Context, config: Config = {}): void {
  const store = config.taskPersistence === 'mysql' ? new MySqlTaskStore(config.mysqlUrl, Boolean(config.wikiRoot) && config.wikiLearning !== false) : undefined
  if (store) ctx.effect(() => () => store.close())
  const application = store ? new DurableRetrievalAgentService(ctx, config, store) : new RetrievalAgentService(ctx, config)
  new ExpertCoordinator(ctx, application, config.wikiRoot)
  if (application instanceof DurableRetrievalAgentService && config.wikiRoot && config.wikiLearning !== false) new WikiLearningService(ctx, application, config.wikiRoot)
  installAutomaticRetrievalStart(ctx, application, {
    analyzer: new SpacyQueryAnalyzer({
      baseUrl: config.queryAnalysisBaseUrl ?? 'http://127.0.0.1:8012',
      deadlineMs: config.queryAnalysisDeadlineMs ?? 5_000,
    }),
  })
  installRetrievalTools(ctx, application)
  installWorkingContext(ctx, application)
  installRetrievalRuntimeBudget(ctx, application)
  installRetrievalPresentationAnchors(ctx, application)
}
