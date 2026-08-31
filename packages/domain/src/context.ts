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

function candidateText(candidate: TicketCandidate): string {
  return JSON.stringify({
    ref: candidate.ref,
    displayId: candidate.displayId,
    rank: candidate.rank,
    title: candidate.title,
    summary: candidate.summary,
    l0: candidate.l0,
    sourceVersion: candidate.sourceVersion,
  })
}

function evidenceText(evidence: TicketEvidenceSegment): string {
  return JSON.stringify({
    evidenceId: evidence.evidenceId,
    candidateRef: evidence.candidateRef,
    field: evidence.field,
    text: evidence.text,
    sourceVersion: evidence.sourceVersion,
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
    const header = JSON.stringify({
      retrievalId: state.retrievalId,
      stateId: state.stateId,
      phase: state.phase,
      query: state.query.spec,
      candidateKnowledge: {
        historyCount: state.candidateHistory.length,
        activeCount: state.candidates.length,
        excludedCandidateRefs: state.excludedCandidateRefs,
        selectedCandidateRefs: state.selectedCandidateRefs,
        lastAssessment: state.lastAssessment,
        nextPageAvailable: state.lastPage?.nextCursor !== undefined,
      },
      gaps: state.gaps,
      allowedActions: state.allowedActions,
      budget: state.budget,
      termination: state.termination,
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
      const text = candidateText(candidate)
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
      const text = evidenceText(evidence)
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
