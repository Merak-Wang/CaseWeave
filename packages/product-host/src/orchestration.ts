import { projectUsage, projectContext, type TaskRuntimeMetrics } from './orchestration-metrics.js'
import type { LearnedResult, RetrievalState } from '@retrieval-agent/contracts'
import { confirmedCount, learnedResult } from '@retrieval-agent/domain/result'

/** A public view of committed work. No prompts, private reasoning, raw tool arguments or invented percent. */
export function projectOrchestration(state: RetrievalState, runtime?: TaskRuntimeMetrics) {
  const generation = state.inputGeneration ?? 0
  const tasks = (state.expertTasks ?? []).filter(t => t.inputGeneration === generation && t.status !== 'superseded')
  const manifests = (state.contextManifests ?? []).filter(m => m.inputGeneration === generation && m.measurement === 'dsh_request')
  const domains = state.knowledgeCatalog?.domains ?? []
  const current = new Set(state.candidates.map(c => c.ref))
  const inspected = new Set(state.promotedEvidence.filter(e => current.has(e.candidateRef)).map(e => e.candidateRef))
  const running = tasks.filter(t => ['pending', 'running'].includes(t.status))
  const terminal = state.phase === 'stopped'
  const channelsRunning = state.searchProgress?.channels.some(c => c.status === 'running')
  const operation = state.operatorActivity?.inputGeneration === generation && state.operatorActivity.status === 'running' ? state.operatorActivity.operation : undefined
  // 当前执行优先于历史专家状态；专家已返回不代表已进入交付。
  const stage = terminal ? 'finished' : operation === 'query_plan' ? 'planning'
    : operation === 'sem_filter' || operation === 'sem_extract' ? 'review'
      : operation === 'sem_search' || channelsRunning || !state.lastPage ? 'search'
        : operation === 'sem_agg' ? 'synthesis' : running.length ? 'experts'
          : state.query?.contract?.schemaVersion === 10 && state.query.contract.semanticPlan?.inputGeneration !== generation ? 'planning'
            : !state.candidates.length ? 'coverage' : 'review'
  const blockers = [...(state.query?.unresolvedConstraints ?? []), ...(state.gaps ?? []).filter(g => !['coverage', 'boundary'].includes(g.kind)
    && ['open', 'unknown'].includes(g.status) && g.description).map(g => g.description!)]
  const roundStart = state.userFeedback?.at(-1)?.receivedAt ?? state.createdAt
  const elapsed = Date.parse(state.executionClock?.waitingSince ?? (terminal ? '' : state.updatedAt)) - Date.parse(roundStart)
  const operatorUsage = state.budget?.operatorUsage
  const plan = state.query?.contract?.semanticPlan
  const learning = operatorUsage?.learning as Record<string, unknown> | undefined
  // 检索视图只取本轮判据与集合计数，不复制训练 ID 和逐条分数。
  const currentLearning = learning?.input_revision === generation ? learning : undefined
  const sampleRequests = manifests.filter(m => m.operator?.operation === 'sem_filter')
  const sampleKnowledge = new Set(sampleRequests.flatMap(m => m.operator!.knowledgeIds ?? []))
  const knowledgeRequests = sampleRequests.filter(m => m.operator!.knowledgeIds?.length)
  const candidateDisplayIds = new Map<string, string>()
  for (const candidate of [...(state.candidateHistory ?? []), ...state.candidates]) {
    if (candidate.displayId) candidateDisplayIds.set(candidate.ref, candidate.displayId)
  }
  const samplingRequests = sampleRequests.map(m => ({
    id: m.id,
    knowledge: [...new Map((m.operator!.knowledgeIds ?? []).map((id, index) => {
      const reference = m.knowledgeRefs?.[index]
      return [reference ?? id, { id, ...(reference ? { reference } : {}) }] as const
    })).values()],
    candidates: [...new Set(m.candidateRefs ?? [])].map(ref => ({ ref,
      ...(candidateDisplayIds.has(ref) ? { displayId: candidateDisplayIds.get(ref)! } : {}) })),
  }))
  const knowledgeUse = new Map<string, { id: string; reference?: string; requests: Set<object>; samples: Set<string> }>()
  // 只汇总实际送入本轮判断请求的知识；重复复核计请求次数，工单数按身份去重。
  for (const m of knowledgeRequests) {
    const distinct = new Map((m.operator!.knowledgeIds ?? []).map((id, index) => {
      const reference = m.knowledgeRefs?.[index]
      return [reference ?? id, { id, ...(reference ? { reference } : {}) }] as const
    }))
    for (const [key, entry] of distinct) {
      const use = knowledgeUse.get(key) ?? { ...entry, requests: new Set<object>(), samples: new Set<string>() }
      use.requests.add(m)
      for (const ref of m.candidateRefs ?? []) use.samples.add(ref)
      knowledgeUse.set(key, use)
    }
  }
  const activity = state.operatorActivity?.inputGeneration === generation ? state.operatorActivity : undefined
  return {
    samplingKnowledge: { requestCount: knowledgeRequests.length,
      sampleCount: new Set(knowledgeRequests.flatMap(m => m.candidateRefs ?? [])).size,
      entries: [...knowledgeUse.values()].map(({ requests, samples, ...entry }) => ({ ...entry,
        requestCount: requests.size, sampleCount: samples.size })),
      requests: samplingRequests,
    },
    retrieval: {
      filterActivity: activity?.operation === 'sem_filter' ? activity.status : undefined,
      plan: plan?.inputGeneration === generation ? { instruction: plan.instruction, keywords: plan.keywords,
        expressions: plan.retrieval_expressions, goal: plan.goal, knowledgeRoutes: plan.knowledge_routes } : undefined,
      learning: currentLearning ? { status: String(currentLearning.stop_reason), resultAvailable: Boolean(learnedResult(state)),
        scopeCount: currentLearning.corpus_records || currentLearning.scanned_records, sampledCount: currentLearning.teacher_unique_records,
        trainingCount: currentLearning.training_records, auditCount: currentLearning.audit_records,
        qualityBasis: currentLearning.quality_basis,
        samplingRequests: currentLearning.sampling_requests, samplingRequestLimit: currentLearning.sampling_request_limit,
        message: currentLearning.message,
        reusedTrainingCount: currentLearning.reused_training_records, reusedLabelCount: currentLearning.reused_label_records,
        reusedUnresolvedCount: currentLearning.reused_unresolved_records,
        samplingMethod: currentLearning.sampling_method, samplingPhase: currentLearning.sampling_phase,
        candidateModels: currentLearning.candidate_models, models: currentLearning.models,
        selectedModel: currentLearning.selected_model, threshold: currentLearning.threshold,
        fitCount: currentLearning.fit_count, predictedCount: currentLearning.predicted_records,
        positiveCount: currentLearning.positive_records, negativeCount: currentLearning.negative_records,
        unresolvedCount: currentLearning.undetermined_records, batchSize: currentLearning.batch_size,
        concurrency: currentLearning.concurrency, sampleSize: currentLearning.sample_size, diversityCount: currentLearning.diversity_records,
        precisionTarget: currentLearning.precision_target, recallTarget: currentLearning.recall_target,
        knowledgeEntryCount: sampleKnowledge.size, knowledgeRequestCount: sampleRequests.length,
        selectionCount: currentLearning.selection_records,
        quality: currentLearning.quality as LearnedResult['quality'] | undefined } : undefined,
    },
    usage: projectUsage(state, runtime),
    context: projectContext(state, runtime),
    coordinatorActivity: state.coordinatorActivity ?? 'working',
    clock: { elapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
      ...(!Number.isFinite(elapsed) ? { unavailable: true } : {}),
      running: !terminal && activity?.status !== 'failed' && !state.executionClock?.waitingSince },
    inputGeneration: generation, startedAt: state.createdAt, updatedAt: state.updatedAt, stage, terminal, fastQueryComplete: Boolean(state.lastPage),
    outcome: state.termination, stopExplanation: state.stopExplanation, blockers, operation, waitingForInput: state.termination === 'needs_clarification',
    counts: { candidates: state.candidates.length, inspected: inspected.size, confirmed: confirmedCount(state),
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
