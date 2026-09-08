const $ = id => document.getElementById(id)
const make = (tag, value = '', cls = '') => { const e = document.createElement(tag); e.textContent = value; e.className = cls; return e }
const action = (label, run, cls = '') => { const b = make('button', label, cls); b.type = 'button'; b.onclick = run; return b }
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const statusNames = { pending: '等待开始', running: '正在核查', completed: '已提交', failed: '未完成', superseded: '已更新' }
const workNames = { starting: '正在阅读领域知识', inspect: '正在核对工单原文', search: '正在补充搜索', report: '正在整理核查发现' }
const stages = [['search', '并行快查'], ['review', '阅读原文'], ['experts', '专家协作'], ['synthesis', '汇总结果']]

/** Reveal only newly committed public text; restored history is rendered immediately. */
export function revealText(el, value, animate = false) {
  if (el.dataset.fullText === value) return
  el.dataset.fullText = value
  el.getAnimations().forEach(a => a.cancel())
  el.textContent = value
  if (animate && !reduced()) el.animate([{ clipPath: 'inset(0 100% 0 0)', opacity: .4 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], { duration: Math.min(850, 250 + value.length * 7), easing: 'ease-out' })
}

export function createOrchestrationUI({ api, endpoint, getSnapshot, getTaskId, showView, expertDetail }) {
  let epoch = 0, current, library, libraryRelease, libraryPending = false, filter = '', cardKeys = new Map(), initialized = false
  let lastActivity = '', returnFocus, returnScroll, knowledgeRequest = 0, disconnected = false
  const logKeys = new Set()
  const valid = (e, s) => e === epoch && s === getSnapshot()?.orchestration?.inputGeneration
  const usedBy = reference => (current?.experts ?? []).filter(e => e.knowledge.some(k => k.reference === reference && k.used))
  function clock() {
    const start = Date.parse(current?.startedAt), end = current?.terminal ? Date.parse(current.updatedAt) : Date.now()
    $('elapsed').textContent = Number.isFinite(start) ? (current?.terminal ? '用时 ' : '') + Math.floor(Math.max(0, end - start) / 60000) + ':' + String(Math.floor(Math.max(0, end - start) / 1000) % 60).padStart(2, '0') : ''
  }
  let timer = setInterval(clock, 1000)
  function closeKnowledge() {
    knowledgeRequest++; $('knowledge-dialog').close(); $('knowledge-body').replaceChildren()
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    if (returnScroll) window.scrollTo(returnScroll.x, returnScroll.y)
  }
  function reset() {
    epoch++; current = undefined; library = undefined; libraryRelease = undefined; libraryPending = false; initialized = false
    cardKeys.clear(); logKeys.clear(); lastActivity = ''; filter = ''; closeKnowledge()
    for (const id of ['expert-lanes', 'activity-log', 'knowledge-list', 'domain-filters', 'stage-rail', 'live-metrics']) $(id).replaceChildren()
    $('live-work').dataset.state = 'running'; $('live-title').textContent = '正在准备检索'; delete $('live-title').dataset.fullText; $('elapsed').textContent = ''
    $('knowledge-search').value = ''
    delete $('stage-rail').dataset.key; delete $('domain-filters').dataset.key; delete $('expert-lanes').dataset.key
  }
  function appendActivity(id, actor, title, kind, fresh) {
    if (logKeys.has(id)) return
    logKeys.add(id)
    const row = make('article', '', 'activity-item'), dot = make('span', kind === 'finding' ? '✓' : '·', 'activity-dot')
    row.dataset.activity = id; dot.setAttribute('aria-hidden', 'true')
    const copy = make('div'); copy.append(make('small', actor), make('p', title)); row.append(dot, copy)
    $('activity-log').append(row)
    if (fresh && !reduced()) row.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 320, easing: 'ease-out' })
    while ($('activity-log').children.length > 20) $('activity-log').firstElementChild.remove()
  }
  function update(s, offline = false) {
    disconnected = offline
    const o = s.orchestration, wasInitialized = initialized
    current = o
    const unavailable = Boolean(s.failure) || ['error', 'permission_blocked', 'snapshot_invalid'].includes(s.node?.status)
    if (['permission_blocked', 'snapshot_invalid'].includes(s.node?.status)) { closeKnowledge(); library = undefined; $('knowledge-list').replaceChildren(); $('expert-lanes').replaceChildren(); $('activity-log').replaceChildren() }
    const busy = !unavailable && !o?.terminal && !s.node?.result && (!s.question || o?.experts.some(e => ['pending', 'running'].includes(e.status)))
    $('live-work').dataset.state = unavailable ? 'error' : disconnected ? 'offline' : busy ? 'running' : o?.terminal ? ['top_k_accepted', 'no_result'].includes(o.outcome) ? 'done' : 'stopped' : 'waiting'
    const working = o?.experts.filter(e => e.status === 'running') ?? []
    const last = s.conversation?.filter(c => c.role === 'assistant').at(-1)
    const titles = { search: '正在从关键词与语义中寻找线索', review: '正在阅读原文，核实业务情况', experts: working.length + ' 位领域专家正在独立核查', synthesis: '正在汇总发现，核对遗漏与分歧', finished: ['top_k_accepted', 'no_result'].includes(o?.outcome) ? '本轮检索已结束' : '本轮已停止，仍有未完成项' }
    const title = unavailable ? '检索暂时无法继续' : disconnected ? o?.terminal ? '连接已断开，显示已保存结果' : '正在重连，后台检索仍在继续' : s.question && !working.length ? '有一处范围需要你补充' : titles[o?.stage] ?? '正在准备检索'
    revealText($('live-title'), title, wasInitialized)
    const note = $('live-note')
    note.hidden = !busy || disconnected || !last
    if (last) revealText(note, last.text, wasInitialized)
    $('live-metrics').replaceChildren(...(o ? [['线索', o.counts.candidates], ['已读原文', o.counts.inspected], ['已确认', o.counts.confirmed]].map(([label, count]) => { const e = make('span'); e.append(make('strong', String(count)), make('small', label)); return e }) : []))
    const active = stages.findIndex(([key]) => key === o?.stage), done = o?.terminal && ['top_k_accepted', 'no_result'].includes(o.outcome)
    const railKey = [o?.stage, done, unavailable, o?.counts.experts, o?.counts.completedExperts, o?.counts.inspected, o?.fastQueryComplete, disconnected].join(':')
    if ($('stage-rail').dataset.key !== railKey) {
      $('stage-rail').dataset.key = railKey
      $('stage-rail').replaceChildren(...stages.map(([key, label], i) => {
        const e = make('li'), skipped = key === 'experts' && !o?.counts.experts && (done || o?.terminal)
        const observed = key === 'search' ? o?.fastQueryComplete || Boolean(s.node?.searchProgress?.channels.some(c => c.status === 'completed')) : key === 'review' ? o?.counts.inspected > 0 && (active > 1 || o.terminal) : key === 'experts' ? o?.counts.experts > 0 && o.counts.completedExperts === o.counts.experts : done
        e.dataset.state = skipped ? 'skipped' : i === active && !unavailable ? 'active' : observed ? 'done' : o?.terminal ? 'stopped' : 'upcoming'
        if (i === active && !unavailable) e.setAttribute('aria-current', 'step')
        e.append(make('span', skipped ? '−' : e.dataset.state === 'done' ? '✓' : e.dataset.state === 'stopped' ? '−' : String(i + 1), 'stage-number'), make('span', label), ...(skipped ? [make('small', '无需调用')] : [])); return e
      }))
    }
    clock()
    $('activity-caption').textContent = busy ? '随检索持续更新' : '已保存的执行记录'
    // Initial history is not replayed as fresh generation and never forces scrolling.
    const inputSeq = s.conversation?.findLast(c => c.role === 'user')?.seq ?? 0
    for (const c of (s.conversation ?? []).filter(c => c.seq >= inputSeq).slice(-12)) appendActivity('message-' + c.seq, c.role === 'user' ? '你' : '主检索 Agent', c.text, c.role, wasInitialized)
    if (o) {
      for (const c of s.node?.searchProgress?.channels ?? []) appendActivity('channel-' + c.channel + '-' + c.status + '-' + c.count, c.channel === 'keyword' ? '关键词检索' : '语义检索', c.status === 'completed' ? '找到 ' + c.count + ' 条线索' : c.status === 'failed' ? '此通道暂时不可用' : c.status === 'skipped' ? '本轮未使用此通道' : '正在搜索工单', 'search', wasInitialized)
      for (const e of o.experts) {
        const key = e.id + ':' + e.status + ':' + (e.activity?.at ?? e.actionsUsed)
        appendActivity(key, e.title + '专家', e.status === 'completed' ? '已提交 ' + e.findingCount + ' 条判断，交由主 Agent 核对' : e.status === 'failed' ? '本次专项核查未完成' : workNames[e.activity?.kind] ?? statusNames[e.status], e.status === 'completed' ? 'finding' : 'action', wasInitialized)
      }
      renderTeam(o)
      const consumption = JSON.stringify(o.experts.map(e => e.knowledge))
      if (library && consumption !== lastActivity && !$('knowledge-dialog').open) { renderLibrary(); lastActivity = consumption }
    }
    if (libraryRelease !== o?.catalog.releaseId) { library = undefined; libraryRelease = o?.catalog.releaseId; if (!$('collaboration-view').hidden) void loadLibrary() }
    initialized = true
  }
  function renderTeam(o) {
    $('team-count').textContent = o.experts.length ? o.counts.completedExperts + ' / ' + o.counts.experts + ' 专项已返回' : '按需求自动分工'
    $('coordinator-node').dataset.state = ['review', 'synthesis'].includes(o.stage) && !disconnected ? 'running' : ''
    $('coordinator-state').textContent = o.stage === 'experts' ? '已分派核查，等待专家返回' : o.terminal ? '本轮任务已结束' : '理解需求 · 选择专家 · 核对结论'
    $('synthesis-node').dataset.state = o.stage === 'synthesis' && !disconnected ? 'running' : ''
    $('synthesis-state').textContent = o.openConflicts ? o.openConflicts + ' 处判断分歧，继续核对证据' : o.terminal ? '已确认 ' + o.counts.confirmed + ' 条工单' : '专家发现经核实后，进入确认结果'
    const box = $('expert-lanes')
    if (!o.experts.length) {
      const key = 'empty-' + o.stage
      if (box.dataset.key !== key) { box.replaceChildren(make('p', o.terminal ? '本次由主 Agent 完成检索，未调用领域专家。' : o.stage === 'search' ? '快查完成后，按业务需要选择专家。' : '主 Agent 正在核查，需要专项分析时会自动分派。', 'team-empty')); box.dataset.key = key; cardKeys.clear() }
      return
    }
    if (box.dataset.key?.startsWith('empty')) box.replaceChildren()
    box.dataset.key = 'team'
    const ids = new Set(o.experts.map(e => e.id))
    for (const c of [...box.children]) if (!ids.has(c.dataset.expertId)) { cardKeys.delete(c.dataset.expertId); c.remove() }
    for (const e of o.experts) {
      let card = [...box.children].find(c => c.dataset.expertId === e.id)
      if (!card) {
        card = make('article', '', 'expert-node'); card.dataset.expertId = e.id
        const head = make('div', '', 'expert-node-head'), badge = make('span', e.title.slice(0, 1), 'expert-avatar')
        head.append(badge, make('strong', e.title), make('small', '', 'expert-state'))
        card.append(head, make('p', e.goal, 'expert-goal'), make('p', '', 'expert-action'), make('div', '', 'expert-knowledge'), make('small', '', 'expert-counts'), action('查看工作依据 ↗', () => expertDetail(e.id), 'link'))
        box.append(card)
      }
      const key = JSON.stringify([e, disconnected, o.terminal]); if (cardKeys.get(e.id) === key) continue; cardKeys.set(e.id, key)
      card.dataset.state = !o.terminal && !disconnected ? e.status : e.status === 'running' ? 'paused' : e.status
      card.querySelector('.expert-state').textContent = o.terminal && ['running', 'pending'].includes(e.status) ? '已停止' : statusNames[e.status]
      card.querySelector('.expert-action').textContent = e.status === 'running' && !o.terminal ? workNames[e.activity?.kind] ?? '正在核查业务情况' : e.status === 'completed' ? '已提交发现' : e.status === 'failed' ? '主 Agent 将处理剩余问题' : '已分配核查范围'
      const knowledge = card.querySelector('.expert-knowledge')
      const entries = e.knowledge.map(k => ({ ...k, title: library?.domains.flatMap(d => d.entries).find(x => x.reference === k.reference)?.title ?? '领域知识' }))
      const knowledgeKey = JSON.stringify([entries, e.status === 'pending'])
      if (knowledge.dataset.key !== knowledgeKey) {
        knowledge.dataset.key = knowledgeKey
        knowledge.replaceChildren(...entries.map(k => action((k.used ? '已引用 ' : '已载入 ') + k.title, () => void openKnowledge(k.reference.split(':').at(-1).split('@')[0]), 'knowledge-chip')))
        if (!entries.length) knowledge.append(make('span', e.status === 'pending' ? '知识将在执行时选取' : '直接依据工单取证', 'muted'))
      }
      card.querySelector('.expert-counts').textContent = e.evidenceCount + ' 段原文 · ' + e.findingCount + ' 条判断'
    }
  }
  async function loadLibrary() {
    if (libraryPending || !getTaskId()) return
    const e = epoch, gen = current?.inputGeneration
    libraryPending = true; $('knowledge-retry').hidden = true
    if (!library) $('knowledge-list').replaceChildren(make('p', '正在读取领域知识…', 'loading shimmer-text'))
    try {
      const data = await api(endpoint + '/' + getTaskId() + '/knowledge')
      if (!valid(e, gen) || data.inputGeneration !== gen) return
      library = data; libraryRelease = current?.catalog.releaseId; cardKeys.clear(); renderLibrary(); if (current) renderTeam(current)
    } catch (err) {
      if (e !== epoch) return
      $('knowledge-list').replaceChildren(make('p', err.message, 'notice')); $('knowledge-retry').hidden = false
    } finally { if (e === epoch) libraryPending = false }
  }
  function renderLibrary() {
    if (!library) return
    const entries = library.domains.flatMap(d => d.entries), q = $('knowledge-search').value.trim().toLowerCase()
    $('knowledge-count').textContent = library.domains.length + ' 个领域 · ' + entries.length + ' 条知识'
    const filters = $('domain-filters'), key = JSON.stringify(library.domains.map(d => [d.id, d.title]))
    if (filters.dataset.key !== key) { filters.dataset.key = key; filters.replaceChildren(...[{ id: '', title: '全部领域' }, ...library.domains].map(d => { const b = action(d.title, () => { filter = d.id; renderLibrary() }, 'domain-filter'); b.dataset.domain = d.id; return b })) }
    for (const b of filters.children) b.setAttribute('aria-pressed', String(b.dataset.domain === filter))
    const visible = entries.filter(k => (!filter || k.domain === filter) && (!q || [k.title, k.scope, ...k.keywords].join(' ').toLowerCase().includes(q)))
    $('knowledge-list').replaceChildren(...visible.map(k => {
      const row = action('', () => void openKnowledge(k.id), 'knowledge-card'); row.disabled = k.revoked
      const head = make('div', '', 'knowledge-card-meta'); head.append(make('span', library.domains.find(d => d.id === k.domain)?.title), make('span', k.revoked ? '已停用' : usedBy(k.reference).length ? '本次已引用' : '知识条目', usedBy(k.reference).length ? 'used-knowledge' : ''))
      row.append(head, make('strong', k.title), make('p', k.scope), make('small', k.keywords.slice(0, 3).join(' / '))); return row
    }))
    if (!visible.length) $('knowledge-list').append(make('p', entries.length ? '没有匹配的知识条目。' : library.status === 'preparing' ? '快查完成后可查看本次使用的知识目录。' : '暂未配置领域知识，专家仍可依据工单开展核查。', 'team-empty'))
  }
  async function openKnowledge(id) {
    const e = epoch, gen = current?.inputGeneration, request = ++knowledgeRequest
    if (!$('knowledge-dialog').open) { returnFocus = document.activeElement; returnScroll = { x: scrollX, y: scrollY }; $('knowledge-dialog').showModal() }
    $('knowledge-title').textContent = '知识条目'; $('knowledge-body').replaceChildren(make('p', '正在读取知识…', 'loading shimmer-text')); $('knowledge-title').focus({ preventScroll: true })
    try {
      const data = await api(endpoint + '/' + getTaskId() + '/knowledge/' + encodeURIComponent(id))
      if (!valid(e, gen) || request !== knowledgeRequest || data.inputGeneration !== gen) return
      const k = data.entry; if (!k) throw new Error('此条目暂时无法读取。')
      $('knowledge-title').textContent = k.title
      const body = $('knowledge-body'), users = usedBy(k.reference)
      body.replaceChildren(make('span', k.kind === 'retrieval-observation' ? '检索经验' : '业务知识', 'badge'), make('p', k.scope, 'knowledge-scope'))
      if (users.length) body.append(make('p', '本次引用：' + users.map(x => x.title).join('、'), 'knowledge-used'))
      for (const block of k.bodyMarkdown.split(/\n\s*\n/u)) {
        for (const line of block.split('\n')) {
          if (!line.trim()) continue
          const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
          if (heading && [k.title, '业务知识'].includes(heading[2])) continue
          const paragraph = make(heading ? 'h3' : 'p', '', heading ? '' : 'knowledge-prose')
          const value = heading ? heading[2] : line.replace(/^[-*]\s/u, '• ')
          for (const [i, part] of value.split(/\*\*(.*?)\*\*/u).entries()) paragraph.append(i % 2 ? make('strong', part) : document.createTextNode(part))
          body.append(paragraph)
        }
      }
      for (const [title, list] of [['核查要点', k.evidenceChecklist], ['适用限制', k.limitations]]) { if (list.every(t => k.bodyMarkdown.includes(t))) continue; const ul = make('ul'); ul.append(...list.map(t => make('li', t))); body.append(make('h3', title), ul) }
      const version = make('details', '', 'report-audit'); version.append(make('summary', '知识版本'), make('p', '修订 ' + k.revision), make('small', k.reference))
      body.append(make('p', '知识用于辅助判断，工单结论仍以原文证据为准。', 'muted'), version)
    } catch (err) { if (e === epoch && request === knowledgeRequest) $('knowledge-body').replaceChildren(make('p', err.message, 'notice'), action('重新读取', () => void openKnowledge(id))) }
  }
  $('show-activity').onclick = () => showView('process', true)
  $('knowledge-search').oninput = renderLibrary
  $('knowledge-retry').onclick = () => void loadLibrary()
  $('close-knowledge').onclick = closeKnowledge
  $('knowledge-dialog').oncancel = e => { e.preventDefault(); closeKnowledge() }
  window.addEventListener('pagehide', () => clearInterval(timer))
  window.addEventListener('pageshow', e => { if (e.persisted) { clearInterval(timer); timer = setInterval(clock, 1000); clock() } })
  return { update, reset, openKnowledge, show: () => { if (!library || library.status === 'preparing') void loadLibrary() } }
}
