import {
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
    ...(candidate.summary.trim() === candidate.title.trim() ? {} : { summary: candidate.summary }),
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
    this.version = config.version ?? 'evidence-context-v1'
    this.#maxCandidates = config.maxCandidates ?? 8
    this.#maxEvidenceSegments = config.maxEvidenceSegments ?? 12
    this.#estimate = config.estimateTokens ?? defaultEstimate
  }

  select(state: RetrievalState, tokenBudget: number): EvidenceContextSelection {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) throw new TypeError('tokenBudget must be a positive integer')
    const rendered: string[] = []
    const includedCandidateRefs: TicketCandidate['ref'][] = []
    const includedEvidenceIds: TicketEvidenceSegment['evidenceId'][] = []
    const excluded: EvidenceContextSelection['excluded'][number][] = []
    let used = 0
    const aliases = new Map(state.candidateHistory.map((candidate, index) => [candidate.ref, `c${index + 1}`]))
    const queryContract = state.query.contract ?? {
        original: state.query.original,
        normalized: state.query.spec.normalizedQuery,
        task: state.task.target,
        maxResults: state.task.requestedCount,
      }
    const pageBoundary = state.lastPage?.boundary
    const resultPagesExhausted = pageBoundary?.resultPagesExhausted
      ?? (state.lastPage?.completeness === 'exhaustive' && state.lastPage.nextCursor === undefined)
    const lastSignals = state.lastPage?.trace.signals ?? []
    const bothChannels = lastSignals.filter(signal => {
      const channels = new Set(signal.channels.map(channel => channel.channel))
      return channels.has('keyword') && channels.has('vector')
    }).length
    const header = JSON.stringify({
      knowledgeState: {
        queryContract,
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
          scores: lastSignals.map(signal => ({
            alias: aliases.get(signal.candidateRef),
            finalRank: signal.finalRank,
            fusedScore: signal.fusedScore,
            channels: signal.channels,
          })),
        },
        evidenceState: {
          activeAliases: state.candidates.map(candidate => aliases.get(candidate.ref)),
          promotedEvidenceCount: state.promotedEvidence.length,
          gaps: state.gaps.map(gap => ({
            kind: gap.kind,
            status: gap.status,
            evaluator: gap.evaluator,
            description: gap.description,
          })),
          promotableFields: state.snapshot?.fieldCatalog
            .filter(field => field.accessLevel === 'L2')
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
          budget: state.budget,
        },
        actionState: {
          callableToolsNow: state.allowedActions.map(action => action.kind),
          permittedDecisionRequests: [
            'present_current_top_k', 'accept_current_top_k', 'continue_ranking', 'keyword_repair',
            'vector_repair', 'promote_evidence', 'clarify',
          ],
        },
      },
      snapshot: state.snapshot === undefined ? undefined : {
        shortId: state.snapshot.shortId,
        sourceVersion: state.snapshot.sourceVersion,
        authorizationVersion: state.snapshot.authorizationVersion,
      },
    })
    used += this.#estimate(header)
    rendered.push(`<retrieval_state>${header}</retrieval_state>`)
    for (const [index, candidate] of state.candidates.entries()) {
      if (index >= this.#maxCandidates) {
        excluded.push({ ref: candidate.ref, reason: 'not_selected' })
        continue
      }
      const text = candidateText(candidate, aliases.get(candidate.ref) ?? `c${index + 1}`)
      const cost = this.#estimate(text)
      if (used + cost > tokenBudget) {
        excluded.push({ ref: candidate.ref, reason: 'token_budget' })
        continue
      }
      used += cost
      includedCandidateRefs.push(candidate.ref)
      rendered.push(`<ticket_candidate>${text}</ticket_candidate>`)
    }
    for (const [index, evidence] of state.promotedEvidence.entries()) {
      if (index >= this.#maxEvidenceSegments) {
        excluded.push({ ref: evidence.evidenceId, reason: 'not_selected' })
        continue
      }
      const candidateAlias = aliases.get(evidence.candidateRef) ?? 'unknown'
      const text = evidenceText(evidence, candidateAlias, `e${index + 1}`)
      const cost = this.#estimate(text)
      if (used + cost > tokenBudget) {
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
      tokenBudget,
      estimatedTokens: used,
      rendered: rendered.join('\n'),
    }
  }
}
