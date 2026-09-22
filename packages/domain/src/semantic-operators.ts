import { RetrievalError, type OperatorRecord, type OperatorDecision, type RetrievalState, type TicketCandidate,
  type TicketCandidateRef, type TicketEvidenceSegment, type SemanticQueryPlan } from '@retrieval-agent/contracts'
import { mergeCandidateJudgments } from './decision.js'
import { operatorRequiredFields, requiredEvidenceFields } from './evidence-requirements.js'
export { operatorRequiredFields } from './evidence-requirements.js'

/** 构造本条工单已授权的材料；新证据追加片段，不覆盖旧片段。 */
export function operatorRecord(state: RetrievalState, candidate: TicketCandidate, evidence = state.promotedEvidence): OperatorRecord {
  const origin = (field: string) => state.snapshot?.fieldCatalog.find(f => f.key === field)?.capability?.origin ?? 'unknown'
  const passages: OperatorRecord['passages'][number][] = [
    { id: 'displayId', field: 'displayId', text: candidate.displayId, start: 0, origin: 'source' },
    { id: 'title', field: 'title', text: candidate.title, start: 0, origin: origin('title') },
    { id: 'summary', field: 'summary', text: candidate.summary, start: 0, origin: candidate.summaryOrigin?.kind ?? 'unknown' },
  ]
  for (const [field, value] of Object.entries(candidate.l0)) if (value !== null && value !== undefined) {
    passages.push({ id: `l0:${field}`, field, text: typeof value === 'string' ? value : JSON.stringify(value), start: 0, origin: origin(field) })
  }
  for (const e of evidence) if (e.candidateRef === candidate.ref) passages.push({ id: e.evidenceId, field: e.field,
    text: e.text, start: e.start, origin: e.origin?.kind ?? 'unknown' })
  const unresolved = state.judgments?.find(j => j.candidateRef === candidate.ref && j.verdict === 'undetermined')
  return { ref: candidate.ref, version: candidate.sourceVersion, content_hash: candidate.contentHash, passages,
    attributes: { summary_origin: candidate.summaryOrigin ?? { kind: 'unknown' },
      // 重读后保留待解决的具体疑点；它是复核问题，不是来源事实或新的纳入条件。
      ...(unresolved ? { unresolved_issue: unresolved.reason } : {}),
      required_evidence_fields: candidate.summaryOrigin?.verification === 'conflicting' ? candidate.summaryOrigin.requiredEvidenceFields ?? [] : [] } }
}

/** 批量构造和核验共用一次证据分组，避免每条工单重新扫描全部正文。 */
export function operatorRecords(state: RetrievalState, candidates: readonly TicketCandidate[]): OperatorRecord[] {
  if (!candidates.length) return []
  const evidence = new Map<TicketCandidateRef, TicketEvidenceSegment[]>()
  for (const item of state.promotedEvidence) {
    const rows = evidence.get(item.candidateRef) ?? []
    rows.push(item); evidence.set(item.candidateRef, rows)
  }
  return candidates.map(c => operatorRecord(state, c, evidence.get(c.ref) ?? []))
}

export function validateOperatorRecords(state: RetrievalState, rows: readonly OperatorRecord[]): void {
  const candidates = new Map(state.candidates.map(c => [c.ref, c]))
  const current = operatorRecords(state, rows.map(row => {
    const candidate = candidates.get(row.ref as TicketCandidateRef)
    if (!candidate || row.version !== candidate.sourceVersion || row.content_hash !== candidate.contentHash) throw new RetrievalError('INVALID_REQUEST', '算子记录不属于当前来源版本。')
    return candidate
  }))
  rows.forEach((row, i) => {
    const passages = new Map(current[i]!.passages.map(p => [p.id, p]))
    if (!Array.isArray(row.passages) || new Set(row.passages.map(p => p.id)).size !== row.passages.length
      || row.passages.some(p => {
        const actual = passages.get(p.id)
        return !actual || actual.field !== p.field || actual.text !== p.text || actual.start !== p.start || actual.origin !== p.origin
      })) throw new RetrievalError('INVALID_REQUEST', '算子收到的片段与当前授权证据不一致。')
  })
}

export function admitOperatorDecisions(state: RetrievalState, generation: number, decisions: readonly OperatorDecision[]): Partial<RetrievalState> {
  if (generation !== (state.inputGeneration ?? 0)) throw new RetrievalError('INVALID_TRANSITION', '算子结果属于旧输入代次。')
  if (state.phase === 'stopped' || state.phase === 'awaiting_clarification') throw new RetrievalError('INVALID_TRANSITION', '当前任务不能接收判断。')
  const candidates = new Map(state.candidates.map(c => [c.ref, c]))
  const requestedManifests = new Set(decisions.flatMap(d => d.manifest_id ? [d.manifest_id] : []))
  const manifests = new Map((state.contextManifests ?? []).filter(m => m.operator?.operation === 'sem_filter'
    && requestedManifests.has(m.operator.pythonManifestId) && m.measurement === 'dsh_request'
    && m.inputGeneration === generation).map(m => [m.operator!.pythonManifestId, m]))
  const manifestRows = new Map([...manifests].map(([id, m]) => [id, new Map(m.operator!.records.map(r => [r.ref, r]))]))
  const fallbackRows = new Map(operatorRecords(state, decisions.filter(d => d.basis === 'proxy' || d.basis === 'unresolved')
    .flatMap(d => { const c = candidates.get(d.ref as TicketCandidateRef); return c ? [c] : [] })).map(r => [r.ref, r]))
  const evidence = new Map<string, TicketEvidenceSegment>(state.promotedEvidence.map(e => [e.evidenceId, e]))
  const planFields = operatorRequiredFields(state.query.contract?.semanticPlan, state.snapshot?.fieldCatalog)
  const judgments: import('@retrieval-agent/contracts').RetrievalCandidateJudgment[] = []
  const seen = new Set<string>()
  for (const d of decisions) {
    const proxy = d.basis === 'proxy', inference = d.inference
    const learned = proxy && inference?.algorithm === 'active'
    const admissible = learned ? inference.inferred && inference.phase === 'prediction'
      && inference.input_revision === generation && Boolean(inference.model_id && inference.predicate_key && inference.feature_id)
      && (inference.training_records ?? 0) >= 2 && (inference.proposal !== 'linear' || (inference.fit_count ?? 0) > 0)
      && inference.checks?.length === 3 && inference.checks.every(c => c.passed && c.sampled <= c.population)
      : inference?.algorithm === 'cluster' && inference.inferred && inference.phase === 'check'
        && inference.error_upper === 0 && inference.tolerance === 0 && (inference.alpha ?? 0) > 0 && (inference.alpha ?? 1) <= .005
    // 代理推断来自可信 Python 结果通道，携带数值检验结果，不伪造逐条模型回执。
    if (seen.has(d.ref) || !['model', 'reused_model', 'unresolved', 'proxy'].includes(d.basis)
      || (proxy && (!inference || !admissible
        || inference.proposed !== Number(d.label === 'accept') || d.manifest_id !== null))) throw new RetrievalError('INVALID_REQUEST', '算子结果重复或是未经准入的代理推断。')
    seen.add(d.ref)
    const missing = d.basis === 'unresolved' && d.label === 'undetermined' && !d.manifest_id && !d.citations.length && !d.knowledge_ids.length
    const manifest = d.manifest_id ? manifests.get(d.manifest_id) : undefined
    const candidate = candidates.get(d.ref as TicketCandidateRef)
    const row = proxy || missing ? fallbackRows.get(d.ref) : manifestRows.get(d.manifest_id!)?.get(d.ref)
    if (!row || (!proxy && !missing && (!manifest || d.knowledge_ids.some(id => !manifest.operator!.knowledgeIds.includes(id))
      || (manifest.releaseId && manifest.releaseId !== state.knowledgeCatalog?.releaseId)))) throw new RetrievalError('INVALID_REQUEST', '算子缺少当前实际模型请求或引用了未送达知识。')
    if (!candidate || candidate.sourceVersion !== row.version || candidate.contentHash !== row.content_hash) throw new RetrievalError('INVALID_REQUEST', '算子记录不属于当前来源版本。')
    if (learned && (inference.source_version !== candidate.sourceVersion || inference.content_hash !== candidate.contentHash || d.citations.length)) throw new RetrievalError('INVALID_REQUEST', '学习推断来源已变化或伪造了逐条引文。')
    if (!d.reason.trim() || d.reason.length > 1000 || !['accept', 'exclude', 'undetermined'].includes(d.label)
      || (d.label !== 'undetermined' && (d.basis === 'unresolved' || (!learned && !d.citations.length)))) throw new RetrievalError('INVALID_REQUEST', '算子确定判断缺少依据或理由无效。')
    const evidenceRefs: string[] = []
    for (const citation of d.citations) {
      const p = row.passages.find(p => p.id === citation.passage_id)
      if (!p || citation.ref !== row.ref || citation.version !== row.version || citation.content_hash !== row.content_hash
        || citation.field !== p.field || citation.origin !== p.origin || !citation.quote
        || !Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end)
        || citation.start < p.start || citation.end > p.start + p.text.length || citation.end - citation.start !== citation.quote.length
        || p.text.slice(citation.start - p.start, citation.end - p.start) !== citation.quote) throw new RetrievalError('INVALID_REQUEST', '算子引文不属于本条实际送达片段。')
      evidenceRefs.push(evidence.get(p.id)?.candidateRef === row.ref ? p.id : candidate.ref)
    }
    if (!learned && d.label !== 'undetermined' && requiredEvidenceFields(state, candidate, planFields).some(field =>
      !d.citations.some(c => {
        const e = evidence.get(c.passage_id)
        return c.field === field && c.origin === 'source' && e?.candidateRef === candidate.ref && e.field === field
      }))) {
      throw new RetrievalError('INVALID_REQUEST', '判断缺少当前要求的、实际送达模型的原文引用；请定向读取后重新复核。')
    }
    judgments.push({ candidateRef: candidate.ref, verdict: d.label, reason: d.reason,
      evidenceRefs: [...new Set(evidenceRefs.length ? evidenceRefs : [candidate.ref])], basis: d.basis,
      ...(proxy ? { operatorInference: inference } : manifest ? { operatorManifestId: manifest.id } : {}) })
  }
  return mergeCandidateJudgments(state, judgments)
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
  const operation = artifact.operation
  const fieldExtraction = artifact.operation === 'sem_extract' && artifact.events.length > 0 && artifact.events.every(e =>
    (e as { type?: string; value?: { basis?: string } }).type === 'transform' && (e as { value?: { basis?: string } }).value?.basis === 'field')
  const directRows = fieldExtraction ? operatorRecords(state, state.candidates.filter(c => artifact.candidateRefs.includes(c.ref))) : []
  if (!fieldExtraction && !manifests.length
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
      if (![...directRows, ...manifests.flatMap(m => m?.operator?.records ?? [])].some(r => r.ref === c.ref && r.version === c.version && r.content_hash === c.content_hash
        && r.passages.some(p => p.id === c.passage_id && p.field === c.field && p.origin === c.origin && c.start >= p.start
          && c.end <= p.start + p.text.length && c.end - c.start === c.quote.length && p.text.slice(c.start - p.start, c.end - p.start) === c.quote))) {
        throw new RetrievalError('INVALID_REQUEST', '算子产物引用未送达的工单片段。')
      }
    }
    Object.values(obj).forEach(visit)
  }
  artifact.events.forEach(visit)
}
