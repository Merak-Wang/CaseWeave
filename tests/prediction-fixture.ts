import { createHash } from 'node:crypto'
import { TicketCandidateRef, type RetrievalState, type TicketQueryContract } from '@retrieval-agent/contracts'
import { provider, retrievalState } from './export-fixture.js'

/** Three wholly synthetic current-pool predictions: accept/exclude/undetermined, zero business confirmations. */
export function predictionFixture(base: RetrievalState = retrievalState()): RetrievalState {
  const { frozenEvidence: _frozen, ...current } = base
  const candidates = ['accept', 'exclude', 'undetermined'].map((label, index) => ({ ...base.candidates[0]!,
    ref: index === 0 ? base.candidates[0]!.ref : TicketCandidateRef('prediction-fixture-' + label),
    snapshotId: base.snapshot!.snapshotId, displayId: index === 0 ? base.candidates[0]!.displayId : 'SYNTHETIC-' + label, rank: index + 1 }))
  return { ...current, inputGeneration: 1, accessValidation: 'current', phase: 'stopped', termination: 'partial',
    selectedCandidateRefs: [], excludedCandidateRefs: [], candidates, candidateHistory: candidates,
    query: { ...base.query, contract: { ...base.query.contract, schemaVersion: 10, original: base.query.original,
      semanticExecution: { onlineLearning: false, semanticMethod: 'name_gmm', orchestration: 'fixed' } } as TicketQueryContract },
    judgments: candidates.map((c, i) => ({ candidateRef: c.ref, verdict: 'undetermined', basis: 'unresolved', reason: '合成未校准候选预测', evidenceRefs: [],
      operatorInference: { algorithm: 'name_gmm', proposal: 'name_gmm', phase: 'prediction', inferred: true, proposed: Number(i === 0),
        proposed_label: (['accept', 'exclude', 'undetermined'] as const)[i]!, quality: 'unmeasured', input_revision: 1, score: [.87, .1, 0][i]!,
        source_version: c.sourceVersion, content_hash: c.contentHash,
        record_identity: createHash('sha256').update(JSON.stringify([c.ref, c.sourceVersion, c.contentHash])).digest('hex') } })) }
}
export function predictionProvider(state: RetrievalState): ReturnType<typeof provider> {
  const source = provider()
  source.readDetails.mockImplementation(async (_principal, request) => ({ snapshotId: request.snapshotId,
    details: request.candidateRefs.map((ref: TicketCandidateRef) => {
      const c = state.candidates.find(candidate => candidate.ref === ref)!
      return { candidateRef: ref, displayId: c.displayId, sourceVersion: c.sourceVersion, title: c.title, summary: c.summary,
        l0: c.l0, fields: {}, unavailableFields: [] }
    }), rejectedCandidateRefs: [], warnings: [] }))
  return source
}
