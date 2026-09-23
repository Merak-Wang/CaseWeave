import { bindRuntimeMetrics, renderRuntimeMetrics } from './workbench-metrics.js'
import { workflowSteps } from './workbench-flow.js'
import { renderJudgment } from './workbench-judgment.js'
const $ = id => document.getElementById(id)
const make = (tag, value = '', cls = '') => { const e = document.createElement(tag); e.textContent = value; e.className = cls; return e }
const action = (label, run, cls = '') => { const b = make('button', label, cls); b.type = 'button'; b.onclick = run; return b }
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const statusNames = { pending: '等待开始', running: '正在核查', completed: '已提交', failed: '未完成', superseded: '已更新' }
const workNames = { starting: '正在阅读领域知识', inspect: '正在核对工单原文', search: '正在补充搜索', report: '正在整理核查发现' }

export function knowledgeConsumers(orchestration, reference, id) {
  const experts = (orchestration?.experts ?? []).filter(e => e.knowledge.some(k => k.reference === reference && k.used))
  const sample = orchestration?.samplingKnowledge?.entries.find(k => k.reference ? k.reference === reference : k.id === id)
  return [...experts, ...(sample ? [{ title: '抽样判断', requestCount: sample.requestCount }] : [])]
}

/** 连续重复事件折成一个进度项；保留次数与所有原始事件供展开追溯。 */
export function activityGroups(items) {
  const groups = []
  for (const item of items) {
    const last = groups.at(-1)
    if (last && last.actor === item.actor && last.kind === 'judgment' && item.kind === 'judgment') {
      last.count++; last.records += item.records
      last.text = `已写入 ${last.records} 条样本判断`
    } else if (last && last.actor === item.actor && last.kind === item.kind && last.text === item.text) last.count++
    else groups.push({ ...item, count: 1 })
  }
  return groups
}

/** Reveal only newly committed public text; restored history is rendered immediately. */
export function revealText(el, value, animate = false) {
  if (el.dataset.fullText === value) return
  el.dataset.fullText = value
  el.getAnimations().forEach(a => a.cancel())
  el.textContent = value
  if (animate && !reduced()) el.animate([{ clipPath: 'inset(0 100% 0 0)', opacity: .4 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], { duration: Math.min(850, 250 + value.length * 7), easing: 'ease-out' })
}

export function createOrchestrationUI({ api, endpoint, getSnapshot, getTaskId, getReportStatus, showView, expertDetail, openCandidate }) {
  let epoch = 0, current, library, libraryRelease, libraryPending = false, filter = '', cardKeys = new Map(), initialized = false
  let lastActivity = '', returnFocus, returnScroll, knowledgeRequest = 0, disconnected = false
  const logKeys = new Map()
  const activityRecords = new Map()
  let activityAfter = 0, activityRevision = -1, activityLoading = false
  const valid = (e, s) => e === epoch && s === getSnapshot()?.orchestration?.inputGeneration
  const usedBy = (reference, id) => knowledgeConsumers(current, reference, id)
  function clock() {
    const elapsed = (current?.clock?.elapsedMs ?? 0) + (current?.clock?.running ? Math.max(0, Date.now() - Date.parse(current.updatedAt)) : 0)
    $('elapsed').textContent = current?.clock?.unavailable ? '历史耗时未记录' : current?.clock ? '本轮 ' + Math.floor(elapsed / 60000) + ':' + String(Math.floor(elapsed / 1000) % 60).padStart(2, '0') : ''
    $('elapsed').title = '从本轮提交到暂停或完成的执行时间；补充后重新计时，历史轨迹保留'
  }
  let timer = setInterval(clock, 1000)
  function closeKnowledge() {
    knowledgeRequest++; $('knowledge-dialog').close(); $('knowledge-body').replaceChildren()
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    if (returnScroll) window.scrollTo(returnScroll.x, returnScroll.y)
  }
  function reset(preserveHistory = false) {
    epoch++; current = undefined; library = undefined; libraryRelease = undefined; libraryPending = false; initialized = false
    cardKeys.clear(); lastActivity = ''; filter = ''; closeKnowledge()
    if (!preserveHistory) { logKeys.clear(); activityRecords.clear(); activityAfter = 0; $('activity-log').replaceChildren(); $('activity-history-log').replaceChildren(); $('activity-history').hidden = true }
    activityRevision = -1; activityLoading = false
    for (const id of ['expert-lanes', 'knowledge-list', 'domain-filters', 'stage-rail', 'live-metrics']) $(id).replaceChildren()
    $('live-work').dataset.state = 'running'; $('live-title').textContent = '正在准备检索'; delete $('live-title').dataset.fullText; $('elapsed').textContent = ''
    $('knowledge-search').value = ''
    delete $('stage-rail').dataset.key; delete $('domain-filters').dataset.key; delete $('expert-lanes').dataset.key
  }
  function appendActivity(id, actor, title, kind, fresh) {
    if (logKeys.has(id)) {
      const row = logKeys.get(id)
      row.querySelector('small').textContent = actor
      revealText(row.querySelector('p'), title, false)
      return
    }
    const row = make('article', '', 'activity-item'), dot = make('span', '', 'activity-dot')
    logKeys.set(id, row)
    const paths = { user: '<circle cx="12" cy="8" r="3"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/>',
      search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>', inspect: '<path d="M5 3h10l4 4v14H5zM9 11h6M9 15h6"/>',
      delegate: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M5 17v-5h14v5"/>',
      finding: '<path d="m5 12 5 5L20 6"/>', finish: '<path d="m5 12 5 5L20 6"/>',
      clarify: '<path d="M8 8a4 4 0 1 1 6 3.5c-2 1-2 2-2 3M12 18v1"/>' }
    dot.innerHTML = '<svg viewBox="0 0 24 24">' + (paths[kind] ?? paths.inspect) + '</svg>'
    row.dataset.kind = kind
    row.dataset.activity = id; dot.setAttribute('aria-hidden', 'true')
    const copy = make('div'); copy.append(make('small', actor), make('p', title)); row.append(dot, copy)
    $('activity-log').append(row)
    if (fresh && !reduced()) row.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 320, easing: 'ease-out' })
  }
  async function refreshActivity(s) {
    if (activityLoading || activityRevision === s.eventSeq || !s.orchestration || ['permission_blocked', 'snapshot_invalid'].includes(s.node?.status)) return
    const ownEpoch = epoch, id = getTaskId(), initial = activityAfter === 0
    activityLoading = true
    try {
      let page
      do {
        page = await api(endpoint + '/' + id + '/activity?after=' + activityAfter)
        if (ownEpoch !== epoch || id !== getTaskId()) return
        for (const a of page.items) activityRecords.set(a.id, a)
        activityAfter = page.after
      } while (page.more)
      const groups = activityGroups([...activityRecords.values()]), recent = groups.slice(-8), older = groups.slice(0, -8)
      for (const group of groups) appendActivity(group.id, group.actor, group.text + (group.count > 1 && group.kind !== 'judgment' ? `（累计 ${group.count} 次）` : ''), group.kind, !initial && recent.includes(group))
      // 同一 DOM 节点移动到历史区，展开状态与焦点不随轮询重置。
      const liveIds = new Set(groups.map(g => g.id))
      for (const [key, row] of logKeys) if (!liveIds.has(key)) { row.remove(); logKeys.delete(key) }
      for (const [parent, entries] of [[$('activity-history-log'), older], [$('activity-log'), recent]]) entries.forEach((group, i) => {
        const row = logKeys.get(group.id)
        if (parent.children[i] !== row) parent.insertBefore(row, parent.children[i] ?? null)
      })
      $('activity-history').hidden = !older.length
      $('activity-history-caption').textContent = `查看较早记录（${older.length} 项）`
      activityRevision = s.eventSeq
    } catch { if (ownEpoch === epoch) $('activity-caption').textContent = '轨迹暂时无法读取，连接恢复后重试' }
    finally { if (ownEpoch === epoch) activityLoading = false }
  }
  function update(s, offline = false) {
    disconnected = offline
    const o = s.orchestration, wasInitialized = initialized
    current = o
    const unavailable = Boolean(s.failure) || ['error', 'permission_blocked', 'snapshot_invalid'].includes(s.node?.status)
    if (['permission_blocked', 'snapshot_invalid'].includes(s.node?.status)) { closeKnowledge(); library = undefined; $('knowledge-list').replaceChildren(); $('expert-lanes').replaceChildren(); $('activity-log').replaceChildren(); $('activity-history-log').replaceChildren(); $('activity-history').hidden = true }
    const busy = !unavailable && !o?.terminal && !s.node?.result && (!s.question || o?.experts.some(e => ['pending', 'running'].includes(e.status)))
    $('live-work').dataset.state = unavailable ? 'error' : disconnected ? 'offline' : busy ? 'running' : o?.terminal ? ['top_k_accepted', 'no_result'].includes(o.outcome) ? 'done' : 'stopped' : 'waiting'
    const working = o?.experts.filter(e => e.status === 'running') ?? []
    const titles = { planning: '正在理解当前要求，制定检索计划', coverage: '尚未找到候选，正在核对搜索范围与后续方向', search: '正在从关键词与语义中寻找线索', review: '正在审阅标题与摘要，按需核实疑点', experts: working.length + ' 位领域专家正在独立核查', synthesis: '正在汇总发现，核对遗漏与分歧', finished: ['top_k_accepted', 'no_result'].includes(o?.outcome) ? '本轮检索已结束' : '本轮已停止，仍有未完成项' }
    const reportStatus = getReportStatus(), reporting = ['queued', 'running'].includes(reportStatus)
    if (reporting && !unavailable && !disconnected) $('live-work').dataset.state = 'running'
    const title = unavailable ? '检索暂时无法继续' : disconnected ? o?.terminal ? '连接已断开，显示已保存结果' : '正在重连，后台检索仍在继续' : s.question && !working.length ? '有一处范围需要你补充'
      : s.node?.result && o?.outcome !== 'cancelled' ? reporting ? '语义筛选已结束，正在生成检索报告' : reportStatus === 'ready' ? '检索报告已生成，过程与依据已保留' : reportStatus === 'failed' ? '检索报告生成失败，可重试' : '语义筛选已结束，可生成检索报告'
      : !o?.terminal && o?.operation === 'sem_filter' ? '正在按当前业务判据筛选工单集合' : !o?.terminal && o?.operation === 'sem_extract' ? '正在从工单证据中提取所需事实' : !o?.terminal && o?.operation === 'sem_agg' ? '正在整理证据与引用' : !o?.terminal && o?.operation === 'sem_search' ? '正在执行本轮检索计划，补充候选' : titles[o?.stage] ?? '正在准备检索'
    revealText($('live-title'), title, wasInitialized)
    const learning = o?.retrieval?.learning
    $('live-metrics').replaceChildren(...(o ? [['已召回线索', o.counts.candidates], ...(typeof learning?.scopeCount === 'number' ? [['筛选范围', learning.scopeCount]] : [['已读原文', o.counts.inspected]]), ['已确认', o.counts.confirmed]].map(([label, count]) => { const e = make('span'); e.append(make('strong', Number(count).toLocaleString()), make('small', label)); return e }) : []))
    const steps = workflowSteps(s, reportStatus), railKey = JSON.stringify([steps, disconnected])
    if ($('stage-rail').dataset.key !== railKey) {
      $('stage-rail').dataset.key = railKey
      $('stage-rail').replaceChildren(...steps.map((step, i) => {
        const e = make('li'), link = action('', () => openStep(step), 'stage-link'); e.dataset.state = disconnected && step.state === 'active' ? 'stopped' : step.state
        if (step.state === 'active') link.setAttribute('aria-current', 'step')
        const copy = make('span', '', 'stage-copy'); copy.append(make('strong', step.label), make('small', step.note))
        link.append(make('span', step.state === 'done' ? '✓' : String(i + 1), 'stage-number'), copy); e.append(link); return e
      }))
    }
    clock()
    renderRuntimeMetrics(o?.context, o?.usage)
    $('activity-caption').textContent = busy ? '最近进展 · 同类批次合并更新' : '已保存的执行记录'
    $('activity-log').dataset.busy = String(busy && !disconnected)
    // Initial history is not replayed as fresh generation and never forces scrolling.
    void refreshActivity(s)
    if (o && !unavailable) {
      renderTeam(o)
      const consumption = JSON.stringify([o.experts.map(e => e.knowledge), o.samplingKnowledge])
      if (library && consumption !== lastActivity && !$('knowledge-dialog').open) { renderLibrary(); lastActivity = consumption }
    }
    if (libraryRelease !== o?.catalog.releaseId) { library = undefined; libraryRelease = o?.catalog.releaseId; if (!$('collaboration-view').hidden) void loadLibrary() }
    initialized = true
  }
  function openStep(step) {
    showView(step.view, true)
    if (step.target) $(step.target).scrollIntoView({ block: 'start', behavior: reduced() ? 'instant' : 'smooth' })
  }
  function renderTeam(o) {
    const hasSamples = Boolean(o.samplingKnowledge?.entries.length)
    $('team-count').textContent = [hasSamples ? `${o.samplingKnowledge.requestCount} 次领域判断请求` : '', o.experts.length ? o.counts.completedExperts + ' / ' + o.counts.experts + ' 专项已返回' : ''].filter(Boolean).join(' · ')
    const mainWaiting = o.coordinatorActivity === 'waiting_experts'
    $('coordinator-node').dataset.state = !o.terminal && !mainWaiting && !o.waitingForInput && !disconnected ? 'running' : ''
    $('coordinator-state').textContent = o.terminal ? '本轮任务已结束' : o.waitingForInput ? '等待已提出问题的答复' : mainWaiting ? '等待所需专家结果 · 其余分支继续' : o.stage === 'experts' ? '与专家并行 · 继续取证和核对返回结果' : '理解需求 · 选择专家 · 核对结论'
    $('synthesis-node').dataset.state = o.stage === 'synthesis' && !disconnected ? 'running' : ''
    $('synthesis-state').textContent = o.openConflicts ? o.openConflicts + ' 处判断分歧，继续核对证据' : o.terminal ? `已确认 ${o.counts.confirmed} 条工单 · ${getReportStatus() === 'ready' ? '报告已生成' : ['queued', 'running'].includes(getReportStatus()) ? '报告生成中' : '可生成报告'}` : '筛选结果核对后生成检索报告'
    const box = $('expert-lanes')
    if (!o.experts.length && !hasSamples) {
      const key = 'empty-' + o.stage
      if (box.dataset.key !== key) { box.replaceChildren(make('p', o.terminal ? '本次直接依据业务判据与工单原文完成判断。' : '正在依据业务判据与工单原文核查，适用的领域知识将随判断展示。', 'team-empty')); box.dataset.key = key; cardKeys.clear() }
      return
    }
    if (box.dataset.key?.startsWith('empty')) box.replaceChildren()
    box.dataset.key = 'team'
    const ids = new Set([...o.experts.map(e => e.id), ...(hasSamples ? ['sampling-judgment'] : [])])
    for (const c of [...box.children]) if (!ids.has(c.dataset.expertId)) { cardKeys.delete(c.dataset.expertId); c.remove() }
    if (hasSamples) {
      const key = JSON.stringify([o.samplingKnowledge, o.retrieval?.learning, library, o.terminal, disconnected])
      if (cardKeys.get('sampling-judgment') !== key) {
        const old = $('sampling-judgment'), node = renderJudgment(o, library, { openKnowledge, openCandidate,
          showProcess: () => openStep({ view: 'process', target: 'learning-progress' }) })
        node.dataset.expertId = 'sampling-judgment'
        const trace = node.querySelector('details'), oldTrace = old?.querySelector('details')
        if (trace && oldTrace) { trace.dataset.offset = oldTrace.dataset.offset ?? '0'; trace.open = oldTrace.open }
        if (disconnected) node.dataset.state = 'paused'
        if (old) old.replaceWith(node); else box.prepend(node)
        cardKeys.set('sampling-judgment', key)
      }
    }
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
      const users = usedBy(k.reference, k.id)
      const head = make('div', '', 'knowledge-card-meta'); head.append(make('span', library.domains.find(d => d.id === k.domain)?.title), make('span', k.revoked ? '已停用' : users.length ? users.map(u => u.title).join('、') + '已使用' : '知识条目', users.length ? 'used-knowledge' : ''))
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
      const body = $('knowledge-body'), users = usedBy(k.reference, k.id)
      body.replaceChildren(make('span', k.kind === 'retrieval-observation' ? '检索经验' : '业务知识', 'badge'), make('p', k.scope, 'knowledge-scope'))
      if (users.length) body.append(make('p', '本次使用：' + users.map(x => x.title + (x.requestCount ? `（${x.requestCount} 次请求）` : '')).join('、'), 'knowledge-used'))
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
      body.append(version)
    } catch (err) { if (e === epoch && request === knowledgeRequest) $('knowledge-body').replaceChildren(make('p', err.message, 'notice'), action('重新读取', () => void openKnowledge(id))) }
  }
  $('show-activity').onclick = () => showView('process', true)
  $('synthesis-report').onclick = () => showView('report', true)
  bindRuntimeMetrics()
  $('knowledge-search').oninput = renderLibrary
  $('knowledge-retry').onclick = () => void loadLibrary()
  $('close-knowledge').onclick = closeKnowledge
  $('knowledge-dialog').oncancel = e => { e.preventDefault(); closeKnowledge() }
  window.addEventListener('pagehide', () => clearInterval(timer))
  window.addEventListener('pageshow', e => { if (e.persisted) { clearInterval(timer); timer = setInterval(clock, 1000); clock() } })
  return { update, reset, openKnowledge, show: () => { if (!library || library.status === 'preparing') void loadLibrary() } }
}
