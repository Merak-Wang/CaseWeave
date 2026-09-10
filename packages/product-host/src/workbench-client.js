import { readTicketDetail, detailFailureMessage } from '@retrieval-agent/product-api/detail-client'
import { displayFieldPart } from './workbench-content.js'
import { createOrchestrationUI, revealText } from './workbench-orchestration.js'
import { createModelUI } from './workbench-models.js'
const $ = id => document.getElementById(id), endpoint = '/api/retrieval-agent/tasks'
const pendingKey = 'retrieval.pending.commands', taskKey = 'retrieval.tasks'
let taskId = new URL(location.href).searchParams.get('task'), snapshot, stream, lastSeq = 0, minimumInput = 0
let generation = 0, refreshing = false, again = false, refreshTimer, artifactTimer, disconnected = false
let view = 'results', page, pageCursor, previousCursors = [], pageLoading = false
let pageRequest = 0, detailRequest = 0, reportRequest = 0, artifactRequest = 0, report, feedbackTarget, detailReturn, detailScroll
let timelineKey = '', expertsKey = '', artifactsKey = '', currentListVersion, sendingInput = false, stopping = false, generatingReport = false, animateNextReport = false
let historyEpoch = 0, historyNoticeTimer
const saved = (key, fallback = []) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } }
function writeSaved(key, value) { localStorage.setItem(key, JSON.stringify(value)) }
function text(tag, value, cls) { const e = document.createElement(tag); e.textContent = value ?? ''; if (cls) e.className = cls; return e }
function button(label, action, cls = 'secondary') { const b = text('button', label, cls); b.type = 'button'; b.onclick = () => void action(); return b }
const verdict = v => ({ accept: '已确认', exclude: '已排除', undetermined: '核查中' }[v] || '核查中')
const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
const audit = (label, value) => { const d = text('details', '', 'report-audit'); d.append(text('summary', label), text('small', value)); return d }
const origin = o => o?.kind === 'generated' ? '生成摘要' : o?.kind === 'source' ? '来源原文' : '类型未标注'
const fieldLabel = f => ({ problemDescription: '问题描述', resolutionSteps: '处理记录', rootCause: '原因记录', answer: '答复', conversationOrUpdates: '对话与更新' }[f.key] || f.label)
const totals = () => snapshot?.node?.collectionWindow
const valid = (gen, id = taskId) => gen === generation && id === taskId
const actualView = () => view === 'results' ? 'confirmed' : $('candidate-view').value
const hasAccess = () => snapshot?.node && !['snapshot_invalid', 'permission_blocked'].includes(snapshot.node.status)
const deliveryReady = () => hasAccess() && Boolean(snapshot.node.result) && !snapshot.failure
const orchestrationUI = createOrchestrationUI({ api, endpoint, getSnapshot: () => snapshot, getTaskId: () => taskId, showView: setView, expertDetail })
const modelUI = createModelUI({ api, getTaskId: () => taskId })
function error(e, source = 'action') {
  const target = $('feedback-dialog').open ? $('feedback-error') : $('delivery').open ? $('delivery-error') : $('error')
  const message = e.name === 'TypeError' && /fetch/i.test(e.message) ? '网络连接中断，请重试。' : e.name === 'TimeoutError' ? '请求超时，请重试。' : e.message || String(e)
  target.dataset.source = source; target.hidden = false; target.replaceChildren(text('span', message))
  if (saved(pendingKey).length) target.append(text('span', ' 输入已保留。'), button('重试提交', () => retrySaved()))
}
function clearError(source) { for (const id of ['error', 'delivery-error', 'feedback-error']) if (!source || $(id).dataset.source === source) { $(id).hidden = true; $(id).replaceChildren() } }
async function api(path, body) {
  const response = await fetch(path, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
  let data; try { data = await response.json() } catch { throw new Error('服务响应无法读取，请重试。') }
  if (!response.ok) { const e = new Error(data.message || '请求失败'); e.code = data.code; e.retryable = data.retryable; throw e }
  return data
}
async function command(path, body) {
  clearError()
  // A lost receipt is retried with the same operationId, including a second click after a network error.
  const queue = saved(pendingKey), matching = queue.find(i => i.path === path && JSON.stringify(i.spec) === JSON.stringify(body))
  const item = matching ?? { path, spec: body, body: { ...body, operationId: crypto.randomUUID() } }
  if (!matching) { queue.push(item); writeSaved(pendingKey, queue) }
  try { const receipt = await api(path, item.body); writeSaved(pendingKey, saved(pendingKey).filter(i => i.body.operationId !== item.body.operationId)); return receipt }
  catch (e) { if (e.code && !e.retryable && e.code !== 'PROVIDER_UNAVAILABLE') writeSaved(pendingKey, saved(pendingKey).filter(i => i.body.operationId !== item.body.operationId)); throw e }
}
async function retrySaved() {
  for (const item of saved(pendingKey)) {
    try {
      const r = await api(item.path, item.body); writeSaved(pendingKey, saved(pendingKey).filter(i => i.body.operationId !== item.body.operationId)); clearError()
      if (item.body.kind === 'query' && !taskId) await enterTask(r.taskId)
      else if (r.taskId === taskId && r.inputRevision) { if (r.inputRevision >= minimumInput) acceptReceipt(r, item.spec.kind); await refresh() }
    } catch (e) {
      if (e.code && !e.retryable && e.code !== 'PROVIDER_UNAVAILABLE') writeSaved(pendingKey, saved(pendingKey).filter(i => i.body.operationId !== item.body.operationId))
      error(e); break
    }
  }
}
function remember(id) {
  writeSaved(taskKey, [id, ...saved(taskKey).filter(x => x !== id)].slice(0, 20))
  history.replaceState(null, '', '?task=' + encodeURIComponent(id)); void historyLinks()
}
async function historyLinks() {
  const ownEpoch = ++historyEpoch
  const ids = saved(taskKey).filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)).slice(0, 20)
  $('recent-section').hidden = !ids.length
  for (const target of ['restore', 'recent']) { $(target).replaceChildren(); if (!ids.length) $(target).append(text('p', '还没有检索记录', 'muted')) }
  // Persist only IDs. Names and status come from reauthorized snapshots.
  const entries = await Promise.all(ids.map(async id => { let s; try { s = id === taskId && snapshot ? snapshot : await api(endpoint + '/' + id) } catch { /* explicit unavailable entry */ }; return { id, s } }))
  if (ownEpoch !== historyEpoch) return
  for (const { id, s } of entries) {
    for (const target of ['restore', 'recent']) {
      const a = text('a', ''); a.href = '?task=' + encodeURIComponent(id)
      a.append(text('strong', s?.query || '暂时无法打开'), text('small', s ? taskStatus(s) : '点击重试'))
      if (id === taskId) a.setAttribute('aria-current', 'page')
      const row = text('div', '', 'history-item'), remove = button('×', () => removeHistory(id), 'icon-button history-remove')
      remove.setAttribute('aria-label', '删除历史记录：' + (s?.query || id)); remove.title = '从这台浏览器的历史记录移除'
      row.append(a, remove); $(target).append(row)
    }
  }
}
function taskStatus(s) {
  return ['snapshot_invalid', 'permission_blocked'].includes(s.node?.status) ? '来源或访问资格已失效' : s.failure ? '执行未完成'
    : s.orchestration?.outcome === 'cancelled' ? '已停止' : s.question ? '需要补充' : s.node?.result ? ['top_k_accepted', 'no_result'].includes(s.node.result.stoppingReason) ? '已完成' : '未完成' : '检索中'
}
function removeHistory(id) {
  const before = saved(taskKey), index = before.indexOf(id)
  writeSaved(taskKey, before.filter(x => x !== id)); void historyLinks()
  const notice = $('history-notice'); clearTimeout(historyNoticeTimer); notice.hidden = false
  notice.replaceChildren(text('span', '已删除这条历史记录'), button('撤销', () => {
    const ids = saved(taskKey).filter(x => x !== id); ids.splice(Math.max(0, index), 0, id); writeSaved(taskKey, ids.slice(0, 20)); void historyLinks(); notice.hidden = true
  }, 'link'))
  historyNoticeTimer = setTimeout(() => { notice.hidden = true }, 8000)
}
function closeDetail(restore = true) {
  detailRequest++; $('evidence-panel').close(); $('evidence-panel').hidden = true; $('workspace').dataset.detail = 'false'; $('detail').replaceChildren()
  if (restore && detailReturn?.isConnected) { detailReturn.focus({ preventScroll: true }); if (detailScroll) window.scrollTo(detailScroll.x, detailScroll.y) }
}
function invalidateDelivery() {
  generatingReport = false; $('report-generating').hidden = true
  reportRequest++; artifactRequest++; report = undefined; artifactsKey = ''; clearTimeout(artifactTimer)
  $('report-content').replaceChildren(); $('artifacts').replaceChildren(); $('download-receipt').textContent = ''
}
function invalidateViews(preserveHistory = true) {
  orchestrationUI.reset(preserveHistory)
  generation++; pageRequest++; pageLoading = false; page = undefined; currentListVersion = undefined
  pageCursor = undefined; previousCursors = []; invalidateDelivery(); closeDetail(false)
  $('feedback-dialog').close(); $('cards').replaceChildren(); $('new-results').hidden = true
  $('early-progress').replaceChildren(); $('result-summary').hidden = true
  $('prev-page').disabled = $('next-page').disabled = true; $('page-status').textContent = ''
}
function acceptReceipt(r, kind = 'revise') {
  minimumInput = Math.max(minimumInput, r.inputRevision ?? 0)
  $('task').dataset.inputRevision = String(minimumInput)
  if (kind === 'cancel') {
    $('status').textContent = '正在停止检索'; $('receipt').textContent = '正在停止主 Agent 和专家，已有结果与轨迹将保留…'
    return
  }
  invalidateViews(); snapshot = undefined
  $('confirmed-count').textContent = '0'; $('counts').textContent = '已保存新输入，正在重新核查'; $('result-summary').hidden = true; $('early-progress').hidden = false
  $('early-progress').replaceChildren(text('h3', '正在按新要求查找'), text('p', '结果会在确认后出现在这里。'))
  $('status').textContent = '正在更新结果'
  $('download').disabled = $('download-jsonl').disabled = $('save-report').disabled = true
  $('delivery-note').textContent = '结果正在修订，上一版本的报告和文件已停止交付。'
  $('receipt').textContent = '已收到，正在更新结果'
}
async function enterTask(id) {
  stream?.close(); taskId = id; lastSeq = 0; minimumInput = 0; snapshot = undefined; invalidateViews(false); timelineKey = expertsKey = ''; void modelUI.refresh()
  $('home').hidden = true; $('task').hidden = false; remember(id); setView('results'); await refresh(); subscribe(); $('query-title').focus({ preventScroll: true })
}
async function refresh() {
  if (refreshing) { again = true; return }; if (!taskId) return
  refreshing = true; const id = taskId, gen = generation
  try {
    const next = await api(endpoint + '/' + id)
    if (id !== taskId || gen !== generation || next.inputRevision < minimumInput || (snapshot && next.eventSeq < snapshot.eventSeq)) return
    if (snapshot && snapshot.inputRevision !== next.inputRevision) invalidateViews()
    if (snapshot?.node?.result?.resultRevision !== next.node?.result?.resultRevision) invalidateDelivery()
    if (currentListVersion && currentListVersion !== next.node?.collectionWindow?.version && !$('evidence-panel').hidden) closeDetail()
    snapshot = next; currentListVersion = next.node?.collectionWindow?.version; minimumInput = next.inputRevision
    lastSeq = Math.max(lastSeq, next.eventSeq); clearError('refresh'); render()
    if (hasAccess() && view !== 'report' && (view === 'results' || $('candidate-disclosure').open)) {
      if (!page || (!page.items.length && (view !== 'results' || (totals()?.confirmed ?? 0) > 0))) void loadPage()
      else if (page.currentVersion !== currentListVersion) $('new-results').hidden = false
    }
  } catch (e) {
    if (!valid(gen, id)) return
    if (e.code && !e.retryable && e.code !== 'PROVIDER_UNAVAILABLE') { invalidateViews(false); snapshot = undefined; $('confirmed-count').textContent = '0'; $('download').disabled = $('download-jsonl').disabled = $('save-report').disabled = true; $('delivery-note').textContent = '访问资格或来源已失效，请重新检索。' }
    else scheduleRefresh(2000)
    error(e, 'refresh')
  } finally { refreshing = false; if (again) { again = false; scheduleRefresh() } }
}
function scheduleRefresh(delay = 300) { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh() }, delay) }
const connectionNotice = () => snapshot?.orchestration?.terminal ? '正在重连，显示已保存结果' : '正在重连，检索仍会继续'
function subscribe() {
  stream?.close(); if (!taskId) return
  const id = taskId, source = new EventSource(endpoint + '/' + id + '/events?after=' + lastSeq); stream = source
  const current = () => stream === source && id === taskId
  source.onopen = () => { if (current()) { disconnected = false; $('connection').textContent = ''; void refresh() } }
  source.onerror = () => { if (current()) { disconnected = true; $('connection').textContent = connectionNotice(); if (snapshot) orchestrationUI.update(snapshot, true); scheduleRefresh(2000) } }
  source.addEventListener('retry', () => { if (current()) scheduleRefresh(1500) })
  source.addEventListener('change', event => { if (!current()) return; const seq = Number(event.lastEventId); if (!Number.isSafeInteger(seq) || seq <= lastSeq) return; lastSeq = seq; scheduleRefresh() })
  source.addEventListener('access-error', () => { if (!current()) return; source.close(); invalidateViews(); void refresh() })
}
const expertStatus = { pending: '等待执行', running: '正在取证', completed: '已提交判断', failed: '未完成', superseded: '条件已更新' }
function setView(next, focus = false) {
  closeDetail(false); view = next; pageRequest++; pageLoading = false; page = undefined; pageCursor = undefined; previousCursors = []
  for (const name of ['results', 'process', 'collaboration', 'report']) { $(name + '-view').hidden = name !== next; $('tab-' + name).setAttribute('aria-selected', String(name === next)); $('tab-' + name).tabIndex = name === next ? 0 : -1 }
  const region = $('list-region'); region.hidden = ['report', 'collaboration'].includes(next) || (next === 'process' && !$('candidate-disclosure').open)
  if (next === 'results') $('results-view').append(region); else if (next === 'process') $('process-list-slot').append(region)
  if (focus) $('tab-' + next).focus()
  if (next === 'report') void loadReport(); else if (snapshot && !region.hidden) void loadPage(undefined, true)
  if (next === 'collaboration') orchestrationUI.show()
}
function render() {
  orchestrationUI.update(snapshot, disconnected)
  const n = snapshot.node, count = totals()?.confirmed ?? 0, result = n?.result
  $('task').dataset.inputRevision = String(snapshot.inputRevision)
  $('home').hidden = true; $('task').hidden = false; $('query-title').textContent = snapshot.query
  document.title = snapshot.query.slice(0, 28) + ' · 络寻 CaseWeave'; $('breadcrumb').textContent = '我的检索'
  $('cancel').disabled = stopping || !canStop()
  const status = snapshot.failure || n?.message || (!n ? '需求已保存，后台正在准备检索。' : result ? '本轮核查结束，结果已保存。' : snapshot.question ? '有一处业务范围需要补充，独立工作继续。' : '正在自动检索与核查原文。')
  const failed = snapshot.failure || ['error', 'snapshot_invalid', 'permission_blocked'].includes(n?.status)
  $('status').textContent = failed ? status : result ? (['top_k_accepted', 'no_result'].includes(result.stoppingReason) ? '本次检索已结束' : '本次检索尚未完成') : snapshot.question ? '需要补充一处范围' : count ? '继续查找与核实' : '正在查找与核实'
  $('status').className = failed ? 'error' : ''; $('status').parentElement.dataset.state = failed ? 'error' : result ? 'done' : 'running'
  if (snapshot.orchestration?.outcome === 'cancelled') { $('status').textContent = '已停止，结果与轨迹已保留'; $('status').parentElement.dataset.state = 'done' }
  $('counts').textContent = result ? '' : (totals()?.current ?? 0) + ' 条线索'; $('confirmed-count').textContent = String(count)
  if (snapshot.receipt) $('receipt').textContent = snapshot.commands.at(-1)?.kind === 'query' || result ? '' : '补充已收到'
  for (const item of document.querySelectorAll('a[aria-current="page"] small')) item.textContent = taskStatus(snapshot)
  $('channels').textContent = (n?.searchProgress?.channels || []).map(c => (c.channel === 'keyword' ? '关键词' : '向量') + '：' + ({ running: '检索中', completed: '已返回', failed: '失败', skipped: '未使用' }[c.status] || c.status) + ' ' + c.count + ' 条').join(' · ')
  $('scope-content').replaceChildren(text('p', snapshot.query), ...(snapshot.commands ?? []).filter(c => ['supplement', 'answer'].includes(c.kind)).map(c => text('p', '补充：' + c.text)))
  const question = snapshot.question?.question_json, changed = $('question').dataset.id !== snapshot.question?.id
  $('question').hidden = !question; $('question').textContent = question?.question || ''; $('question').dataset.id = snapshot.question?.id || ''
  if (changed) $('question-options').replaceChildren(...(question?.options || []).map(o => button(o, () => { $('supplement').value = o; resizeInput($('supplement')); updateComposerAction(); $('supplement').focus() })))
  $('supplement-label').textContent = question ? '回答范围问题' : '补充检索要求'; updateComposerAction()
  $('supplement').placeholder = question ? '补充你的想法…' : '继续补充，或调整查找范围…'
  $('input-hint').textContent = question ? (snapshot.orchestration?.experts?.some(e => ['pending', 'running'].includes(e.status)) ? '独立专家仍在继续' : '等待回复 · 可随时停止') : ''
  const key = JSON.stringify(snapshot.conversation)
  if (key !== timelineKey) {
    const box = $('timeline'), top = box.scrollTop, atBottom = box.scrollHeight - top - box.clientHeight < 24
    box.replaceChildren(...(snapshot.conversation ?? []).map(c => text('p', (c.role === 'user' ? '你：' : '检索助手：') + c.text))); box.scrollTop = atBottom ? box.scrollHeight : top; timelineKey = key
  }
  const experts = n?.expertProgress || [], ek = JSON.stringify([experts, n?.openExpertConflicts]); $('expert-panel').hidden = !experts.length
  if (ek !== expertsKey) {
    $('experts').replaceChildren(...experts.map(e => { const row = text('div', '', 'card'); row.append(text('h3', e.domainId + ' · ' + expertStatus[e.status]), text('p', e.goal), text('small', e.findingCount + ' 条判断' + (e.failure ? ' · ' + e.failure : '')), button('查看工作依据', () => expertDetail(e.id))); return row }))
    if (n?.openExpertConflicts) $('experts').append(text('p', n.openExpertConflicts + ' 条工单存在分歧，Agent 正在补充核实。', 'notice')); expertsKey = ek
  }
  $('process-search').replaceChildren(text('p', status), text('p', n?.resultPagesExhausted ? '已检查本次搜索返回的全部线索。' : '仍有线索需要检查。', 'muted'))
  const feedbacks = snapshot.feedback ?? []; $('feedback-panel').hidden = !feedbacks.length
  const latestFeedback = feedbacks.at(-1)
  if (snapshot.commands.at(-1)?.kind === 'feedback' && latestFeedback) $('receipt').textContent = latestFeedback.status === 'reviewed' ? '反馈已处理 · ' + verdict(latestFeedback.verdict) : '反馈已收到，正在核实'
  $('feedback-history').replaceChildren(...feedbacks.map(f => { const row = text('div', '', 'card'); row.append(text('p', '你的意见：' + f.text), text('p', f.status === 'reviewed' ? 'Agent 已处理 · ' + verdict(f.verdict) + '：' + f.reason : '已持久接收，Agent 复核中。', f.status === 'reviewed' ? '' : 'notice')); return row }))
  $('early-progress').hidden = count > 0
  if (!count) {
    const incomplete = result && !['top_k_accepted', 'no_result'].includes(result.stoppingReason)
    const box = $('early-progress'); box.replaceChildren(text('h3', incomplete || snapshot.failure ? '本次检索未完成' : result ? '暂未找到符合要求的工单' : (totals()?.current ?? 0) ? '找到一些线索，正在核实' : '正在查找相关工单'), text('p', incomplete ? '本轮尚未完成核查，当前没有确认结果。' : result || snapshot.failure ? status : '确认后的工单会出现在这里。'))
    for (const c of (n?.candidates ?? []).slice(0, 3)) { const clue = text('div', '', 'clue'); clue.append(text('small', '检索线索 · ' + c.displayId), button(c.title, () => detail(c), 'link'), text('p', c.summary.slice(0, 180), 'muted')); box.append(clue) }
    box.append(button('查看检索过程', () => setView('process', true)))
  }
  $('result-summary').hidden = !result
  if (result) { $('result-explanation').textContent = result.explanation || status; $('result-boundary').textContent = (result.resultPagesExhausted ? '已检查本次搜索返回的全部线索。' : '本次搜索仍有未检查的线索。') + (result.semanticRecallKnown ? '' : '其他表述的相关工单仍可能遗漏。') }
  const ready = deliveryReady(); $('download').disabled = $('download-jsonl').disabled = !ready || !n.exportEnabled; $('save-report').disabled = !ready || generatingReport
  $('delivery-state').textContent = ready ? '' : '检索结束后可下载'
  $('delivery-note').textContent = ready ? '包含全部 ' + count + ' 条已确认工单。' : hasAccess() ? '正在整理结果，请稍后再来。' : '当前来源尚未就绪或已失效，暂不能交付。'
  if (ready) void loadArtifacts()
  if (view === 'report' && (!report || report.resultRevision !== result?.resultRevision)) void loadReport()
  $('connection').textContent = disconnected ? connectionNotice() : ''
}
async function loadPage(cursor, reset = false) {
  if (!taskId || !hasAccess() || ['report', 'collaboration'].includes(view)) return
  if (reset) { cursor = undefined; pageCursor = undefined; previousCursors = [] }
  const request = ++pageRequest, gen = generation, id = taskId, requestedView = actualView(), version = currentListVersion
  pageLoading = true; $('cards').setAttribute('aria-busy', 'true'); if (!page) $('cards').replaceChildren(text('p', '正在读取工单…', 'loading'))
  try {
    const data = await api(endpoint + '/' + id + '/candidates?view=' + requestedView + '&limit=30' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    if (!valid(gen, id) || request !== pageRequest || requestedView !== actualView()) return
    const changedPage = page && page.offset !== data.offset
    page = { ...data, currentVersion: version }; pageCursor = cursor; renderPage(); $('new-results').hidden = version === currentListVersion
    if (changedPage) { $('cards').scrollIntoView({ block: 'start', behavior: 'instant' }); $('cards').focus({ preventScroll: true }) }
  } catch (e) {
    if (!valid(gen, id) || request !== pageRequest) return
    if (e.code === 'INVALID_TRANSITION') { $('new-results').hidden = false; error(new Error('集合已更新，点击“更新列表”读取当前结果。')) }
    else { error(e); if (!page) $('cards').replaceChildren(button('列表读取失败，重试', () => loadPage(undefined, true))) }
  } finally { if (request === pageRequest) { pageLoading = false; $('cards').setAttribute('aria-busy', 'false') } }
}
function renderPage() {
  const judgments = new Map(page.judgments.map(j => [j.candidateRef, j])), history = page.view === 'history', readable = new Set(page.readableCandidateRefs)
  $('candidate-note').textContent = history ? '历史线索可能已不符合当前要求。' : page.view === 'confirmed' ? '' : '线索仍在核实，确认后会加入结果。'
  $('cards').replaceChildren(...page.items.map(c => {
    const j = judgments.get(c.ref), card = text('article', '', 'card ticket-card'), meta = text('div', '', 'ticket-meta'); card.dataset.ref = c.ref
    meta.append(text('span', c.displayId, 'ticket-id'))
    if (page.view !== 'confirmed') { const badge = text('span', history ? '历史线索' : verdict(j?.verdict), 'badge'); badge.dataset.verdict = j?.verdict || ''; meta.append(badge) }
    card.append(meta, text('h3', ''))
    card.querySelector('h3').append(readable.has(c.ref) ? button(c.title, () => detail(c), 'link ticket-title') : text('span', c.title, 'ticket-title'))
    card.append(text('p', c.summary, 'summary'))
    const footer = text('div', '', 'ticket-footer'); footer.append(text('small', origin(c.summaryOrigin)))
    if (readable.has(c.ref)) footer.append(button(j ? '查看依据 ↗' : '查看原文 ↗', () => detail(c), 'link'))
    card.append(footer); return card
  }))
  $('cards').scrollTop = 0; $('page-status').textContent = page.total ? (page.offset + 1) + '–' + (page.offset + page.items.length) + ' / ' + page.total : page.view === 'confirmed' ? '暂无确认工单' : '暂无工单'
  $('prev-page').disabled = !previousCursors.length; $('next-page').disabled = !page.nextCursor
  $('prev-page').parentElement.hidden = page.total <= page.limit && !previousCursors.length && !page.nextCursor
}
function openDetail(title) {
  if ($('evidence-panel').hidden) { detailReturn = document.activeElement; detailScroll = { x: window.scrollX, y: window.scrollY } }
  $('workspace').dataset.detail = 'true'; $('evidence-panel').hidden = false; $('detail-title').textContent = title
  $('detail').replaceChildren(text('p', '正在读取原文…', 'loading'))
  if (!$('evidence-panel').open) $('evidence-panel').showModal()
  $('evidence-panel').scrollTop = 0; $('detail-title').focus({ preventScroll: true })
}
async function detail(candidate, citation) {
  clearError(); openDetail(candidate.displayId || '工单依据'); const gen = generation, request = ++detailRequest, id = taskId
  if (!snapshot?.node) return
  const fields = snapshot.node.detailFields, labels = new Map(fields.map(f => [f.key, fieldLabel(f)]))
  try {
    const [d, e] = await Promise.all([readTicketDetail(snapshot.sessionId, id, candidate.ref, fields.map(f => f.key)), api(endpoint + '/' + id + '/evidence?candidateRef=' + encodeURIComponent(candidate.ref))])
    if (!valid(gen, id) || request !== detailRequest) return
    if (d.sourceVersion !== e.sourceVersion || (citation && citation.sourceVersion !== e.sourceVersion)) throw new Error('引用的来源版本已变化，请重新读取当前结果。')
    $('detail-title').textContent = d.displayId; const box = $('detail'); box.replaceChildren(text('h2', d.title), text('span', verdict(e.judgment?.verdict), 'badge'), text('h3', '匹配依据'), text('p', e.judgment?.reason || '正在结合原文核实。'))
    box.append(text('h3', e.citationCount ? '引用原文 · ' + e.citations.length + (e.citationCount > e.citations.length ? ' / ' + e.citationCount : '') : '暂无引用片段'))
    const spans = new Map()
    for (const c of e.citations) {
      const quoted = displayFieldPart(c.text), q = text('blockquote', quoted.value, 'citation'); q.dataset.citation = c.id
      if (quoted.speaker) q.prepend(text('small', quoted.speaker, 'speaker'))
      box.append(text('small', (labels.get(c.field) || c.field) + ' · ' + origin(c.origin)), q)
      const list = spans.get(c.field + '/' + c.part) ?? []; list.push(c); spans.set(c.field + '/' + c.part, list)
      box.append(button('查看上下文 ↓', () => box.querySelector('[data-field-index="' + fields.findIndex(f => f.key === c.field) + '"]')?.scrollIntoView({ block: 'start', behavior: motion() }), 'link'))
    }
    box.append(text('h3', '工单原文'))
    for (const [field, values] of Object.entries(d.fields)) {
      const section = text('section', '', 'field'); section.dataset.fieldIndex = String(fields.findIndex(f => f.key === field)); section.append(text('h3', labels.get(field) || field))
      values.forEach((value, part) => {
        const shown = displayFieldPart(value, spans.get(field + '/' + part) ?? []), p = text('p', '', shown.speaker ? 'dialogue-part' : ''); let offset = 0
        if (shown.speaker) p.append(text('small', shown.speaker, 'speaker'))
        for (const c of shown.ranges) { if (c.start < offset) continue; p.append(document.createTextNode(shown.value.slice(offset, c.start)), text('mark', shown.value.slice(c.start, c.end))); offset = c.end }
        p.append(document.createTextNode(shown.value.slice(offset))); section.append(p)
      }); box.append(section)
    }
    if (d.unavailableFields.length) box.append(text('h3', '未知或缺失字段'), text('p', '本工单未提供：' + d.unavailableFields.map(f => labels.get(f) || f).join('、'), 'muted'))
    box.append(audit('来源信息', '来源版本 ' + d.sourceVersion))
    const feedback = text('div', '', 'feedback-entry'); feedback.append(button('反馈问题', () => openFeedback({ ...candidate, displayId: d.displayId }))); box.append(feedback)
    if (citation) [...box.querySelectorAll('[data-citation]')].find(q => q.dataset.citation === citation.id)?.scrollIntoView({ block: 'nearest' })
  } catch (e) { if (!valid(gen, id) || request !== detailRequest) return; $('detail').replaceChildren(text('p', e.code ? detailFailureMessage(e) : e.message, 'notice error'), button('重试读取', () => detail(candidate, citation))) }
}
async function expertDetail(id) {
  openDetail('专家工作依据'); const gen = generation, request = ++detailRequest
  try {
    const e = await api(endpoint + '/' + taskId + '/experts/' + encodeURIComponent(id)); if (!valid(gen) || request !== detailRequest) return
    const expert = snapshot.orchestration?.experts.find(x => x.id === id)
    const box = $('detail'); box.replaceChildren(text('h2', expert?.title || '专项核查'), text('p', e.goal), text('p', e.scope, 'muted'))
    if (expert?.knowledge.length) { box.append(text('h3', '本次知识')); for (const k of expert.knowledge) box.append(button((k.used ? '已引用' : '已载入') + ' · 查看知识条目', () => orchestrationUI.openKnowledge(k.reference.split(':').at(-1).split('@')[0]), 'knowledge-chip')) }
    else box.append(text('p', '直接依据工单取证', 'muted'))
    if (e.question) box.append(text('p', e.question, 'notice'))
    for (const j of e.judgments) { const c = e.candidates.find(c => c.ref === j.candidateRef); box.append(text('p', (c?.displayId || '工单') + '：' + j.reason)); if (c) box.append(button('读取 ' + c.displayId + ' 的来源', () => detail(c))) }
    box.append(text('p', '已展示 ' + e.judgments.length + ' / ' + e.judgmentCount + ' 条判断。', 'muted'), text('p', e.nextAction || ''))
  } catch (e) { if (valid(gen) && request === detailRequest) $('detail').replaceChildren(text('p', e.message, 'notice error')) }
}
function openFeedback(candidate) {
  feedbackTarget = { candidate, generation, taskId }; $('feedback-title').textContent = candidate.displayId + ' · 反馈问题'; $('feedback-text').value = ''; $('feedback-dialog').showModal(); $('feedback-relevance').focus()
}
async function supplement() {
  if (sendingInput || !snapshot) return
  const value = $('supplement').value.trim(); if (!value) return
  sendingInput = true; $('send-supplement').disabled = true; const id = taskId, gen = generation, questionId = snapshot.question?.id
  try {
    const r = await command(endpoint + '/' + id, { kind: questionId ? 'answer' : 'supplement', text: value, ...(questionId ? { questionId } : {}) })
    if (!valid(gen, id)) return; acceptReceipt(r); $('supplement').value = ''; resizeInput($('supplement')); await refresh()
  } catch (e) { if (valid(gen, id)) error(e) } finally { sendingInput = false; updateComposerAction() }
}
async function loadReport() {
  if (!deliveryReady()) { $('report-content').replaceChildren(text('p', hasAccess() ? '检索结束后，这里会显示报告。' : '来源尚未就绪或访问资格已失效，请恢复连接或重新检索。', 'notice')); return }
  const gen = generation, request = ++reportRequest, revision = snapshot.node.result.resultRevision, audience = $('audience').value, id = taskId
  if (!report) $('report-content').replaceChildren(text('p', '正在读取当前版本报告…', 'loading'))
  try {
    const r = await api(endpoint + '/' + id + '/report?resultRevision=' + encodeURIComponent(revision) + '&audience=' + audience)
    if (!valid(gen, id) || request !== reportRequest || snapshot.node?.result?.resultRevision !== revision || audience !== $('audience').value) return
    report = r; renderReport()
  } catch (e) { if (valid(gen, id) && request === reportRequest) $('report-content').replaceChildren(text('p', e.message, 'notice error'), button('重试报告', () => loadReport())) }
}
function renderReport() {
  const r = report, box = $('report-content'); box.replaceChildren(text('span', '确认 ' + r.confirmedCount + ' 条工单', 'badge'), text('h3', '查询范围'), text('p', r.scope.originalQuery))
  for (const i of r.scope.inputs.filter(i => i.kind !== 'query')) box.append(text('p', i.text || '取消本轮任务'))
  for (const c of r.scope.conditions) box.append(text('p', (({ region: '地区', status: '状态', createdAt: '创建时间', updatedAt: '更新时间', resolvedAt: '解决时间' }[c.field] || c.field) + ' ' + ({ eq: '为', neq: '排除', contains: '包含', gte: '不早于', lte: '不晚于' }[c.op] || c.op) + ' ' + c.value), 'muted'))
  box.append(text('h3', '检索范围与限制'), text('p', ({ satisfied: '本次检索要求已满足。', no_result: '本轮无可确认结果。', incomplete: '本次检索尚未完成，以下为已确认的工单。' }[r.coverage.semanticStatus])), text('p', r.coverage.resultPagesExhausted ? '本次搜索的结果已全部返回。' : '本次搜索的结果尚未全部返回。'), text('p', r.coverage.semanticRecallKnown ? '已保存覆盖判断。' : '其他表述的相关工单仍可能遗漏。', 'muted'))
  for (const g of r.coverage.gaps.filter(g => !g.description.startsWith('semanticRecallKnown=false；'))) box.append(text('p', g.description))
  box.append(text('h3', '结论依据'))
  if (r.narrative.status === 'model') for (const p of r.narrative.paragraphs) {
    const paragraph = text('p', ''); revealText(paragraph, p.text, animateNextReport); box.append(paragraph)
    for (const id of p.citations) { const c = r.citations.find(c => c.id === id); if (c) box.append(button('查看引用 · ' + c.displayId, () => detail({ ref: c.candidateRef, displayId: c.displayId }, c), 'link')) }
  } else box.append(text('p', r.narrative.reason || '工单与引用已整理。生成报告后可查看进一步的说明。', 'notice'))
  for (const e of r.examples) box.append(text('h3', e.displayId + ' · ' + e.title))
  for (const c of r.citations) {
    const quoted = displayFieldPart(c.text)
    box.append(text('small', c.displayId + ' · ' + fieldLabel(snapshot.node.detailFields.find(f => f.key === c.field) || { key: c.field, label: c.field }) + ' · ' + (quoted.speaker || origin(c.origin))), text('blockquote', quoted.value), button('打开对应原文', () => detail({ ref: c.candidateRef, displayId: c.displayId }, c), 'link'))
  }
  const usage = text('details', '', 'report-audit'); usage.append(text('summary', '使用说明'), ...r.usage.map(t => text('p', t)))
  const decisions = text('details', '', 'report-audit'); decisions.append(text('summary', '核查记录'), text('p', r.conclusion), ...r.examples.map(e => text('p', e.displayId + '：' + e.reason)))
  box.append(decisions, usage, audit('文件校验信息', '结果版本 ' + r.resultRevision + ' · 集合 SHA-256 ' + r.confirmedSetSha256))
  animateNextReport = false
}
async function createArtifact(kind) {
  const revision = snapshot?.node?.result?.resultRevision; if (!revision || !deliveryReady()) return
  const gen = generation, id = taskId, control = $(kind === 'report' ? 'save-report' : kind === 'csv' ? 'download' : 'download-jsonl'); control.disabled = true
  try {
    await command(endpoint + '/' + id + '/artifacts', { kind, resultRevision: revision, template: kind === 'report' ? 'summary' : $('template').value, audience: $('audience').value })
    if (!valid(gen, id) || snapshot.node?.result?.resultRevision !== revision) return
    $('download-receipt').textContent = '正在生成文件…'; artifactsKey = ''
    if (kind === 'report') { generatingReport = true; animateNextReport = true; $('report-error').hidden = true; $('report-generating').hidden = false; setView('report') }
    else openDelivery()
    void loadArtifacts()
  } catch (e) { if (valid(gen, id)) error(e) } finally { if (valid(gen, id)) control.disabled = !deliveryReady() || (kind === 'report' ? generatingReport : !snapshot.node.exportEnabled) }
}
async function loadArtifacts() {
  clearTimeout(artifactTimer); if (!deliveryReady()) return
  const gen = generation, id = taskId, request = ++artifactRequest, revision = snapshot.node.result.resultRevision
  try {
    const list = await api(endpoint + '/' + id + '/artifacts')
    if (!valid(gen, id) || request !== artifactRequest || snapshot.node?.result?.resultRevision !== revision) return
    const current = list.filter(d => d.resultRevision === revision), key = JSON.stringify(current)
    const wasGenerating = generatingReport
    generatingReport = current.some(d => d.kind === 'report' && d.audience === $('audience').value && ['queued', 'running'].includes(d.status))
    $('report-generating').hidden = !generatingReport; $('save-report').disabled = generatingReport || !deliveryReady()
    if (wasGenerating && !generatingReport && view === 'report') { animateNextReport = true; void loadReport() }
    const reportJob = current.find(d => d.kind === 'report' && d.audience === $('audience').value)
    $('report-error').hidden = reportJob?.status !== 'failed'; $('report-error').textContent = reportJob?.status === 'failed' ? '报告未能生成。' + (reportJob.error || '请重试。') : ''
    if (key !== artifactsKey) {
      $('artifacts').replaceChildren(...current.map(d => {
        const row = text('div', '', 'card'), name = d.kind === 'report' ? (d.audience === 'handoff' ? '领导交接报告' : '工作人员报告') : d.kind.toUpperCase()
        row.append(text('strong', name + (d.kind === 'report' ? '' : d.template === 'full' ? ' · 完整正文' : ' · 概览') + ' · ' + ({ queued: '已排队', running: '生成中', ready: '可保存', failed: '生成失败', expired: '已到期' }[d.status])), text('p', d.rowCount + ' 条 · ' + d.byteCount + ' 字节' + (d.error ? ' · ' + d.error : '')))
        if (d.status === 'ready') { row.append(button('保存 ' + name, () => downloadArtifact(d)), button('保存范围说明', () => downloadManifest(d))); if (d.kind === 'report') row.append(button('阅读报告', () => { $('delivery').close(); $('audience').value = d.audience; setView('report', true) })) }
        if (d.status === 'failed') row.append(button('重试生成', async () => { try { await api(endpoint + '/' + id + '/artifacts', { operationId: d.operationId, kind: d.kind, template: d.template, audience: d.audience, resultRevision: d.resultRevision, retry: true }); if (valid(gen, id)) { artifactsKey = ''; void loadArtifacts() } } catch (e) { if (valid(gen, id)) error(e) } }))
        if (d.status === 'expired') row.append(text('p', '文件已到期，可按当前有效结果重新生成。'))
        if (d.contentSha256) row.append(audit('文件详情', 'SHA-256 ' + d.contentSha256 + ' · 到期 ' + new Date(d.expiresAt).toLocaleString())); return row
      })); artifactsKey = key
    }
    if (current.some(d => ['queued', 'running'].includes(d.status))) artifactTimer = setTimeout(() => void loadArtifacts(), 1500)
  } catch (e) { if (valid(gen, id) && request === artifactRequest) { error(e); artifactTimer = setTimeout(() => void loadArtifacts(), 5000) } }
}
function saveBlob(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
async function assertDownloadCurrent(d, gen, id) {
  const current = await api(endpoint + '/' + id)
  if (!valid(gen, id) || current.inputRevision !== snapshot?.inputRevision || current.node?.result?.resultRevision !== d.resultRevision || (d.kind !== 'report' && current.node?.collectionWindow?.confirmed !== d.rowCount)) throw new Error('结果版本或确认数量已变化，文件未保存，请读取当前结果。')
}
async function downloadArtifact(d) {
  clearError(); const gen = generation, id = taskId
  try {
    const response = await fetch(endpoint + '/' + id + '/artifacts/' + d.id + '/content')
    if (!response.ok) { const e = await response.json(); throw new Error(e.message) }
    const content = await response.arrayBuffer(), hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', content))].map(v => v.toString(16).padStart(2, '0')).join('')
    if (!valid(gen, id)) return
    if (hash !== d.contentSha256 || hash !== response.headers.get('x-content-sha256') || content.byteLength !== d.byteCount || response.headers.get('x-result-revision') !== d.resultRevision) throw new Error('文件哈希、字节数或结果版本不一致，请重新生成。')
    await assertDownloadCurrent(d, gen, id); saveBlob(new Blob([content], { type: response.headers.get('content-type') }), d.fileName)
    $('download-receipt').textContent = '已保存' + (d.kind === 'report' ? '检索报告' : ' ' + d.rowCount + ' 条工单')
  } catch (e) { if (valid(gen, id)) error(e) }
}
async function downloadManifest(d) {
  const gen = generation, id = taskId
  try { const manifest = await api(endpoint + '/' + id + '/artifacts/' + d.id + '/manifest'); await assertDownloadCurrent(d, gen, id); if (manifest.resultRevision !== d.resultRevision || manifest.contentSha256 !== d.contentSha256) throw new Error('范围说明与当前文件不一致。'); saveBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), 'manifest-' + d.id + '.json') }
  catch (e) { if (valid(gen, id)) error(e) }
}
$('query-form').onsubmit = async event => {
  event.preventDefault(); if ($('start').disabled) return; $('start').disabled = true
  try { const r = await command(endpoint, { kind: 'query', text: $('query').value.trim() }); await enterTask(r.taskId) }
  catch (e) { error(e) } finally { $('start').disabled = false }
}
$('examples').onclick = event => { const b = event.target.closest('button'); if (b) { $('query').value = b.dataset.query; resizeInput($('query')); $('query').focus() } }
$('supplement-form').onsubmit = e => { e.preventDefault(); void supplement() }
function canStop() { return Boolean(snapshot && snapshot.commands.at(-1)?.kind !== 'cancel' && !snapshot.orchestration?.terminal && !snapshot.node?.result) }
function updateComposerAction() {
  const stop = canStop() && !$('supplement').value.trim(), button = $('send-supplement')
  button.dataset.mode = stop ? 'stop' : 'send'; button.type = stop ? 'button' : 'submit'
  button.disabled = stopping || sendingInput || (!stop && !$('supplement').value.trim())
  button.setAttribute('aria-label', stopping ? '正在停止' : stop ? '强制停止' : snapshot?.question ? '发送回复' : '发送补充')
  button.title = button.getAttribute('aria-label')
  $('cancel').disabled = stopping || !canStop()
}
async function forceStop() {
  if (stopping || !canStop()) return
  const gen = generation, id = taskId
  stopping = true; updateComposerAction(); $('receipt').textContent = '正在停止主 Agent 和专家…'
  // A queued answer/feedback must not be replayed on reconnect after the user stops.
  writeSaved(pendingKey, saved(pendingKey).filter(item => item.path !== endpoint + '/' + id || item.spec.kind === 'cancel'))
  try { const r = await command(endpoint + '/' + id, { kind: 'cancel' }); if (valid(gen, id)) { acceptReceipt(r, 'cancel'); await refresh(); $('receipt').textContent = '已停止，结果与轨迹已保留' } }
  catch (e) { if (valid(gen, id)) error(e) }
  finally { stopping = false; updateComposerAction() }
}
$('cancel').onclick = forceStop
$('send-supplement').onclick = event => { if ($('send-supplement').dataset.mode === 'stop') { event.preventDefault(); void forceStop() } }
$('feedback-form').onsubmit = async event => {
  event.preventDefault(); if ($('send-feedback').disabled) return; $('send-feedback').disabled = true; const f = feedbackTarget
  try {
    if (!valid(f.generation, f.taskId)) throw new Error('查询条件已变化，请重新读取工单。')
    const r = await command(endpoint + '/' + f.taskId, { kind: 'feedback', candidateRef: f.candidate.ref, relevance: $('feedback-relevance').value, text: $('feedback-text').value.trim() || '用户认为 ' + f.candidate.displayId + ($('feedback-relevance').value === 'related' ? ' 相关' : ' 不相关') })
    if (!valid(f.generation, f.taskId)) return
    $('feedback-dialog').close(); acceptReceipt(r); await refresh(); $('supplement').focus()
  } catch (e) { if (valid(f.generation, f.taskId)) error(e) } finally { $('send-feedback').disabled = false }
}
$('close-feedback').onclick = () => $('feedback-dialog').close(); $('close-detail').onclick = () => closeDetail()
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('feedback-dialog').open && !$('evidence-panel').hidden) { e.preventDefault(); closeDetail() } })
for (const name of ['results', 'process', 'collaboration', 'report']) $('tab-' + name).onclick = () => setView(name)
document.querySelector('[role="tablist"]').onkeydown = e => { const names = ['results', 'process', 'collaboration', 'report']; let i = names.indexOf(view); if (e.key === 'ArrowRight') i = (i + 1) % names.length; else if (e.key === 'ArrowLeft') i = (i + names.length - 1) % names.length; else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = names.length - 1; else return; e.preventDefault(); setView(names[i], true) }
$('candidate-disclosure').ontoggle = () => { if (view === 'process') { $('list-region').hidden = !$('candidate-disclosure').open; if ($('candidate-disclosure').open) void loadPage(undefined, true) } }
$('candidate-view').onchange = () => { page = undefined; void loadPage(undefined, true) }
$('new-results').onclick = () => { clearError(); void loadPage(undefined, true) }
$('next-page').onclick = () => { if (page?.nextCursor && !pageLoading) { previousCursors.push(pageCursor); void loadPage(page.nextCursor) } }
$('prev-page').onclick = () => { if (previousCursors.length && !pageLoading) void loadPage(previousCursors.pop()) }
function openDelivery() { if (!$('delivery').open) $('delivery').showModal() }
$('delivery-link').onclick = openDelivery
$('close-delivery').onclick = () => $('delivery').close()
$('evidence-panel').oncancel = e => { e.preventDefault(); closeDetail() }
// Textareas grow with the content instead of creating a second tiny scroll region.
function resizeInput(input) { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, input.id === 'query' ? 260 : 160) + 'px' }
for (const id of ['query', 'supplement']) {
  $(id).addEventListener('input', () => { resizeInput($(id)); if (id === 'supplement') updateComposerAction() })
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $(id).form.requestSubmit() } })
}
function setNavigation(open) {
  document.body.dataset.nav = open ? 'open' : ''; $('nav-scrim').hidden = !open; $('open-nav').setAttribute('aria-expanded', String(open))
  // The off-canvas navigation traps focus and makes the obscured workspace inert.
  $('main-content').inert = open
  if (open) requestAnimationFrame(() => { if (document.body.dataset.nav === 'open') $('close-nav').focus() })
  else (matchMedia('(max-width:820px)').matches ? $('open-nav') : document.querySelector('.brand')).focus({ preventScroll: true })
}
$('open-nav').onclick = () => setNavigation(true); $('close-nav').onclick = $('nav-scrim').onclick = () => setNavigation(false)
document.addEventListener('keydown', e => {
  if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); location.href = '/retrieval' }
  if (document.body.dataset.nav !== 'open') return
  if (e.key === 'Escape') { e.preventDefault(); setNavigation(false) }
  if (e.key === 'Tab') { const controls = [...$('sidebar').querySelectorAll('a,button')], first = controls[0], last = controls.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() } }
})
matchMedia('(min-width:821px)').addEventListener('change', e => { if (e.matches && document.body.dataset.nav === 'open') setNavigation(false) })
$('download').onclick = () => void createArtifact('csv'); $('download-jsonl').onclick = () => void createArtifact('jsonl')
$('save-report').onclick = () => void createArtifact('report'); $('reload-report').onclick = () => void loadReport(); $('audience').onchange = () => { report = undefined; void loadReport() }
window.addEventListener('offline', () => { disconnected = true; $('connection').textContent = connectionNotice(); if (snapshot) orchestrationUI.update(snapshot, true) })
window.addEventListener('online', () => { void retrySaved(); void refresh(); subscribe() })
window.addEventListener('pagehide', () => { stream?.close(); clearTimeout(artifactTimer); clearTimeout(refreshTimer) })
window.addEventListener('pageshow', event => { if (event.persisted) { void refresh(); subscribe() } })
void historyLinks()
void (async () => { if (taskId) { $('home').hidden = true; $('task').hidden = false; await refresh(); subscribe() } await retrySaved() })()
