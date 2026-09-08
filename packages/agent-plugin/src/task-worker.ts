import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RetrievalError } from '@retrieval-agent/contracts'
import { buildFastTicketRequest, type TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'
import type { DurableRetrievalAgentService } from './durable-service.js'
import type { TaskJob } from './task-store.js'
import { compactRetrievalSurface } from './working-context.js'

/** Drives the installed DSH loop. Page connections and subscriptions never own this lifetime. */
export async function executeTaskJob(application: DurableRetrievalAgentService, agent: Agent, job: TaskJob,
  analyzer: TicketQueryAnalyzer, signal: AbortSignal): Promise<void> {
  await application.withJob(agent, job, async () => {
    await application.loadTask(agent)
    const task = (await application.store.read(job.task_id))!
    if (job.kind === 'learn' || job.kind === 'unlearn' || job.kind === 'source_check') {
      if (!application.learning) throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Wiki 学习服务尚未装配，作业保留供恢复。', { retryable: true })
      await application.learning.run(agent, job, signal)
      return
    }
    if (job.kind === 'page') {
      let state = task.state_json
      while (state?.phase === 'awaiting_clarification' && state.lastPage?.nextCursor) {
        signal.throwIfAborted()
        state = await application.continueIndependentPage(agent, signal)
      }
      return
    }
    if (job.kind === 'search') {
      // The final state may already be committed when a process dies before settling its job.
      if (job.attempts > 1 && task.state_json?.lastPage && task.state_json.phase !== 'snapshot_opened'
        && task.state_json.termination !== 'backend_error' && !task.state_json.searchProgress?.channels.some(c => c.status === 'running')) return
      const state = task.state_json ? await application.refresh(agent, signal)
        : await application.start(agent, await buildFastTicketRequest(task.original_query, { analyzer, signal }), signal)
      if (state.termination === 'backend_error') throw new RetrievalError('PROVIDER_UNAVAILABLE', state.stopExplanation ?? '检索来源暂时不可用。', { retryable: true })
      return
    }
    const state = await application.ensureModelAccess(agent, signal)
    if (!state || state.phase === 'stopped') return
    if (state.phase === 'awaiting_clarification') {
      // A replacement worker resumes unfinished independent branches with its new lease.
      // The main question stays pending; do not create another main-model turn.
      await application.coordinator?.runPending(agent, signal)
      await application.coordinator?.settlePending?.(agent, signal)
      return
    }
    await agent.whenIdle()
    signal.throwIfAborted()
    // A new durable turn must not carry the last turn's now-invalid expert findings,
    // decisions or tool errors as its most recent exchange. SQL retains all facts and
    // feedback; the following authoritative window reintroduces currently usable evidence.
    compactRetrievalSurface(agent, { freshTurn: true })
    const selection = await application.projectContext(agent)
    const abort = (): void => {
      // The main loop may already be idle at a question while its children still run.
      application.coordinator?.cancelPending?.(agent)
      agent.cancel({ kind: 'hook', reason: '任务输入或后台执行权已变化。' })
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      agent.followup(createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
        sections: [{ name: 'retrieval-agent:state', text: selection.rendered }] }, content: [{ type: 'text', text: selection.rendered }] }))
      await agent.whenIdle()
      signal.throwIfAborted()
      await application.loadTask(agent)
      const after = application.currentOrUndefined(agent)
      if (after?.phase === 'awaiting_clarification') await application.coordinator?.settlePending?.(agent, signal)
      if (after && after.phase !== 'stopped' && after.phase !== 'awaiting_clarification') {
        await application.stopIncomplete(agent, '模型执行已结束但未提交可校验的完成判断，任务尚未完成；已保存查询条件和候选。')
      }
    } finally { signal.removeEventListener('abort', abort) }
  })
}
