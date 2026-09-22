import type { LearnedResult, RetrievalState } from '@retrieval-agent/contracts'
import { confirmedCount, learnedResult } from '@retrieval-agent/domain/result'

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
  const expertOutputTokens = (state.expertTasks ?? []).reduce((total, t) => total + (t.outputTokens ?? 0), 0)
  const mainOutputTokens = state.budget?.totalOutputTokens ?? 0
  const operatorUsage = state.budget?.operatorUsage
  const plan = state.query?.contract?.semanticPlan
  const learning = operatorUsage?.learning as Record<string, unknown> | undefined
  // 检索视图只取本轮判据与集合计数，不复制训练 ID 和逐条分数。
  const currentLearning = learning?.input_revision === generation ? learning : undefined
  const sampleRequests = manifests.filter(m => m.operator?.operation === 'sem_filter')
  const sampleKnowledge = new Set(sampleRequests.flatMap(m => m.operator!.knowledgeIds ?? []))
  const activity = state.operatorActivity?.inputGeneration === generation ? state.operatorActivity : undefined
  const lastOperatorRequest = manifests.findLast(m => m.operator)
  const requestContext = (lastOperatorRequest?.operator?.metrics?.context ?? operatorUsage?.context) as {
    measuredInputTokens?: number; limit?: number; model?: string; operation?: string
  } | undefined
  // 算子请求有独立上下文；累积 token 用量不能冒充单次窗口占用。
  const operatorContext = requestContext && lastOperatorRequest ? {
    estimatedInputTokens: lastOperatorRequest.estimatedTokens, measuredInputTokens: requestContext.measuredInputTokens,
    limit: requestContext.limit, reservedTokens: 4096, compactionCount: 0, source: 'operator',
    model: requestContext.model, operation: requestContext.operation,
  } : lastOperatorRequest ? { estimatedInputTokens: lastOperatorRequest.estimatedTokens,
    reservedTokens: 4096, compactionCount: 0, source: 'operator', operation: lastOperatorRequest.operator!.operation } : undefined
  const context = activity?.status === 'running' || !state.budget?.context ? operatorContext ?? state.budget?.context : state.budget.context
  const operatorOutputTokens = Number(operatorUsage?.reported_completion_tokens ?? 0)
  const measuredInput = state.budget?.totalMeasuredInputTokens ?? ((state.budget?.modelStepsUsed ?? 0) === 0 ? 0 : undefined)
  const expertInput = (state.expertTasks ?? []).reduce((sum, t) => sum + (t.inputTokens ?? 0), 0)
  const expertReceiptsComplete = !(state.expertTasks ?? []).some(t => (t.modelSteps ?? 0) > 0 && t.inputTokens === undefined)
  return {
    retrieval: {
      filterActivity: activity?.operation === 'sem_filter' ? activity.status : undefined,
      plan: plan?.inputGeneration === generation ? { instruction: plan.instruction, keywords: plan.keywords,
        expressions: plan.retrieval_expressions, goal: plan.goal, knowledgeRoutes: plan.knowledge_routes } : undefined,
      learning: currentLearning ? { status: String(currentLearning.stop_reason), resultAvailable: Boolean(learnedResult(state)),
        scopeCount: currentLearning.corpus_records || currentLearning.scanned_records, sampledCount: currentLearning.teacher_unique_records,
        trainingCount: currentLearning.training_records, auditCount: currentLearning.audit_records,
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
    usage: { outputTokens: mainOutputTokens + expertOutputTokens + operatorOutputTokens, mainOutputTokens, expertOutputTokens, operatorOutputTokens,
      inputTokens: measuredInput !== undefined && expertReceiptsComplete && operatorUsage?.accounting_complete !== false
        ? measuredInput + expertInput + Number(operatorUsage?.reported_prompt_tokens ?? 0) : null,
      mainMeasuredInputTokens: measuredInput ?? null, expertInputTokens: expertInput,
      operatorUsage,
      mainRequests: state.budget?.modelStepsUsed ?? 0,
      expertRequests: (state.expertTasks ?? []).reduce((total, t) => total + (t.modelSteps ?? 0), 0),
      operatorRequests: Number(operatorUsage?.llm_adapter_calls ?? 0),
      modelRequests: (state.budget?.modelStepsUsed ?? 0) + (state.expertTasks ?? []).reduce((total, t) => total + (t.modelSteps ?? 0), 0) + Number(operatorUsage?.llm_adapter_calls ?? 0),
      experts: (state.expertTasks ?? []).map(t => ({ id: t.id, title: domains.find(d => d.id === t.domainId)?.description ?? t.domainId,
        outputTokens: t.outputTokens ?? 0, inputGeneration: t.inputGeneration })),
    },
    context,
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
