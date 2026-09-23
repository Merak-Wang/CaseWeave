import { describe, expect, it } from 'vitest'
import type { RetrievalState, RuntimeMetrics } from '@retrieval-agent/contracts'
import { projectUsage, projectContext } from './orchestration-metrics.js'
import { runtimeMetricsText } from './workbench-metrics.js'

const metrics = (output: number, time: number): RuntimeMetrics => ({
  tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: output },
  sessionStats: { turns: 1, steps: 1, llmMs: time + 100, toolMs: 0, ttftMs: 100, ttftSteps: 1, decodeMs: time, decodeTokens: output },
})
const state = () => ({ inputGeneration: 1, expertTasks: [{ id: 'e', inputGeneration: 0, domainId: 'old', modelSteps: 1, runtimeMetrics: metrics(40, 1000) }],
  budget: { modelStepsUsed: 1, totalOutputTokens: 20, runtimeMetrics: metrics(20, 1000), operatorUsage: { llm_adapter_calls: 1, reported_completion_tokens: 60, reported_prompt_tokens: 350 },
    context: { estimatedInputTokens: 8000, measuredInputTokens: 9000, limit: 10000, reservedTokens: 512, compactionCount: 0 } },
  contextManifests: [{ inputGeneration: 1, measurement: 'dsh_request', operator: { pythonManifestId: 'm', operation: 'sem_filter' }, runtimeMetrics: metrics(60, 3000) }],
}) as unknown as RetrievalState

describe('workbench official runtime metrics', () => {
  it('uses official usage and weighted speed, retaining previous-generation experts and deduplicating cached operator receipts', () => {
    const s = state(), runtime = { main: metrics(20, 1000), experts: {}, compression: { workingSetCount: 1, capacityCount: 0 } }
    const usage = projectUsage({ ...s, contextManifests: [...s.contextManifests!, ...s.contextManifests!] }, runtime)
    expect(usage).toMatchObject({ outputTokens: 120, inputTokens: 1050, speed: { tokensPerSecond: 24, firstTokenMs: 100, measuredSteps: 3 } })
    expect(projectUsage(JSON.parse(JSON.stringify(s)), runtime)).toEqual(usage)
    expect(projectUsage(JSON.parse(JSON.stringify(s)))).toEqual(usage)
    const display = runtimeMetricsText(undefined, usage)
    expect(display.outputLabel).toContain('24.0 tokens/s')
    expect(display.usageDescription).toContain('缓存读取 200')
  })
  it('shows projected occupancy after compaction, keeps operator windows independent, and leaves missing speed unknown', () => {
    const s = state(), runtime = { main: { ...metrics(20, 0), contextPressure: { pressureTokens: 9000, projectedTokens: 2000, contextWindow: 10000 } },
      experts: {}, compression: { workingSetCount: 1, capacityCount: 0, dshCount: 2, dshFailures: 1, dshActive: true } }
    const view = runtimeMetricsText(projectContext(s, runtime), undefined)
    expect(view.label).toBe('20%')
    expect(view.description).toContain('上次请求实际输入 9,000')
    expect(view.description).toContain('DSH 历史压缩 2 次 · 正在压缩 · 未完成 1 次')
    expect(projectContext({ ...s, operatorActivity: { inputGeneration: 1, operation: 'sem_filter', status: 'running', at: '' } }, runtime)).not.toHaveProperty('projectedInputTokens')
    const { runtimeMetrics, ...legacyBudget } = s.budget!
    const usage = projectUsage({ ...s, budget: legacyBudget, expertTasks: [], contextManifests: [] })
    expect(usage.speed.tokensPerSecond).toBeNull()
    expect(runtimeMetricsText(undefined, usage).usageDescription).toContain('生成速度：待计量')
  })
})
