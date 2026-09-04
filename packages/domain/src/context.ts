import {
  RetrievalError,
  type EvidenceContextSelection,
  type RetrievalState,
  type TicketCandidate,
  type TicketEvidenceSegment,
} from '@retrieval-agent/contracts'

export interface EvidenceContextPolicyConfig {
  readonly version?: string
  readonly maxCandidates?: number
  readonly maxEvidenceSegments?: number
  readonly estimateTokens?: (text: string) => number
}
function defaultEstimate(text: string): number {
  const cjk = [...text].filter(character => /\p{Script=Han}/u.test(character)).length
  return Math.max(1, Math.ceil(cjk + (text.length - cjk) / 4))
}

function candidateText(candidate: TicketCandidate, alias: string): string {
  return JSON.stringify({
    alias,
    displayId: candidate.displayId,
    rank: candidate.rank,
    title: candidate.title,
    summary: candidate.summary,
    l0: candidate.l0,
    match: candidate.matchSignals,
  })
}

function evidenceText(evidence: TicketEvidenceSegment, candidateAlias: string, evidenceAlias: string): string {
  return JSON.stringify({
    alias: evidenceAlias,
    candidateAlias,
    field: evidence.field,
    text: evidence.text,
    trust: evidence.trust,
    truncated: evidence.truncated,
  })
}

/** Deterministically selects a bounded, provenance-carrying model context. */
export class EvidenceContextPolicy {
  readonly version: string
  readonly #maxCandidates: number
  readonly #maxEvidenceSegments: number
  readonly #estimate: (text: string) => number

  constructor(config: EvidenceContextPolicyConfig = {}) {
    this.version = config.version ?? 'evidence-context-v4'
    this.#maxCandidates = config.maxCandidates ?? 8
    this.#maxEvidenceSegments = config.maxEvidenceSegments ?? 12
    this.#estimate = config.estimateTokens ?? defaultEstimate
  }

  #orderedEvidence(state: RetrievalState): readonly TicketEvidenceSegment[] {
    const active = new Set(state.candidates.map(candidate => candidate.ref))
    const latest = new Set(state.progress.newEvidenceIds ?? [])
    const offset = state.candidateWindowOffset ?? 0
    const window = new Set(state.candidates.slice(offset, offset + this.#maxCandidates).map(candidate => candidate.ref))
    const priority = (item: TicketEvidenceSegment): number => latest.has(item.evidenceId) ? 0 : window.has(item.candidateRef) ? 1 : 2
    // Visibility writes must not reorder the selected window between selection and delivery.
    return state.promotedEvidence.filter(item => active.has(item.candidateRef))
      .sort((left, right) => priority(left) - priority(right))
  }

  nextEvidenceWindowOffset(state: RetrievalState): number {
    const visible = new Set(state.modelVisibleEvidenceIds ?? [])
    return this.#orderedEvidence(state).findIndex(evidence => !visible.has(evidence.evidenceId))
  }

  select(state: RetrievalState, tokenBudget?: number): EvidenceContextSelection {
    if (state.accessValidation === 'required') throw new RetrievalError('UNAUTHORIZED', '历史证据尚未重新授权，不能进入模型上下文。')
    if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) throw new TypeError('tokenBudget must be a positive integer when configured')
    const rendered: string[] = []
    const includedCandidateRefs: TicketCandidate['ref'][] = []
    const includedEvidenceIds: TicketEvidenceSegment['evidenceId'][] = []
    const excluded: EvidenceContextSelection['excluded'][number][] = []
    let used = 0
    const aliases = new Map(state.candidateHistory.map((candidate, index) => [candidate.ref, `c${index + 1}`]))
    // NLP token/parse traces remain durable evidence of compilation, not repeated model instructions.
    const queryContract = {
      original: state.query.original, normalized: state.query.spec.normalizedQuery,
      task: state.task.target, countPolicy: state.task.countPolicy, resultLimit: state.task.requestedCount,
      keyword: state.query.spec.keywordQuery, semanticQuery: state.query.spec.semanticQuery,
      confirmedConstraints: state.query.confirmedConstraints, unresolvedConstraints: state.query.unresolvedConstraints,
      userRequirements: state.query.contract?.userRequirements,
    }
    const evidenceAliases = new Map(state.promotedEvidence.map((evidence, index) => [evidence.evidenceId as string, `e${index + 1}`]))
    const orderedEvidence = this.#orderedEvidence(state)
    const evidenceWindowOffset = state.evidenceWindowOffset ?? 0
    const evidenceWindow = { offset: evidenceWindowOffset, maximumSegments: this.#maxEvidenceSegments,
      availableSegments: orderedEvidence.length, moreUnseenEvidence: this.nextEvidenceWindowOffset(state) >= 0,
      nextWindowAction: 'inspect next_window', priority: 'latest_inspection_then_current_candidates' }
    const alias = (ref: string): string => aliases.get(ref as TicketCandidate['ref']) ?? evidenceAliases.get(ref) ?? ref
    const pageBoundary = state.lastPage?.boundary
    const resultPagesExhausted = pageBoundary?.resultPagesExhausted
      ?? (state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined)
    const lastSignals = state.lastPage?.trace.signals ?? []
    const bothChannels = lastSignals.filter(signal => {
      const channels = new Set(signal.channels.map(channel => channel.channel))
      return channels.has('keyword') && channels.has('vector')
    }).length
    const filterCapabilities = state.snapshot?.fieldCatalog
      .filter(field => field.accessLevel === 'L0' && field.filterOperators.length > 0)
      .map(field => ({
        field: field.key,
        label: field.label,
        valueKind: field.valueKind,
        operators: field.filterOperators,
      })) ?? []
    const callableToolsNow = state.phase === 'stopped' || state.phase === 'awaiting_clarification' ? [] : ['ticket_decide']
    const fullHeader = JSON.stringify({
      knowledgeState: {
        sufficiencyJudgement: {
          requiredEveryRound: true,
          question: '当前候选的 L1 标题和摘要、已读取的受控 L2 正文字段与检索边界是否足以回答用户请求？',
        },
        stateId: state.stateId,
        queryContract,
        userFeedback: state.userFeedback?.map(item => item.text),
        clarification: state.clarification === undefined ? undefined : {
          question: state.clarification.question, answer: state.clarification.answer,
          candidateAliases: state.clarification.candidateRefs.map(alias), options: state.clarification.options,
        },
        judgments: state.judgments?.map(judgment => ({ candidateAlias: alias(judgment.candidateRef),
          verdict: judgment.verdict, evidenceAliases: judgment.evidenceRefs.map(alias), reason: judgment.reason })),
        candidateWindowOffset: state.candidateWindowOffset ?? 0,
        retrievalObservation: {
          stage: state.lastPage?.trace.stage,
          channels: state.lastPage?.trace.channels.map(channel => ({
            channel: channel.channel,
            resultCount: channel.resultCount,
            elapsedMs: channel.elapsedMs,
            querySource: channel.querySource,
          })) ?? [],
          bothChannelCandidates: bothChannels,
          returnedThisPage: state.lastPage?.returned ?? 0,
          newCandidateCount: state.progress.newCandidateRefs.length,
          cumulativeCandidateCount: state.candidateHistory.length,
          rankOverlap: state.progress.rankOverlap,
          noProgressStreak: state.progress.noProgressStreak,
          scores: lastSignals.slice(0, this.#maxCandidates).map(signal => ({
            alias: aliases.get(signal.candidateRef),
            finalRank: signal.finalRank,
            fusedScore: signal.fusedScore,
            channels: signal.channels,
          })),
        },
        evidenceState: {
          activeCandidateCount: state.candidates.length,
          evidenceWindow,
          gaps: state.gaps.map(gap => ({
            kind: gap.kind,
            status: gap.status,
            evaluator: gap.evaluator,
            description: gap.description,
          })),
          inspectFields: state.snapshot?.fieldCatalog
            .filter(field => field.accessLevel === 'L2' && field.valueKind !== 'raw_json')
            .map(field => field.key) ?? [],
        },
        boundaryState: {
          authorizedCorpusSize: pageBoundary?.authorizedCorpusSize,
          documentsAfterStructuredFilters: pageBoundary?.documentsAfterStructuredFilters,
          documentsEligibleForKeywordChannel: pageBoundary?.documentsEligibleForKeywordChannel,
          rankedHits: pageBoundary?.rankedHits,
          resultPagesExhausted,
          semanticRecallKnown: pageBoundary?.semanticRecallKnown ?? false,
          nextPageAvailable: state.lastPage?.nextCursor !== undefined,
          remainingModelSteps: Math.max(0, state.budget.maxRounds - state.budget.modelStepsUsed),
          remainingExecutionMs: Math.max(0, state.budget.maxLatencyMs - state.budget.wallClockElapsedMs),
        },
        actionState: {
          callableToolsNow,
          filterCapabilities,
          clarificationChannel: 'ticket_decide_then_user_message',
        },
      },
      snapshot: state.snapshot === undefined ? undefined : {
        shortId: state.snapshot.shortId,
        sourceVersion: state.snapshot.sourceVersion,
        authorizationVersion: state.snapshot.authorizationVersion,
      },
    })
    const compactHeader = JSON.stringify({
      knowledgeState: {
        stateId: state.stateId, query: queryContract,
        retrievalObservation: { stage: state.lastPage?.trace.stage,
          activeCandidateCount: state.candidates.length, cumulativeCandidateCount: state.candidateHistory.length },
        evidenceState: { evidenceWindow, gaps: state.gaps.map(gap => ({
          kind: gap.kind, status: gap.status, description: gap.description,
        })) },
        boundaryState: {
          resultPagesExhausted, semanticRecallKnown: pageBoundary?.semanticRecallKnown ?? false,
          nextPageAvailable: state.lastPage?.nextCursor !== undefined,
        },
        actionState: { callableToolsNow, filterCapabilities },
      },
      snapshot: state.snapshot === undefined ? undefined : { shortId: state.snapshot.shortId,
        sourceVersion: state.snapshot.sourceVersion, authorizationVersion: state.snapshot.authorizationVersion },
    })
    const minimalHeader = JSON.stringify({ knowledgeState: { activeCandidateCount: state.candidates.length, callableToolsNow } })
    const header = tokenBudget === undefined || this.#estimate(fullHeader) <= tokenBudget ? fullHeader
      : this.#estimate(compactHeader) <= tokenBudget ? compactHeader
        : this.#estimate(minimalHeader) <= tokenBudget ? minimalHeader : '{}'
    used += this.#estimate(header)
    rendered.push(`<ticket_knowledge_context>${header}</ticket_knowledge_context>`)
    const offset = state.candidateWindowOffset ?? 0
    for (const [index, candidate] of state.candidates.entries()) {
      if (index < offset || index >= offset + this.#maxCandidates) {
        excluded.push({ ref: candidate.ref, reason: 'not_selected' })
        continue
      }
      const text = candidateText(candidate, aliases.get(candidate.ref) ?? `c${index + 1}`)
      const cost = this.#estimate(text)
      if (tokenBudget !== undefined && used + cost > tokenBudget) {
        excluded.push({ ref: candidate.ref, reason: 'token_budget' })
        continue
      }
      used += cost
      includedCandidateRefs.push(candidate.ref)
      rendered.push(`<untrusted_ticket_candidate>${text}</untrusted_ticket_candidate>`)
    }
    const activeRefs = new Set(state.candidates.map(candidate => candidate.ref))
    for (const evidence of state.promotedEvidence) {
      if (!activeRefs.has(evidence.candidateRef)) excluded.push({ ref: evidence.evidenceId, reason: 'superseded' })
    }
    for (const [index, evidence] of orderedEvidence.entries()) {
      if (index < evidenceWindowOffset || index >= evidenceWindowOffset + this.#maxEvidenceSegments) {
        excluded.push({ ref: evidence.evidenceId, reason: 'not_selected' })
        continue
      }
      const candidateAlias = aliases.get(evidence.candidateRef) ?? 'unknown'
      const text = evidenceText(evidence, candidateAlias, evidenceAliases.get(evidence.evidenceId)!)
      const cost = this.#estimate(text)
      if (tokenBudget !== undefined && used + cost > tokenBudget) {
        excluded.push({ ref: evidence.evidenceId, reason: 'token_budget' })
        continue
      }
      used += cost
      includedEvidenceIds.push(evidence.evidenceId)
      rendered.push(`<untrusted_ticket_evidence>${text}</untrusted_ticket_evidence>`)
    }
    return {
      retrievalId: state.retrievalId,
      stateId: state.stateId,
      policyVersion: this.version,
      includedCandidateRefs,
      includedEvidenceIds,
      excluded,
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      estimatedTokens: used,
      rendered: rendered.join('\n'),
    }
  }
}
