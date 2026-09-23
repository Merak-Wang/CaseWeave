import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RetrievalState, TicketSearchPage, TicketSearchProgress } from '@retrieval-agent/contracts'
import { SemanticOperators } from './semantic-operators.js'

function harness(search: (options: { onProgress: (value: TicketSearchProgress) => Promise<void> }) => Promise<TicketSearchPage>) {
  let state = {
    retrievalId: 't', inputGeneration: 0, snapshot: { snapshotId: 's', authorizationVersion: 1 },
    candidates: [], selectedCandidateRefs: [], excludedCandidateRefs: [], judgments: [], promotedEvidence: [],
    budget: { operatorUsage: {} }, query: { original: '宽带到期扣费', spec: { mode: 'dense' }, confirmedConstraints: [],
      contract: { semanticPlan: { keywords: ['宽带', '到期'], retrieval_expressions: ['包年变包月'], goal: { mode: 'all' }, steps: [] } } },
  } as unknown as RetrievalState
  const partial = { snapshotId: 's', candidates: [{ ref: 'seed' }], nextCursor: 'body-pages-remain', recallScope: 'union-v1',
    warnings: [], trace: { channels: [{ channel: 'keyword', resultCount: 5474 }, { channel: 'vector', resultCount: 260 }] } } as unknown as TicketSearchPage
  const provider = {
    search: vi.fn(async (_principal: unknown, _snapshotId: string, spec: Record<string, unknown>, options: { onProgress: (value: TicketSearchProgress) => Promise<void> }) => {
      expect(spec.mode).toBe('hybrid')
      expect(spec.semanticHints).toEqual(['包年变包月'])
      await options.onProgress({ page: partial, channels: [{ channel: 'keyword', status: 'running', count: 500 }], timings: {} })
      return search(options)
    }),
    featureBlock: vi.fn(async () => ({ ids: [], dense: '', dimensions: 0, available: '', feature_id: 'union-feature' })),
    resolveFeatureIds: vi.fn(async () => []),
  }
  const learningRuns: Array<{ op: string; params: Record<string, unknown> }> = []
  const application = {
    current: () => state,
    ensureModelAccess: vi.fn(async () => {}),
    principal: vi.fn(async () => ({})),
    recordDiscovery: vi.fn(async (_agent: Agent, _generation: number, _spec: unknown, progress: TicketSearchProgress, complete = false) => {
      state = { ...state, candidates: progress.page.candidates,
        searchProgress: { channels: progress.channels } as unknown as RetrievalState['searchProgress'],
        ...(complete ? { lastPage: progress.page } : {}) }
      return state
    }),
    recordSemanticSearch: vi.fn(async (_agent: Agent, key: string) => {
      state = { ...state, semanticSearchKeys: [...(state.semanticSearchKeys ?? []), key] }
      return state
    }),
    constrainRecallCandidates: vi.fn(async () => state),
    recordOperatorUsage: vi.fn(async (_agent: Agent, _generation: number, usage: Record<string, unknown>) => {
      state = { ...state, budget: { ...state.budget, operatorUsage: { ...state.budget.operatorUsage, ...usage } } }
      return state
    }),
    stopIncomplete: vi.fn(async () => state),
    reviewBatchSize: 8,
  }
  const operator = Object.assign(Object.create(SemanticOperators.prototype), {
    ctx: { ticketRetrievalProvider: provider }, application, filterConfig: {},
    ensurePlan: async () => state,
    config: () => ({ provider: 'fixture', model: 'fixture', contextWindow: 32000 }),
    // 仅替换 Python 执行入口，召回范围仍由真实 filter 组装并传入。
    run: async (_agent: Agent, input: { op: string; params: Record<string, unknown> }) => {
      learningRuns.push(input)
      return { llm_adapter_calls: 0 }
    },
  }) as SemanticOperators
  return { operator, provider, application, learningRuns, state: () => state }
}

it('shows partial recall progress but starts learning only after complete union, without draining body pages', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let progressWritten!: () => void
  const progress = new Promise<void>(resolve => { progressWritten = resolve })
  const finalPage = { snapshotId: 's', candidates: [{ ref: 'seed' }, { ref: 'vector-hit' }], nextCursor: 'body-pages-remain',
    recallScope: 'union-v1', warnings: [],
    trace: { channels: [{ channel: 'keyword', resultCount: 5474 }, { channel: 'vector', resultCount: 260 }] } } as unknown as TicketSearchPage
  const fixture = harness(async () => { await gate; return finalPage })
  const recordProgress = fixture.application.recordDiscovery
  fixture.application.recordDiscovery = vi.fn(async (...args) => {
    const result = await recordProgress(...args)
    progressWritten()
    return result
  })

  const pending = fixture.operator.searchAndFilter({} as Agent)
  await progress
  expect(fixture.learningRuns).toHaveLength(0)
  expect(fixture.provider.featureBlock).not.toHaveBeenCalled()
  expect(fixture.application.recordDiscovery).toHaveBeenCalledTimes(1)
  release()
  await pending

  expect(fixture.provider.search).toHaveBeenCalledTimes(1)
  expect(fixture.provider.featureBlock).toHaveBeenCalledWith({}, expect.objectContaining({ recallScope: 'union-v1' }), expect.anything())
  expect(fixture.learningRuns).toHaveLength(1)
  expect(fixture.learningRuns[0]).toMatchObject({ op: 'sem_filter', params: { recall_scope_key: 'union-v1', scope_mode: 'full' } })
})

it('does not start numerical learning when the complete recall request fails', async () => {
  const failure = new Error('source unavailable')
  const fixture = harness(async () => { throw failure })

  await expect(fixture.operator.searchAndFilter({} as Agent)).rejects.toBe(failure)
  expect(fixture.application.recordDiscovery).toHaveBeenCalledTimes(1) // 失败前的召回进度仍可展示。
  expect(fixture.learningRuns).toHaveLength(0)
  expect(fixture.provider.featureBlock).not.toHaveBeenCalled()
})
