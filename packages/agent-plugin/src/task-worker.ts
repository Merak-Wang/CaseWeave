import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RetrievalError } from '@retrieval-agent/contracts'
import { buildFastTicketRequest, buildSemanticTicketRequest, type TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'
import type { DurableRetrievalAgentService } from './durable-service.js'
import type { TaskJob } from './task-store.js'
import { compactRetrievalSurface } from './context/surface.js'
import { modelFailure } from './model-failure.js'

/** Drives the installed DSH loop. Page connections and subscriptions never own this lifetime. */
export async function executeTaskJob(application: DurableRetrievalAgentService, agent: Agent, job: TaskJob,
  analyzer: TicketQueryAnalyzer, signal: AbortSignal): Promise<void> {
  await application.withJob(agent, job, async () => {
    if (job.kind === 'learn' || job.kind === 'unlearn' || job.kind === 'source_check') {
      if (!application.learning) throw new RetrievalError('PROVIDER_UNAVAILABLE', 'Wiki 学习服务尚未装配，作业保留供恢复。', { retryable: true })
      await application.learning.run(agent, job, signal)
      return
    }
    await application.loadTask(agent)
    const current = application.currentOrUndefined(agent)
    if (job.kind === 'page') {
      let state = current
      while (state?.phase === 'awaiting_clarification' && state.lastPage?.nextCursor) {
        signal.throwIfAborted()
        state = await application.continueIndependentPage(agent, signal)
      }
      return
    }
    if (job.kind === 'search') {
      // The final state may already be committed when a process dies before settling its job.
      if (!application.operators && job.attempts > 1 && current?.lastPage && current.phase !== 'snapshot_opened'
        && current.termination !== 'backend_error' && !current.searchProgress?.channels.some(c => c.status === 'running')) return
      const query = current ? undefined : (await application.store.rows<{ original_query: string }>('SELECT original_query FROM ra_task WHERE id=?', [job.task_id]))[0]
      const state = current ? application.operators && current.phase !== 'snapshot_opened' && current.termination !== 'backend_error'
        ? (await application.ensureModelAccess(agent, signal))! : await application.refresh(agent, signal)
        : await application.start(agent, application.operators ? buildSemanticTicketRequest(query!.original_query)
          : await buildFastTicketRequest(query!.original_query, { analyzer, signal }), signal)
      if (state.termination === 'backend_error') throw new RetrievalError('PROVIDER_UNAVAILABLE', state.stopExplanation ?? '检索来源暂时不可用。', { retryable: true })
      if (application.operators) await application.operators.searchAndFilter(agent, signal)
      return
    }
    const state = await application.ensureModelAccess(agent, signal)
    if (!state || state.phase === 'stopped') return
    if (application.operators && state.phase !== 'awaiting_clarification') {
      await application.operators.searchAndFilter(agent, signal)
    }
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
    let failed: { code?: string; status?: number } | undefined
    const previousEvents = agent.session.snapshotEvents().length
    const detachFailure = agent.ctx.on('agent/request-error', (event, next) => { failed = event.failure; return next() })
    try {
      agent.followup(createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-agent', form: 'snapshot',
        sections: [{ name: 'retrieval-agent:state', text: selection.rendered }] }, content: [{ type: 'text', text: selection.rendered }] }))
      await agent.whenIdle()
      signal.throwIfAborted()
      await application.loadTask(agent)
      const after = application.currentOrUndefined(agent)
      // 请求装配错误发生在 llm/stream 之前；从 DSH 终态取出真实原因，不能只报“未提交完成”。
      if (!failed) {
        const end = agent.session.snapshotEvents().slice(previousEvents).findLast(e => e.type === 'turn/end')
        const reason = end?.data as { reason?: { kind: string; error?: { code?: string } } } | undefined
        if (reason?.reason?.kind === 'error') failed = reason.reason.error
      }
      if (after?.phase === 'awaiting_clarification') await application.coordinator?.settlePending?.(agent, signal)
      if (after && after.phase !== 'stopped' && after.phase !== 'awaiting_clarification') {
        await application.stopIncomplete(agent, failed ? modelFailure(failed).publicMessage : '模型执行已结束但未提交可校验的完成判断，任务尚未完成；已保存查询条件和候选。')
        if (failed) throw modelFailure(failed)
      }
    } finally { detachFailure(); signal.removeEventListener('abort', abort) }
  })
}
