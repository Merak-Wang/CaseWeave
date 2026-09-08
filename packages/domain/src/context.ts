import {
  RetrievalError,
  type EvidenceContextSelection,
  type RetrievalState,
  type TicketCandidate,
  type TicketEvidenceSegment,
} from '@retrieval-agent/contracts'
import { createHash } from 'node:crypto'

export interface EvidenceContextPolicyConfig {
  readonly role?: 'main' | 'expert'
  readonly version?: string
  readonly maxCandidates?: number
  readonly maxEvidenceSegments?: number
  readonly estimateTokens?: (text: string) => number
}
export function estimateContextTokens(text: string): number {
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
    projection: 'L1', summaryOrigin: candidate.summaryOrigin ?? { kind: 'unknown' },
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
    projection: evidence.projectionLevel ?? 'L2', origin: evidence.origin ?? { kind: 'unknown' },
    part: evidence.part, start: evidence.start, end: evidence.end, fieldLength: evidence.fieldLength,
    spanHash: evidence.spanHash,
  })
}

/** Deterministically selects a bounded, provenance-carrying model context. */
export class EvidenceContextPolicy {
  readonly version: string
  readonly #maxCandidates: number
  readonly #maxEvidenceSegments: number
  readonly #estimate: (text: string) => number
  readonly #expert: boolean

  constructor(config: EvidenceContextPolicyConfig = {}) {
    this.version = config.version ?? 'evidence-context-v5'
    this.#maxCandidates = config.maxCandidates ?? 8
    this.#maxEvidenceSegments = config.maxEvidenceSegments ?? 12
    this.#estimate = config.estimateTokens ?? estimateContextTokens
    this.#expert = config.role === 'expert'
  }

  #orderedEvidence(state: RetrievalState): readonly TicketEvidenceSegment[] {
    const active = new Set(state.candidates.map(candidate => candidate.ref))
    const latest = new Set(state.progress.newEvidenceIds ?? [])
    const offset = state.candidateWindowOffset ?? 0
    const window = new Set(state.candidates.slice(offset, offset + this.#maxCandidates).map(candidate => candidate.ref))
    const priority = (item: TicketEvidenceSegment): number => latest.has(item.evidenceId) ? 0 : window.has(item.candidateRef) ? 1 : 2
    // Visibility writes must not reorder the selected window between selection and delivery.
    return state.promotedEvidence.filter(item => active.has(item.candidateRef)
      && (!state.contextCandidateRefs || state.contextCandidateRefs.includes(item.candidateRef)))
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
      queryPlan: state.query.spec.queryPlan,
      searchChannels: state.searchProgress?.channels,
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
    const callableToolsNow = state.phase === 'stopped' ? [] : this.#expert ? ['ticket_expert']
      : state.phase === 'awaiting_clarification' ? [] : ['ticket_decide']
    const actionState = { callableToolsNow, filterCapabilities,
      clarificationChannel: this.#expert ? 'ticket_expert report.question; main asks the user' : 'ticket_decide_then_user_message',
      ...(!this.#expert ? { toolRepairBudget: { maxConsecutiveErrors: state.budget.maxConsecutiveToolErrors ?? 6,
        consecutiveErrors: state.budget.consecutiveToolErrors ?? 0,
        onExhaustion: 'resource stop with unfinished status; a successful action resets consecutive errors' } } : {}) }
    const evidenceNavigation = {
      nextPosition: state.evidenceReadPosition ? { candidate_alias: alias(state.evidenceReadPosition.candidateRef),
        field: state.evidenceReadPosition.field, part: state.evidenceReadPosition.part, start: state.evidenceReadPosition.start } : undefined,
      inspectFields: state.snapshot?.fieldCatalog.filter(field => ['L1', 'L2', 'L3'].includes(field.accessLevel) && field.valueKind !== 'raw_json').map(field => field.key) ?? [],
    }
    const history = { judgmentCount: state.judgments?.length ?? 0,
      accepted: state.selectedCandidateRefs.length, excluded: state.excludedCandidateRefs.length,
      lookup: `${this.#expert ? 'inspect' : 'inspect history'} with candidate_aliases; fields=[] reloads L1, declared fields reload source spans`,
      recent: state.judgments?.slice(-4).map(j => ({ indexCard: { projection: 'L0', candidateAlias: alias(j.candidateRef),
        displayId: state.candidateHistory.find(c => c.ref === j.candidateRef)?.displayId,
        title: state.candidateHistory.find(c => c.ref === j.candidateRef)?.title,
        sourceVersion: state.candidateHistory.find(c => c.ref === j.candidateRef)?.sourceVersion }, verdict: j.verdict,
        evidenceAliases: j.evidenceRefs.map(alias), reason: j.reason })) }
    const experts = { catalog: state.knowledgeCatalog, tasks: state.expertTasks?.slice(-6).map(t => ({
      id: t.id, domainId: t.domainId, goal: t.goal, scope: t.scope, status: t.status, failure: t.failure,
      inputGeneration: t.inputGeneration, releaseId: t.releaseId, knowledgeRefs: t.knowledgeRefs,
      candidateAliases: t.candidateRefs.map(alias),
      finding: t.finding ? { id: t.finding.id, judgments: t.finding.judgments.map(j => ({
        candidateAlias: alias(j.candidateRef), verdict: j.verdict, evidenceAliases: j.evidenceRefs.map(alias), reason: j.reason })),
        gaps: t.finding.gaps.map(g => ({ ...g, evidenceRefs: undefined, evidenceAliases: g.evidenceRefs.map(alias) })),
        counterEvidenceAliases: t.finding.counterEvidenceRefs.map(alias), nextAction: t.finding.nextAction,
        question: t.finding.question, disagreementKind: t.finding.disagreementKind } : undefined,
    })), conflicts: state.expertConflicts?.filter(c => c.status === 'open').map(c => ({
      candidateAlias: alias(c.candidateRef), findingIds: c.findingIds, kind: c.kind, status: c.status })) }
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
        history, experts,
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
          ...evidenceNavigation,
          activeCandidateCount: state.candidates.length,
          evidenceWindow,
          gaps: state.gaps.map(gap => ({
            kind: gap.kind,
            status: gap.status,
            evaluator: gap.evaluator,
            description: gap.description,
          })),
        },
        boundaryState: {
          authorizedCorpusSize: pageBoundary?.authorizedCorpusSize,
          documentsAfterStructuredFilters: pageBoundary?.documentsAfterStructuredFilters,
          documentsEligibleForKeywordChannel: pageBoundary?.documentsEligibleForKeywordChannel,
          rankedHits: pageBoundary?.rankedHits,
          resultPagesExhausted,
          semanticRecallKnown: pageBoundary?.semanticRecallKnown ?? false,
          nextPageAvailable: state.lastPage?.nextCursor !== undefined,
        },
        actionState,
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
        userFeedback: state.userFeedback?.map(item => item.text), clarification: state.clarification,
        history, experts,
        retrievalObservation: { stage: state.lastPage?.trace.stage,
          activeCandidateCount: state.candidates.length, cumulativeCandidateCount: state.candidateHistory.length },
        evidenceState: { ...evidenceNavigation, evidenceWindow, gaps: state.gaps.map(gap => ({
          kind: gap.kind, status: gap.status, description: gap.description,
        })) },
        boundaryState: {
          resultPagesExhausted, semanticRecallKnown: pageBoundary?.semanticRecallKnown ?? false,
          nextPageAvailable: state.lastPage?.nextCursor !== undefined,
        },
        actionState,
      },
      snapshot: state.snapshot === undefined ? undefined : { shortId: state.snapshot.shortId,
        sourceVersion: state.snapshot.sourceVersion, authorizationVersion: state.snapshot.authorizationVersion },
    })
    const wrapHeader = (text: string): string => `<ticket_knowledge_context>${text}</ticket_knowledge_context>`
    const header = tokenBudget === undefined || this.#estimate(wrapHeader(fullHeader)) <= tokenBudget ? fullHeader : compactHeader
    used += this.#estimate(wrapHeader(header))
    if (tokenBudget !== undefined && used > tokenBudget) throw new RetrievalError('CAPACITY_EXCEEDED', '任务上下文超出当前工作配额，无法完整保留检索要求与必要依据，本轮尚未完成。')
    rendered.push(wrapHeader(header))
    const offset = state.candidateWindowOffset ?? 0
    for (const [index, candidate] of state.candidates.entries()) {
      if (state.contextCandidateRefs ? !state.contextCandidateRefs.includes(candidate.ref) : index < offset || index >= offset + this.#maxCandidates) {
        excluded.push({ ref: candidate.ref, reason: 'not_selected' })
        continue
      }
      const text = `<untrusted_ticket_candidate>${candidateText(candidate, aliases.get(candidate.ref) ?? `c${index + 1}`)}</untrusted_ticket_candidate>`
      const cost = this.#estimate(text + '\n')
      if (tokenBudget !== undefined && used + cost > tokenBudget) {
        excluded.push({ ref: candidate.ref, reason: 'token_budget' })
        continue
      }
      used += cost
      includedCandidateRefs.push(candidate.ref)
      rendered.push(text)
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
      const text = `<untrusted_ticket_evidence>${evidenceText(evidence, candidateAlias, evidenceAliases.get(evidence.evidenceId)!)}</untrusted_ticket_evidence>`
      const cost = this.#estimate(text + '\n')
      if (tokenBudget !== undefined && used + cost > tokenBudget) {
        excluded.push({ ref: evidence.evidenceId, reason: 'token_budget' })
        continue
      }
      used += cost
      includedEvidenceIds.push(evidence.evidenceId)
      rendered.push(text)
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
      manifest: { id: createHash('sha256').update(`${state.stateId}:${rendered.join('\n')}`).digest('hex'),
        roleId: 'main', stateId: state.stateId, inputGeneration: state.inputGeneration ?? 0,
        candidateRefs: includedCandidateRefs, evidenceIds: includedEvidenceIds,
        evidenceSpans: state.promotedEvidence.filter(e => includedEvidenceIds.includes(e.evidenceId)).map(e => ({
          evidenceId: e.evidenceId, start: e.start, end: e.end, contentHash: e.spanHash ?? e.contentHash })),
        knowledgeRefs: [], renderedHash: createHash('sha256').update(rendered.join('\n')).digest('hex'),
        estimatedTokens: used, ...(tokenBudget === undefined ? {} : { tokenBudget }), measurement: 'conservative_estimate' },
    }
  }
}
