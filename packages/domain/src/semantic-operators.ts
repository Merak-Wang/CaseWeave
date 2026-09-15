import { RetrievalError, type OperatorRecord, type OperatorDecision, type RetrievalState, type TicketCandidate,
  type TicketCandidateRef, type SemanticQueryPlan } from '@retrieval-agent/contracts'
import { admitDecision } from './decision.js'
import { requiredEvidenceFields } from './evidence-requirements.js'
export { operatorRequiredFields } from './evidence-requirements.js'

/** The exact authorized material available for a row; added evidence never changes an older passage. */
export function operatorRecord(state: RetrievalState, candidate: TicketCandidate): OperatorRecord {
  const origin = (field: string) => state.snapshot?.fieldCatalog.find(f => f.key === field)?.capability?.origin ?? 'unknown'
  const passages: OperatorRecord['passages'][number][] = [
    { id: 'displayId', field: 'displayId', text: candidate.displayId, start: 0, origin: 'source' },
    { id: 'title', field: 'title', text: candidate.title, start: 0, origin: origin('title') },
    { id: 'summary', field: 'summary', text: candidate.summary, start: 0, origin: candidate.summaryOrigin?.kind ?? 'unknown' },
  ]
  for (const [field, value] of Object.entries(candidate.l0 ?? {})) if (value !== null && value !== undefined) {
    passages.push({ id: `l0:${field}`, field, text: typeof value === 'string' ? value : JSON.stringify(value), start: 0, origin: origin(field) })
  }
  for (const e of state.promotedEvidence) if (e.candidateRef === candidate.ref) passages.push({ id: e.evidenceId, field: e.field,
    text: e.text, start: e.start, origin: e.origin?.kind ?? 'unknown' })
  return { ref: candidate.ref, version: candidate.sourceVersion, content_hash: candidate.contentHash, passages,
    attributes: { summary_origin: candidate.summaryOrigin ?? { kind: 'unknown' },
      required_evidence_fields: candidate.summaryOrigin?.verification === 'conflicting' ? candidate.summaryOrigin.requiredEvidenceFields ?? [] : [] } }
}

export function validateOperatorRecord(state: RetrievalState, row: OperatorRecord): TicketCandidate {
  const candidate = state.candidates.find(c => c.ref === row.ref)
  if (!candidate || row.version !== candidate.sourceVersion || row.content_hash !== candidate.contentHash) throw new RetrievalError('INVALID_REQUEST', '算子记录不属于当前来源版本。')
  const current = operatorRecord(state, candidate)
  if (!Array.isArray(row.passages) || new Set(row.passages.map(p => p.id)).size !== row.passages.length
    || row.passages.some(p => !current.passages.some(actual => actual.id === p.id && actual.field === p.field && actual.text === p.text && actual.start === p.start && actual.origin === p.origin))) {
    throw new RetrievalError('INVALID_REQUEST', '算子收到的片段与当前授权证据不一致。')
  }
  return candidate
}

export function admitOperatorDecisions(state: RetrievalState, generation: number, decisions: readonly OperatorDecision[]): Partial<RetrievalState> {
  if (generation !== (state.inputGeneration ?? 0)) throw new RetrievalError('INVALID_TRANSITION', '算子结果属于旧输入代次。')
  let current = state
  const seen = new Set<string>()
  for (const d of decisions) {
    const proxy = d.basis === 'proxy', inference = d.inference
    // Only the trusted Python result channel supplies inference. These are
    // numerical check results, never a fabricated per-record model receipt.
    if (seen.has(d.ref) || !['model', 'reused_model', 'unresolved', 'proxy'].includes(d.basis)
      || (proxy && (!inference || inference.algorithm !== 'cluster' || !inference.inferred || inference.phase !== 'check'
        || inference.error_upper !== 0 || inference.tolerance !== 0 || !(inference.alpha > 0 && inference.alpha <= .005)
        || inference.proposed !== Number(d.label === 'accept') || d.manifest_id !== null))) throw new RetrievalError('INVALID_REQUEST', '算子结果重复或是未经准入的代理推断。')
    seen.add(d.ref)
    const manifest = state.contextManifests?.find(m => m.operator?.pythonManifestId === d.manifest_id && m.operator.operation === 'sem_filter'
      && m.measurement === 'dsh_request' && m.roleId.startsWith('operator:') && m.inputGeneration === generation)
    const candidateSource = proxy ? state.candidates.find(c => c.ref === d.ref) : undefined
    const row = proxy && candidateSource ? operatorRecord(state, candidateSource) : manifest?.operator?.records.find(r => r.ref === d.ref)
    if (!row || (!proxy && (!manifest || d.knowledge_ids.some(id => !manifest.operator!.knowledgeIds.includes(id))
      || (manifest.releaseId && manifest.releaseId !== state.knowledgeCatalog?.releaseId)))) throw new RetrievalError('INVALID_REQUEST', '算子缺少当前实际模型请求或引用了未送达知识。')
    const candidate = validateOperatorRecord(state, row)
    if (!d.reason.trim() || d.reason.length > 1000 || !['accept', 'exclude', 'undetermined'].includes(d.label)
      || (d.label !== 'undetermined' && (d.basis === 'unresolved' || !d.citations.length))) throw new RetrievalError('INVALID_REQUEST', '算子确定判断缺少依据或理由无效。')
    const evidenceRefs: string[] = []
    for (const citation of d.citations) {
      const p = row.passages.find(p => p.id === citation.passage_id)
      if (!p || citation.ref !== row.ref || citation.version !== row.version || citation.content_hash !== row.content_hash
        || citation.field !== p.field || citation.origin !== p.origin || !citation.quote
        || !Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end)
        || citation.start < p.start || citation.end > p.start + p.text.length || citation.end - citation.start !== citation.quote.length
        || p.text.slice(citation.start - p.start, citation.end - p.start) !== citation.quote) throw new RetrievalError('INVALID_REQUEST', '算子引文不属于本条实际送达片段。')
      evidenceRefs.push(state.promotedEvidence.some(e => e.evidenceId === p.id && e.candidateRef === row.ref) ? p.id : candidate.ref)
    }
    if (d.label !== 'undetermined' && requiredEvidenceFields(state, candidate).some(field =>
      !d.citations.some(c => c.field === field && c.origin === 'source' && state.promotedEvidence.some(e =>
        e.candidateRef === candidate.ref && e.evidenceId === c.passage_id && e.field === field)))) {
      throw new RetrievalError('INVALID_REQUEST', '判断缺少当前要求的、实际送达模型的原文引用；请定向读取后重新复核。')
    }
    const judgment = { candidateRef: candidate.ref as TicketCandidateRef, verdict: d.label, reason: d.reason,
      evidenceRefs: [...new Set(evidenceRefs.length ? evidenceRefs : [candidate.ref])], basis: d.basis,
      ...(proxy ? { operatorInference: inference } : { operatorManifestId: manifest!.id }) }
    // Operator visibility is scoped to its own request, never faked as the main Agent.
    current = { ...current, ...admitDecision(current, { stateId: current.stateId, judgments: [judgment],
      gaps: current.gaps.filter(g => g.evaluator === 'model'), action: { kind: 'inspect', fields: [] } }, manifest?.roleId ?? 'operator:proxy', proxy) }
  }
  return { judgments: current.judgments ?? [], selectedCandidateRefs: current.selectedCandidateRefs,
    excludedCandidateRefs: current.excludedCandidateRefs, expertConflicts: current.expertConflicts ?? [] }
}

export function semanticPlanPatch(state: RetrievalState, plan: SemanticQueryPlan): Partial<RetrievalState> {
  if (plan.schemaVersion !== 1 || plan.original !== state.query.original || plan.inputGeneration !== (state.inputGeneration ?? 0)
    || !plan.instruction.trim() || !plan.manifest_id || !plan.steps.length
    || !['adaptive', 'examples', 'all'].includes(plan.goal.mode)
    || (plan.goal.mode === 'examples' ? !Number.isSafeInteger(plan.goal.count) || plan.goal.count! < 1 : plan.goal.count !== null)
    || [...plan.keywords, ...plan.retrieval_expressions].some(s => !s.trim() || s.length > 4000)) throw new RetrievalError('INVALID_REQUEST', '自然语言算子计划无效或已过期。')
  const countPolicy = plan.goal.mode === 'all' ? 'exhaustive' as const : plan.goal.mode === 'examples' ? 'explicit' as const : 'adaptive' as const
  const { requestedCount: _taskCount, ...task } = state.task
  const { requestedCount: _specCount, queryPlan: _oldAst, requiredConcepts: _concepts, ...spec } = state.query.spec
  const { resultLimit: _limit, maxResults: _oldLimit, queryPlan: _plan, nlp: _nlp, logic: _logic, ...contract } = state.query.contract!
  return { task: { ...task, countPolicy, ...(plan.goal.count === null ? {} : { requestedCount: plan.goal.count }), completenessRequirement: countPolicy === 'exhaustive' ? 'exhaustive' : 'top_k' },
    query: { ...state.query, unresolvedConstraints: [], spec: { ...spec, countPolicy, ambiguities: [], compilerVersion: 'python-semantic-plan-v1',
      ...(plan.goal.count === null ? {} : { requestedCount: plan.goal.count }) },
    contract: { ...contract, schemaVersion: 10, semanticPlan: plan, userRequirements: [], ambiguities: [],
      resultPolicy: countPolicy === 'exhaustive' ? 'exhaustive_current_snapshot' : countPolicy === 'explicit' ? 'explicit_top_k' : 'adaptive_top_k',
      ...(plan.goal.count === null ? {} : { resultLimit: plan.goal.count }), compilerVersion: 'python-semantic-plan-v1' } } }
}

export function validateOperatorArtifact(state: RetrievalState, artifact: import('@retrieval-agent/contracts').OperatorArtifact): void {
  const manifests = artifact.manifestIds.map(id => state.contextManifests?.find(m => m.id === id))
  const operation = artifact.operation === 'sem_topk' ? 'sem_topk_compare' : artifact.operation
  const emptyJoin = artifact.operation === 'sem_join' && artifact.events.length === 1
    && (artifact.events[0] as { type?: string; candidate_pairs?: number }).type === 'join_summary'
    && (artifact.events[0] as { candidate_pairs?: number }).candidate_pairs === 0
  if (!emptyJoin && (artifact.operation !== 'sem_topk' || artifact.candidateRefs.length > 1) && !manifests.length
    || manifests.some(m => !m?.operator || m.operator.operation !== operation || m.measurement !== 'dsh_request'
      || m.inputGeneration !== artifact.inputGeneration || m.candidateRefs.some(ref => !artifact.candidateRefs.includes(ref)))) {
    throw new RetrievalError('INVALID_REQUEST', '算子产物缺少本次实际请求来源。')
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    const obj = value as Record<string, unknown>
    if ('passage_id' in obj && 'quote' in obj) {
      const c = obj as unknown as import('@retrieval-agent/contracts').OperatorCitation
      if (!manifests.some(m => m?.operator?.records.some(r => r.ref === c.ref && r.version === c.version && r.content_hash === c.content_hash
        && r.passages.some(p => p.id === c.passage_id && p.field === c.field && p.origin === c.origin && c.start >= p.start
          && c.end <= p.start + p.text.length && c.end - c.start === c.quote.length && p.text.slice(c.start - p.start, c.end - p.start) === c.quote)))) {
        throw new RetrievalError('INVALID_REQUEST', '算子产物引用未送达的工单片段。')
      }
    }
    Object.values(obj).forEach(visit)
  }
  artifact.events.forEach(visit)
}
