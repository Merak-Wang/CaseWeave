import type { RetrievalState } from '@retrieval-agent/contracts'

/** A public view of committed work. No prompts, private reasoning, raw tool arguments or invented percent. */
export function projectOrchestration(state: RetrievalState) {
  const generation = state.inputGeneration ?? 0
  const tasks = (state.expertTasks ?? []).filter(t => t.inputGeneration === generation && t.status !== 'superseded')
  const manifests = (state.contextManifests ?? []).filter(m => m.inputGeneration === generation && m.measurement === 'dsh_request')
  const domains = state.knowledgeCatalog?.domains ?? []
  const current = new Set(state.candidates.map(c => c.ref))
  const inspected = new Set(state.promotedEvidence.filter(e => current.has(e.candidateRef)).map(e => e.candidateRef))
  const running = tasks.filter(t => ['pending', 'running'].includes(t.status))
  const terminal = state.phase === 'stopped'
  const channelsRunning = state.searchProgress?.channels.some(c => c.status === 'running')
  const stage = terminal ? 'finished' : channelsRunning || !state.lastPage ? 'search' : running.length ? 'experts' : tasks.length ? 'synthesis' : 'review'
  const roundStart = state.userFeedback?.at(-1)?.receivedAt ?? state.createdAt
  const elapsed = Date.parse(state.executionClock?.waitingSince ?? state.updatedAt) - Date.parse(roundStart)
  const expertOutputTokens = (state.expertTasks ?? []).reduce((total, t) => total + (t.outputTokens ?? 0), 0)
  const mainOutputTokens = state.budget?.totalOutputTokens ?? 0
  return {
    usage: { outputTokens: mainOutputTokens + expertOutputTokens, mainOutputTokens, expertOutputTokens,
      modelRequests: (state.budget?.modelStepsUsed ?? 0) + (state.expertTasks ?? []).reduce((total, t) => total + (t.modelSteps ?? 0), 0),
      experts: (state.expertTasks ?? []).map(t => ({ id: t.id, title: domains.find(d => d.id === t.domainId)?.description ?? t.domainId,
        outputTokens: t.outputTokens ?? 0, inputGeneration: t.inputGeneration })),
    },
    context: state.budget?.context,
    coordinatorActivity: state.coordinatorActivity ?? 'working',
    clock: { elapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
      running: !terminal && !state.executionClock?.waitingSince },
    inputGeneration: generation, startedAt: state.createdAt, updatedAt: state.updatedAt, stage, terminal, fastQueryComplete: Boolean(state.lastPage),
    outcome: state.termination, stopExplanation: state.stopExplanation, waitingForInput: state.termination === 'needs_clarification',
    counts: { candidates: state.candidates.length, inspected: inspected.size, confirmed: state.selectedCandidateRefs.length,
      experts: tasks.length, completedExperts: tasks.filter(t => t.status === 'completed').length },
    catalog: { status: state.knowledgeCatalog?.status ?? 'preparing', releaseId: state.knowledgeCatalog?.releaseId,
      domains: domains.map(d => ({ id: d.id, title: d.description, entryCount: d.entryIds.length })) },
    experts: tasks.map(t => {
      const requests = manifests.filter(m => m.roleId === t.id)
      const consumed = new Set(requests.flatMap(m => m.knowledgeRefs))
      return { id: t.id, domainId: t.domainId, title: domains.find(d => d.id === t.domainId)?.description ?? '通用检索',
        goal: t.goal, scope: t.scope, status: t.status, activity: t.activity,
        actionsUsed: t.actionsUsed, requestCount: requests.length, findingCount: t.finding?.judgments.length ?? 0,
        evidenceCount: new Set(requests.flatMap(m => m.evidenceIds)).size,
        knowledge: t.knowledgeRefs.map(reference => ({ reference, used: consumed.has(reference) })),
        question: t.finding?.question, nextAction: t.finding?.nextAction,
      }
    }),
    openConflicts: (state.expertConflicts ?? []).filter(c => c.status === 'open' && current.has(c.candidateRef)).length,
  }
}
