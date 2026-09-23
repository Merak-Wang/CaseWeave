import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RetrievalState, TicketSearchPage, TicketSearchProgress } from '@retrieval-agent/contracts'
import { SemanticOperators } from './semantic-operators.js'

it('starts sample learning while recall is unfinished and never drains the body cursor', async () => {
  const events: string[] = []
  let state = { retrievalId: 't', inputGeneration: 0, snapshot: { snapshotId: 's' }, candidates: [], budget: {},
    query: { original: '宽带到期扣费', spec: { mode: 'dense' }, contract: { semanticPlan: {
      keywords: ['宽带', '到期'], retrieval_expressions: ['包年变包月'], goal: { mode: 'all' },
    } } } } as unknown as RetrievalState
  const page = { snapshotId: 's', candidates: [{ ref: 'seed' }], nextCursor: 'thousands-of-body-pages', warnings: [],
    trace: { channels: [{ channel: 'keyword', resultCount: 5474 }, { channel: 'vector', resultCount: 260 }] } } as unknown as TicketSearchPage
  let began!: () => void, finish!: () => void
  const started = new Promise<void>(r => { began = r }), finished = new Promise<void>(r => { finish = r })
  const search = vi.fn(async (_principal, _snapshot, spec, options) => {
    expect(spec.mode).toBe('hybrid')
    expect(spec.semanticHints).toEqual(['包年变包月'])
    await options.onProgress({ page, channels: [{ channel: 'keyword', status: 'running', count: 500 }], timings: {} })
    await started
    events.push('recall completed'); finish()
    return page
  })
  const operator = Object.assign(Object.create(SemanticOperators.prototype), {
    ctx: { ticketRetrievalProvider: { search } }, filterConfig: {},
    application: {
      current: () => state, principal: async () => ({}), searchMaxScan: 50000,
      recordDiscovery: async (_agent: Agent, _generation: number, _spec: unknown, progress: TicketSearchProgress) => {
        state = { ...state, candidates: progress.page.candidates }
      }, recordSemanticSearch: async () => state,
    }, ensurePlan: async () => state,
    filter: vi.fn(async () => { events.push('sample learning started'); began(); await finished; return state }),
  }) as SemanticOperators
  await operator.searchAndFilter({} as Agent)
  expect(events).toEqual(['sample learning started', 'recall completed'])
  expect(search).toHaveBeenCalledTimes(1)
  expect(operator.filter).toHaveBeenCalledTimes(1)
})

it('settles learning when the recall branch fails instead of leaving an orphan model job', async () => {
  const state = { query: { contract: { semanticPlan: { goal: { mode: 'all' } } } } } as RetrievalState
  let cancelled = false
  const failure = new Error('source unavailable')
  const operator = Object.assign(Object.create(SemanticOperators.prototype), {
    filterConfig: {}, ensurePlan: async () => state,
    discoverPlanned: async (_agent: Agent, _signal: AbortSignal, first: () => void) => { first(); throw failure },
    filter: async (_agent: Agent, _refs: unknown, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
    }),
  }) as SemanticOperators
  await expect(operator.searchAndFilter({} as Agent)).rejects.toBe(failure)
  expect(cancelled).toBe(true)
})
