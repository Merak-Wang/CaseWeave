import { createHash } from 'node:crypto'
import { RetrievalError, isReadableTicketField, type RetrievalState } from '@retrieval-agent/contracts'
import { createTicketResultCollection } from '@retrieval-agent/domain/result'

export interface ReportCitation {
  id: string; candidateRef: string; displayId: string; sourceVersion: string; contentHash: string;
  field: string; text: string; start: number; end: number; origin: unknown;
}
export interface ReportNarrative { paragraphs: { text: string; citations: string[] }[] }
export interface RetrievalReport {
  schemaVersion: 1; taskId: string; resultRevision: string; generatedAt: string; audience: 'operator' | 'handoff';
  confirmedCount: number; confirmedSetSha256: string; conclusion: string;
  scope: { originalQuery: string; inputs: readonly { kind: string; text?: string }[]; conditions: unknown;
    unresolved: readonly string[]; snapshot: unknown; fields: readonly { key: string; label: string; accessLevel: string }[]; wiki: unknown };
  coverage: { stoppingReason: string; semanticStatus: 'satisfied' | 'no_result' | 'incomplete'; complete: boolean; resultPagesExhausted: boolean; semanticRecallKnown: boolean;
    assessment?: { checked: readonly string[]; remaining: readonly string[]; nextAction: string; nextActionValue: string };
    resultMayBeIncomplete: boolean; searches: unknown; gaps: readonly { kind: string; description: string }[] };
  examples: { candidateRef: string; displayId: string; title: string; reason: string; citations: string[] }[];
  citations: ReportCitation[];
  narrative: { status: 'structured' | 'model'; paragraphs: ReportNarrative['paragraphs']; reason?: string };
  usage: string[];
}

/** Report facts and examples originate only in this version's confirmed result. */
export function createRetrievalReport(state: RetrievalState, inputs: RetrievalReport['scope']['inputs'], audience: RetrievalReport['audience'] = 'operator'): RetrievalReport {
  const result = createTicketResultCollection(state)
  if (['snapshot_invalid', 'permission_blocked'].includes(state.termination)) throw new RetrievalError('SNAPSHOT_INVALID', '结果访问资格失效，请重新复核。')
  const citations: ReportCitation[] = []
  const examples = result.tickets.slice(0, 5).map(c => {
    const judgment = result.judgments.find(j => j.candidateRef === c.ref)
    const selected = result.evidence.filter(e => e.candidateRef === c.ref && judgment?.evidenceRefs.includes(e.evidenceId)
      && state.modelVisibleEvidenceIds?.includes(e.evidenceId)).slice(0, 2)
    for (const e of selected) citations.push({ id: e.evidenceId, candidateRef: c.ref, displayId: c.displayId,
      sourceVersion: c.sourceVersion, contentHash: c.contentHash, field: e.field, text: e.text.slice(0, 1600),
      start: e.start, end: e.start + Math.min(1600, e.text.length), origin: e.origin ?? { kind: 'unknown' } })
    if (judgment?.evidenceRefs.includes(c.ref) && state.modelVisibleCandidateRefs?.includes(c.ref)) {
      citations.push({ id: c.ref, candidateRef: c.ref, displayId: c.displayId, sourceVersion: c.sourceVersion, contentHash: c.contentHash,
        field: 'summary', text: c.summary.slice(0, 1600), start: 0, end: Math.min(1600, c.summary.length), origin: c.summaryOrigin ?? { kind: 'unknown' } })
    }
    return { candidateRef: c.ref, displayId: c.displayId, title: c.title, reason: judgment?.reason ?? '历史确认未保存逐条理由。', citations: citations.filter(e => e.candidateRef === c.ref).map(e => e.id) }
  })
  const s = state.snapshot
  return { schemaVersion: 1, taskId: state.retrievalId, resultRevision: result.resultRevision,
    generatedAt: new Date().toISOString(), audience, confirmedCount: result.tickets.length,
    confirmedSetSha256: createHash('sha256').update(JSON.stringify(result.tickets.map(c => [c.ref, c.displayId, c.sourceVersion, c.contentHash]))).digest('hex'),
    conclusion: result.explanation ?? (result.tickets.length ? '本轮已确认以下工单。' : '本次尚无可确认结果。'),
    scope: { originalQuery: state.query.original, inputs: inputs.map(i => ({ kind: i.kind, ...(i.text === undefined ? {} : { text: i.text }) })), conditions: state.query.confirmedConstraints, unresolved: state.query.unresolvedConstraints,
      snapshot: s ? { shortId: s.shortId, providerId: s.providerId, sourceVersion: s.sourceVersion, indexVersion: s.indexVersion, createdAt: s.createdAt } : null,
      fields: s?.fieldCatalog.filter(isReadableTicketField).map(f => ({ key: f.key, label: f.label, accessLevel: f.accessLevel })) ?? [],
      wiki: state.knowledgeCatalog ?? null },
    coverage: { stoppingReason: result.stoppingReason, semanticStatus: result.stoppingReason === 'top_k_accepted' ? 'satisfied' : result.stoppingReason === 'no_result' ? 'no_result' : 'incomplete', complete: result.complete, resultPagesExhausted: result.resultPagesExhausted,
      semanticRecallKnown: result.semanticRecallKnown, resultMayBeIncomplete: result.resultMayBeIncomplete,
      searches: { channels: state.searchProgress?.channels ?? [], directions: (state.sharedSearches ?? []).map(search => ({ query: search.spec.normalizedQuery, mode: search.spec.mode })), boundary: state.lastPage?.boundary },
      gaps: state.gaps.filter(g => ['open', 'unknown'].includes(g.status)).map(g => ({ kind: g.kind, description: g.description ?? g.kind })) },
    examples, citations, narrative: { status: 'structured', paragraphs: [] },
    usage: [audience === 'handoff' ? '交接时将报告、确认工单文件与范围说明一并提供，并按结果版本核对对应关系。'
      : '复核时从代表性引用打开对应工单；需要补充条件或纠正相关性时，回到原任务提交反馈并等待新一轮判断。',
      '仅交付本结果版本中已确认的工单；代表性依据不是完整清单，完整集合在 CSV/JSONL 中。',
      '工单相关性确认不等于对工单所述原因作出独立事实认定。',
      '概览模板包含摘要与判断；正文模板额外包含当前来源允许交接的内容，缺失字段单独列明。',
      'CSV 对表格公式前缀加单引号；JSONL 保留原始字段值。以 candidateRef、sourceVersion、contentHash 和 evidenceRefs 对照来源。'] }
}

export function validateReportNarrative(value: unknown, report: RetrievalReport): ReportNarrative {
  const fail = (): never => { throw new RetrievalError('PROTOCOL_MISMATCH', '报告解释或引用未通过校验。') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'paragraphs') fail()
  const paragraphs = (value as ReportNarrative).paragraphs
  if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.length > 4) fail()
  const allowed = new Set(report.citations.map(c => c.id))
  for (const p of paragraphs) {
    if (!p || Object.keys(p).sort().join() !== 'citations,text' || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 1000
      || !Array.isArray(p.citations) || !p.citations.length || p.citations.length > 10
      || new Set(p.citations).size !== p.citations.length || p.citations.some(id => !allowed.has(id))) fail()
  }
  return { paragraphs }
}

// Escape user/model/source text before writing a portable Markdown document.
const md = (value: unknown): string => String(value ?? '').replace(/[\\`*_[\]<>#|]/gu, '\\$&')
// MySQL JSON normalizes object key order. Saved report integrity must survive that round trip.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value
const stableJson = (value: unknown): string => JSON.stringify(canonical(value))
export function reportMarkdown(r: RetrievalReport): string {
  const labels: Record<string, string> = { region: '地区', status: '状态', createdAt: '创建时间', product: '产品', ticketId: '工单编号' }
  const ops: Record<string, string> = { eq: '为', neq: '不是', gte: '不早于', lte: '不晚于', contains: '包含' }
  const conditions = (r.scope.conditions as { field: string; op: string; value: unknown }[]).map(c => `${labels[c.field] ?? c.field}${ops[c.op] ?? c.op}${String(c.value)}`).join('；')
  const lines = [`# 工单检索${r.audience === 'handoff' ? '交接' : '复核'}报告`, '', `确认数量：${r.confirmedCount}`, `结果版本：${md(r.resultRevision)}`, `生成时间：${r.generatedAt}`, '',
    '## 检索结论', '', md(r.conclusion), '', '## 查询范围', '', `原始要求：${md(r.scope.originalQuery)}`,
    ...r.scope.inputs.filter(i => i.kind !== 'query').map(i => `- ${{ supplement: '用户补充', answer: '用户答复', feedback: '相关性反馈', cancel: '取消' }[i.kind] ?? md(i.kind)}：${md(i.text)}`),
    `明确条件：${md(conditions || '无额外结构化条件')}`, `待核实要求：${md(r.scope.unresolved.join('；') || '无')}`,
    '', '## 覆盖与停止', '',
    `停止性质：${{ satisfied: 'Agent 判定本轮要求已满足', no_result: '本轮无可确认结果', incomplete: '本轮未完成' }[r.coverage.semanticStatus]}；当前表达式取完：${r.coverage.resultPagesExhausted ? '是' : '否'}。`,
    r.coverage.semanticRecallKnown ? '已记录语义覆盖判断。' : '未建立全库语义召回率；不能据此宣称找全。',
    ...(r.coverage.assessment ? [`已核查：${md(r.coverage.assessment.checked.join('；'))}`, `剩余范围：${md(r.coverage.assessment.remaining.join('；') || '无另列范围')}`,
      `下一动作：${md(r.coverage.assessment.nextAction)}；预期价值：${md(r.coverage.assessment.nextActionValue)}`] : []),
    ...r.coverage.gaps.map(g => `- ${md(g.description.replace('semanticRecallKnown=false；', '尚无全库语义覆盖结论；'))}`), '', '## 依据解释', '',
    ...(r.narrative.status === 'model' ? r.narrative.paragraphs.map(p => `${md(p.text)} ${p.citations.map(id => `[${md(id)}](#ref-${r.citations.findIndex(c => c.id === id) + 1})`).join(' ')}`)
      : [`采用结构化说明。${md(r.narrative.reason ?? '模型叙事尚未生成。')}`]), '',
    ...r.examples.flatMap(e => [`### ${md(e.displayId)} · ${md(e.title)}`, '', md(e.reason), ...e.citations.map(id => `引用：[${md(id)}](#ref-${r.citations.findIndex(c => c.id === id) + 1})`), '']),
    '## 引用与可见片段', '', ...r.citations.flatMap((c, i) => [`<a id="ref-${i + 1}"></a>`, `### ${i + 1}. ${md(c.displayId)} / ${md(c.field)}`, '',
      `身份：${md(c.id)}；来源版本：${md(c.sourceVersion)}；内容哈希：${c.contentHash}；位置：${c.start}–${c.end}；来源性质：${md(stableJson(c.origin))}`, '', md(c.text), '']),
    '## 交付与使用', '', ...r.usage.map(t => `- ${md(t)}`), '', '## 来源与复现记录', '', `来源代次：${md(stableJson(r.scope.snapshot))}`,
    `已执行方向：${md(stableJson(r.coverage.searches))}`, `集合 SHA-256：${r.confirmedSetSha256}`, `可用正文字段：${md(r.scope.fields.map(f => `${f.label} (${f.key})`).join('、'))}`, '']
  return lines.join('\n')
}
