import { Context } from '@deepseek-ai/cordis'
import { RetrievalError } from '@retrieval-agent/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContextManifest, RetrievalDecision, RetrievalState, SemanticQueryPlan, TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider, normalizeFixtureTicket } from '@retrieval-agent/provider-local'
import { RetrievalController } from '../../domain/src/controller.js'
import { InMemoryRetrievalEventJournal } from '../../domain/src/journal.js'
import { createTicketResultCollection } from '../../domain/src/result.js'
import { buildSemanticTicketRequest } from '../../query-understanding/src/semantic-request.js'
import { runFixedRetrieval } from './fixed-retrieval.js'
import { executeTaskJob } from './task-worker.js'
import { RetrievalAgentService } from './service.js'
import { DurableRetrievalAgentService } from './durable-service.js'
import type { MySqlTaskStore, TaskJob, TaskRecord } from './task-store.js'
import { fixtureQueryAnalyzer } from '../../../tests/support/query-analyzer.js'
import { testHybridRanker } from '../../../tests/support/fake-model-gateway.js'

const NOW = new Date('2026-10-08T00:00:00Z')
const principal: TrustedPrincipalContext = { tenantId: 'synthetic-fixed', subjectId: 'reader',
  entitlementVersion: 'v1', purpose: 'ticket_retrieval', attributes: {}, issuedAt: NOW.toISOString() }
const agent = {} as Agent

// Only the external semantic operator is doubled. Controller, journal, provider,
// judgment admission, result freezing and worker dispatch are real consumers.
async function fixture(labels: readonly ('accept' | 'exclude' | 'undetermined')[] = ['accept', 'exclude', 'exclude']) {
  let serial = 0
  const journal = new InMemoryRetrievalEventJournal({ now: () => NOW, eventId: () => 'fixed-event-' + serial++ })
  const provider = new LocalTicketProvider(labels.map((_, i) => normalizeFixtureTicket({
    ticketId: 'synthetic-' + i, displayId: 'FIX-' + i, tenantId: principal.tenantId, allowedSubjectIds: [], requiredAttributes: {},
    sourceVersion: 'synthetic-v1', title: '副卡 synthetic ' + i, summary: 'Explicit synthetic fixture ' + i,
    conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable',
  })), { now: () => NOW, ranker: testHybridRanker() })
  const initialPlanner = vi.fn(async (state: RetrievalState) => {
    const plan: SemanticQueryPlan = { schemaVersion: 1, original: state.query.original, instruction: '合成范围判据',
      keywords: ['副卡'], retrieval_expressions: ['副卡'], structured_conditions: [],
      goal: { mode: 'all', count: null }, steps: [{ id: 'filter', op: 'sem_filter', inputs: ['$source'],
        instruction: '合成范围判据', params: { require_source: false, required_fields: [] } }],
      manifest_id: 'synthetic-plan-receipt', inputGeneration: state.inputGeneration ?? 0 }
    const manifest: ContextManifest = { id: 'synthetic-plan-context', roleId: 'operator:query_plan', stateId: state.stateId,
      inputGeneration: state.inputGeneration ?? 0, candidateRefs: [], evidenceIds: [], evidenceSpans: [], knowledgeRefs: [],
      renderedHash: 'synthetic-rendered-hash', estimatedTokens: 1, measurement: 'dsh_request',
      operator: { operation: 'query_plan', pythonManifestId: plan.manifest_id, records: [], knowledgeIds: [] } }
    return { plan, manifests: [manifest] }
  })
  const controller = new RetrievalController(provider, journal, undefined, { now: () => NOW,
    id: () => 'fixed-domain-' + serial++, initialPlanner })
  let state = await controller.start(principal, buildSemanticTicketRequest('找全部副卡工单',
    { orchestration: 'fixed', onlineLearning: false, semanticMethod: 'auto' }))
  const recallSpec = provider.resolve({ target: 'ranked_cases', query: state.query.contract!.semanticPlan!.keywords.join(' '), mode: 'hybrid' })
  const page = await provider.search(principal, state.snapshot!.snapshotId, recallSpec,
    { topK: 10, maxScan: 10, stage: 'initial_hybrid' })
  expect(page.returned).toBe(labels.length)
  state = controller.recordDiscovery(state, state.inputGeneration ?? 0, recallSpec,
    { page, channels: [{ channel: 'keyword', status: 'completed', count: page.returned },
      { channel: 'vector', status: 'completed', count: page.returned }], timings: {} }, true)
  state = controller.recordContextSelection(state, controller.projectContext(state))
  state = await controller.decide(principal, state, { stateId: state.stateId,
    judgments: state.candidates.map((c, i) => ({ candidateRef: c.ref, verdict: labels[i]!, evidenceRefs: [c.ref],
      basis: labels[i] === 'undetermined' ? 'unresolved' : 'model', reason: 'Explicit synthetic assessment' })),
    gaps: [], action: { kind: 'inspect', candidateRefs: state.candidates.map(c => c.ref), fields: ['summary'] } })
  const searchAndFilter = vi.fn(async () => state)
  const decide = vi.fn(async (_agent: Agent, decision: RetrievalDecision, signal?: AbortSignal) => {
    state = await controller.decide(principal, state, decision, signal)
    return state
  })
  const stopIncomplete = vi.fn(async (_agent: Agent, reason: string) => {
    state = controller.stopIncomplete(state, reason)
    return state
  })
  const application = { operators: { searchAndFilter }, current: () => state, currentOrUndefined: () => state,
    decide, stopIncomplete, withJob: async (_agent: Agent, _job: TaskJob, work: () => Promise<void>) => work(),
    loadTask: async () => {}, ensureModelAccess: async () => state } as unknown as RetrievalAgentService
  const learning = (overrides: Record<string, unknown> = {}) => {
    state = controller.recordOperatorUsage(state, state.inputGeneration ?? 0, { learning: {
      input_revision: state.inputGeneration ?? 0, regime: 'frozen_teacher', stop_reason: 'frozen_completed',
      online_feedback_training: false, fit_count: 0, complete_scope_coverage: true,
      scope_records: labels.length, unresolved: labels.filter(v => v === 'undetermined').length,
      task_semantics: 'recall_candidate_scope', ...overrides } })
  }
  return { provider, controller, journal, initialPlanner, application, searchAndFilter, decide, stopIncomplete, learning,
    current: () => state, replace: (value: RetrievalState) => { state = value } }
}

describe('fixed retrieval through controller admission', () => {
  it('finishes the observed frozen scope once and a repeated delivery is a no-op', async () => {
    const f = await fixture(); f.learning()
    const finished = await runFixedRetrieval(f.application, agent)
    expect(finished.termination).toBe('top_k_accepted')
    expect(createTicketResultCollection(finished).tickets).toHaveLength(1)
    expect(f.initialPlanner).toHaveBeenCalledTimes(1)
    expect(f.searchAndFilter).toHaveBeenCalledTimes(1)
    expect(f.decide).toHaveBeenCalledTimes(1)
    expect(await runFixedRetrieval(f.application, agent)).toBe(finished)
    expect(f.searchAndFilter).toHaveBeenCalledTimes(1)
    expect(f.decide).toHaveBeenCalledTimes(1)
  })

  it('stops an unchanged coverage continuation after two passes instead of looping', async () => {
    const f = await fixture()
    f.learning({ stop_reason: 'needs_coverage', discovery_remaining_records: 1 })
    const state = await runFixedRetrieval(f.application, agent)
    expect(state.termination).toBe('partial')
    expect(state.stopExplanation).toContain('续跑未产生进展')
    expect(f.searchAndFilter).toHaveBeenCalledTimes(2)
    expect(f.stopIncomplete).toHaveBeenCalledTimes(1)
    expect(f.decide).not.toHaveBeenCalled()
  })

  it('an unknown result freezes only admitted positives as incomplete', async () => {
    const f = await fixture(['accept', 'exclude', 'undetermined']); f.learning()
    const state = await runFixedRetrieval(f.application, agent)
    const value = createTicketResultCollection(state)
    expect(value.complete).toBe(false)
    expect(value.stoppingReason).toBe('partial')
    expect(value.tickets).toHaveLength(1)
    expect(value.judgments.every(j => j.verdict === 'accept')).toBe(true)
    expect(state.judgments?.some(j => j.verdict === 'undetermined')).toBe(true)
    expect(state.stopExplanation).toContain('1 条不确定')
  })

  it.each([
    { fit_count: 1 }, { online_feedback_training: true }, { complete_scope_coverage: false },
    { scope_records: 2 }, { scope_records: 3.5 }, { input_revision: 99 }, { unresolved: 1 }, { regime: 'active' },
  ])('does not admit an invalid frozen completion receipt %j', async (invalid) => {
    const f = await fixture(); f.learning(invalid)
    const state = await runFixedRetrieval(f.application, agent)
    expect(state.termination).toBe('partial')
    expect(createTicketResultCollection(state).complete).toBe(false)
    expect(f.stopIncomplete).toHaveBeenCalledTimes(1)
  })

  it('a cancelled run makes no operator call, and resume keeps the original intent plan', async () => {
    const f = await fixture(); f.learning()
    f.replace(f.controller.stop(f.current(), 'cancelled'))
    const abort = new AbortController(); abort.abort()
    await expect(runFixedRetrieval(f.application, agent, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.searchAndFilter).not.toHaveBeenCalled()
    const generation = f.current().inputGeneration
    const manifest = f.current().query.contract!.semanticPlan!.manifest_id
    f.replace(f.controller.resume(f.current()))
    const resumed = await runFixedRetrieval(f.application, agent, new AbortController().signal)
    expect(resumed.termination).toBe('top_k_accepted')
    expect(resumed.inputGeneration).toBe(generation)
    expect(resumed.query.contract!.semanticPlan!.manifest_id).toBe(manifest)
    expect(f.initialPlanner).toHaveBeenCalledTimes(1)
  })

  it('cancellation during an operator prevents finish admission', async () => {
    const f = await fixture(); f.learning()
    const abort = new AbortController()
    f.searchAndFilter.mockImplementationOnce(async () => {
      f.replace(f.controller.stop(f.current(), 'cancelled')); abort.abort(); return f.current()
    })
    await expect(runFixedRetrieval(f.application, agent, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.current().termination).toBe('cancelled')
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.stopIncomplete).not.toHaveBeenCalled()
  })

  it('the real fixed worker dispatch never starts the ordinary Agent loop', async () => {
    const f = await fixture(); f.learning()
    const workerAgent = { whenIdle: vi.fn(() => { throw new Error('ordinary loop must not run') }),
      followup: vi.fn(() => { throw new Error('ordinary loop must not run') }) } as unknown as Agent
    const job: TaskJob = { id: 'synthetic-job', task_id: 'synthetic-task', kind: 'fixed',
      input_revision: 0, fence: 1, owner: 'synthetic-worker', attempts: 1, status: 'running' }
    await executeTaskJob(f.application as DurableRetrievalAgentService, workerAgent, job,
      fixtureQueryAnalyzer(['副卡']), new AbortController().signal)
    expect(f.current().termination).toBe('top_k_accepted')
    expect(workerAgent.followup).not.toHaveBeenCalled()
    expect(workerAgent.whenIdle).not.toHaveBeenCalled()
  })
})

describe('fixed execution generation and terminal fencing', () => {
  it('returns a newer input generation after an old operator resumes, without partial stopping it', async () => {
    const f = await fixture(); f.learning()
    f.searchAndFilter.mockImplementationOnce(async () => {
      f.replace(f.controller.acceptUserInformation(f.current(), { accepted: true, answer: '只看已办理完成的工单' }))
      return f.current()
    })
    const expectedGeneration = f.current().inputGeneration
    const latest = await runFixedRetrieval(f.application, agent)
    expect(latest).toBe(f.current())
    expect(latest.inputGeneration).toBe((expectedGeneration ?? 0) + 1)
    expect(latest.phase).not.toBe('stopped')
    expect(f.stopIncomplete).not.toHaveBeenCalled()
    expect(f.decide).not.toHaveBeenCalled()
  })

  it('a stale finish rejection returns the new generation instead of converting it to partial', async () => {
    const f = await fixture(); f.learning()
    f.decide.mockImplementationOnce(async () => {
      f.replace(f.controller.acceptUserInformation(f.current(), { accepted: true, answer: '排除纯咨询' }))
      throw new RetrievalError('INVALID_TRANSITION', 'synthetic stale admission')
    })
    const latest = await runFixedRetrieval(f.application, agent)
    expect(latest.inputGeneration).toBe(1)
    expect(latest.phase).not.toBe('stopped')
    expect(f.stopIncomplete).not.toHaveBeenCalled()
  })

  it('a retryable stale finish error propagates without recording a partial result', async () => {
    const f = await fixture(); f.learning()
    const stale = new RetrievalError('INVALID_TRANSITION', 'synthetic retryable fence', { retryable: true })
    f.decide.mockRejectedValueOnce(stale)
    await expect(runFixedRetrieval(f.application, agent)).rejects.toBe(stale)
    expect(f.current().phase).not.toBe('stopped')
    expect(f.stopIncomplete).not.toHaveBeenCalled()
  })

  it.each(['new_generation', 'cancelled'] as const)('real Service checks %s inside the mutation queue', async reason => {
    const f = await fixture()
    const service = new RetrievalAgentService(new Context(), { now: () => NOW })
    let release!: () => void
    const block = new Promise<void>(resolve => { release = resolve })
    const slot = { controller: f.controller, journal: f.journal, state: f.current(), mutationTail: block }
    // Seed a Controller-validated task; the actual public Service method and mutex run unmodified.
    const active = (service as unknown as { active: WeakMap<Agent, typeof slot> }).active
    active.set(agent, slot)
    const old = slot.state
    const pending = service.stopIncomplete(agent, 'late old-worker result', old)
    slot.state = reason === 'new_generation'
      ? f.controller.acceptUserInformation(slot.state, { accepted: true, answer: '排除纯咨询' })
      : f.controller.stop(slot.state, 'cancelled')
    const latest = slot.state
    release()
    expect(await pending).toBe(latest)
    expect(service.current(agent)).toBe(latest)
    expect(reason === 'cancelled' ? latest.termination : latest.phase).toBe(reason === 'cancelled' ? 'cancelled' : 'assessed')
  })
})

// The Durable public path and its execute/executeCurrent mutation lock are real.
// Only TaskStore persistence and Session outbox I/O are doubled; no pool is constructed.
async function durableFixture() {
  const f = await fixture()
  const workerAgent = { session: { id: 'synthetic-durable-session' } } as unknown as Agent
  const row: TaskRecord = { id: f.current().retrievalId, session_id: String(workerAgent.session.id),
    owner_hash: 'synthetic-owner', original_query: f.current().query.original, event_seq: 0,
    input_revision: f.current().inputGeneration ?? 0, semantic_revision: 0, query_revision: 0,
    state_json: f.current(), failure: null, created_at: NOW }
  const forSession = vi.fn(async () => row)
  const commit = vi.fn(async (_base: TaskRecord, state: RetrievalState, events: readonly unknown[]) => {
    row.state_json = state
    row.input_revision = state.inputGeneration ?? 0
    row.event_seq += events.length
    return row
  })
  const store = { forSession, domainEventCount: vi.fn(async () => 0), commit,
    semanticResults: undefined } as unknown as MySqlTaskStore
  const ctx = new Context()
  Object.assign(ctx, { ticketRetrievalProvider: f.provider })
  const service = new DurableRetrievalAgentService(ctx, { now: () => NOW }, store)
  vi.spyOn(service, 'mirror').mockResolvedValue(undefined)
  const internals = service as unknown as {
    states: WeakMap<Agent, TaskRecord>; mutations: WeakMap<Agent, Promise<void>>
  }
  internals.states.set(workerAgent, row)
  return { f, service, workerAgent, row, internals, forSession, commit }
}

describe('Durable fixed continuation admission with persistence I/O doubled', () => {
  it.each(['new_generation', 'cancelled', 'new_retrieval'] as const)(
    're-reads %s after the actual Durable mutation lock and does not commit an old partial result', async reason => {
      const d = await durableFixture()
      let release!: () => void
      const block = new Promise<void>(resolve => { release = resolve })
      d.internals.mutations.set(d.workerAgent, block)
      const old = d.row.state_json!
      const pending = d.service.stopIncomplete(d.workerAgent, 'old execution cannot finish', old)
      await Promise.resolve()
      expect(d.forSession).not.toHaveBeenCalled()
      const latest = reason === 'new_generation'
        ? d.f.controller.acceptUserInformation(old, { accepted: true, answer: '排除纯咨询' })
        : reason === 'cancelled' ? d.f.controller.stop(old, 'cancelled')
        : await d.f.controller.start(principal, buildSemanticTicketRequest('新的副卡检索',
          { orchestration: 'fixed', onlineLearning: false, semanticMethod: 'auto' }))
      d.row.id = latest.retrievalId
      d.row.state_json = latest
      d.row.input_revision = latest.inputGeneration ?? 0
      release()
      expect(await pending).toBe(latest)
      expect(d.service.current(d.workerAgent)).toBe(latest)
      expect(d.forSession).toHaveBeenCalledTimes(1)
      expect(d.commit).not.toHaveBeenCalled()
      if (reason === 'new_generation') expect(latest.inputGeneration).toBe((old.inputGeneration ?? 0) + 1)
      if (reason === 'cancelled') expect(latest.termination).toBe('cancelled')
      if (reason === 'new_retrieval') expect(latest.retrievalId).not.toBe(old.retrievalId)
    })

  it('still commits an authorized partial result for the current active generation', async () => {
    const d = await durableFixture()
    const expected = d.row.state_json!
    const stopped = await d.service.stopIncomplete(d.workerAgent, 'synthetic no-progress ceiling', expected)
    expect(stopped.termination).toBe('partial')
    expect(stopped.stopExplanation).toBe('synthetic no-progress ceiling')
    expect(stopped.inputGeneration).toBe(expected.inputGeneration)
    expect(createTicketResultCollection(stopped).complete).toBe(false)
    expect(createTicketResultCollection(stopped).tickets).toHaveLength(1)
    expect(d.commit).toHaveBeenCalledTimes(1)
    expect(d.commit.mock.calls[0]![2].length).toBeGreaterThan(0)
    expect(d.service.current(d.workerAgent)).toBe(stopped)
  })
})