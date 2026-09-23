const make = (tag, value = '', cls = '') => { const e = document.createElement(tag); e.textContent = value; e.className = cls; return e }
const action = (label, run, cls = 'link') => { const e = make('button', label, cls); e.type = 'button'; e.onclick = run; return e }

/** 一个节点表达真实的抽样判断；知识随请求关联到工单，不伪造额外专家调用。 */
export function renderJudgment(o, library, { openKnowledge, openCandidate, showProcess }) {
  const usage = o.samplingKnowledge, learning = o.retrieval?.learning
  const catalog = library?.domains.flatMap(d => d.entries.map(k => ({ ...k, domainTitle: d.title }))) ?? []
  const knowledge = usage.entries.map(k => ({ ...k, ...catalog.find(e => k.reference ? e.reference === k.reference : e.id === k.id) }))
  const title = k => k.title ?? o.retrieval?.plan?.knowledgeRoutes.find(r => r.entry_id === k.id)?.title ?? k.id
  const running = !o.terminal && o.retrieval?.filterActivity === 'running'
  const card = make('article', '', 'expert-node sampling-judgment'); card.id = 'sampling-judgment'
  card.dataset.state = running ? 'running' : o.retrieval?.filterActivity === 'failed' ? 'failed' : 'completed'
  const head = make('div', '', 'expert-node-head')
  head.append(make('span', '判', 'expert-avatar'), make('strong', '领域知识辅助判断'), make('small', running ? '正在判断' : '判断记录已保存', 'expert-state'))
  card.append(head)
  const counts = make('div', '', 'judgment-metrics')
  for (const [value, label] of [[usage.requestCount, '次知识辅助请求'], [usage.sampleCount, '条去重样本'], [usage.entries.length, '条知识']]) {
    const metric = make('span'); metric.append(make('strong', value.toLocaleString()), make('small', label)); counts.append(metric)
  }
  card.append(counts)
  const groups = new Map()
  for (const k of knowledge) { const domain = k.domainTitle ?? '本轮领域知识'; if (!groups.has(domain)) groups.set(domain, []); groups.get(domain).push(k) }
  for (const [domain, entries] of groups) {
    const group = make('div', '', 'judgment-domain'); group.append(make('strong', domain))
    const links = make('div', '', 'expert-knowledge')
    for (const k of entries) {
      const link = action(title(k), () => openKnowledge(k.id), 'knowledge-chip'); link.disabled = Boolean(k.revoked)
      link.title = `已带入 ${k.requestCount} 次判断请求，涉及 ${k.sampleCount} 条工单`; links.append(link)
    }
    group.append(links); card.append(group)
  }
  if (learning) card.append(make('p', `已确定：相关 ${learning.positiveCount ?? 0} 条、不相关 ${learning.negativeCount ?? 0} 条；未决 ${learning.unresolvedCount ?? 0} 条。`, 'judgment-outcome'))
  const actions = make('div', '', 'row'); actions.append(action('查看抽样与选模过程 ↗', showProcess)); card.append(actions)
  const requests = usage.requests ?? []
  if (requests.length) {
    const trace = make('details', '', 'judgment-trace'); trace.append(make('summary', `查看知识 → 样本请求引用关系（${requests.length} 次）`))
    const rows = make('div'), pager = make('div', '', 'row judgment-pagination'); trace.append(rows, pager)
    // 按需展开十次请求，保留实际工单身份并复用已有详情入口。
    function renderPage(offset) {
      trace.dataset.offset = String(offset)
      rows.replaceChildren(...requests.slice(offset, offset + 10).map((request, i) => {
        const row = make('section', '', 'judgment-request'), entries = request.knowledge.map(k => knowledge.find(x => x.id === k.id) ?? k)
        row.append(make('strong', `判断请求 ${offset + i + 1}`))
        const refs = make('div', '', 'judgment-links')
        for (const k of entries) refs.append(action(title(k), () => openKnowledge(k.id), 'knowledge-chip'))
        if (!entries.length) refs.append(make('span', '直接依据业务判据与工单原文', 'muted'))
        row.append(refs, make('span', '↓ 涉及工单', 'judgment-edge'))
        const candidates = make('div', '', 'judgment-links')
        for (const [index, c] of request.candidates.entries()) candidates.append(action(c.displayId ?? `查看本组工单 ${index + 1}`, () => openCandidate(c), 'knowledge-chip'))
        row.append(candidates); return row
      }))
      const previous = action('上一组', () => renderPage(offset - 10)), next = action('下一组', () => renderPage(offset + 10))
      previous.disabled = offset === 0; next.disabled = offset + 10 >= requests.length
      pager.replaceChildren(previous, make('span', `${offset + 1}–${Math.min(offset + 10, requests.length)} / ${requests.length} 次请求`), next)
    }
    trace.ontoggle = () => { if (trace.open && !rows.childElementCount) renderPage(Number(trace.dataset.offset ?? 0)) }
    card.append(trace)
  }
  return card
}
