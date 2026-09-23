import { sampleAllocation } from './workbench-flow.js'
const $ = id => document.getElementById(id)
const el = (tag, value = '', cls = '') => { const node = document.createElement(tag); node.textContent = value; node.className = cls; return node }
export const qualityValue = value => typeof value === 'number' ? (value * 100).toFixed(1) + '%' : '未测量'
export const qualityDescription = q => q.basis === 'selection'
  ? `选择集 P/R：${qualityValue(q.precision)} / ${qualityValue(q.recall)}`
  : `历史抽验 P/R 下界：${qualityValue(q.precision_lower)} / ${qualityValue(q.recall_lower)}`
export const evidenceScopeChanged = (previous, next) => previous.inputRevision !== next.inputRevision
  || previous.node?.snapshotShortId !== next.node?.snapshotShortId
  || ['snapshot_invalid', 'permission_blocked'].includes(next.node?.status)
  || Boolean(previous.node?.result && previous.node.result.resultRevision !== next.node?.result?.resultRevision)
export const collectionBoundary = result => result.resultPagesExhausted ? '当前检索表达式已枚举完。' : '当前检索表达式未全部枚举。'

const learningStates = {
  resuming_selection: '复用已有模型，继续补充选择样本', resuming_discovery: '复用已有抽样池，继续补充发现',
  scanning: '正在读取召回并集特征', ranked_sampling: '正在为召回并集排序样本', diversity_sampling: '正在进行 K-means++ 多样性采样', training: '正在训练候选模型',
  selecting: '正在比较模型', predicting: '正在预测', auditing: '正在抽样判断',
  sampling: '正在抽样判断', quality_passed: '模型选择完成', quality_not_met: '语义筛选已结束',
  quality_fallback: '模型选择完成', model_unknown: '无法判断',
  needs_coverage: '等待补充样本', needs_information: '等待工单证据', needs_selection_coverage: '等待选择样本',
}
export function retrievalSummary(snapshot) {
  const process = snapshot.orchestration?.retrieval
  const learning = process?.learning
  const result = snapshot.node?.result?.learnedSet
  const accepted = Boolean(result || learning?.resultAvailable), quality = result?.quality ?? learning?.quality
  return { plan: process?.plan, learning, accepted, quality,
    filterActivity: process?.filterActivity,
    status: process?.filterActivity === 'failed' ? '语义筛选失败'
      : learning?.status === 'model_unknown' ? '无法判断'
        : accepted ? '语义筛选已完成'
          : learningStates[learning?.status] ?? '准备语义筛选',
    method: accepted ? '语义筛选结果' : '语义筛选',
  }
}

export function learningSteps(learning, failed = false) {
  const l = learning ?? {}, status = l.status
  const active = { scanning: 0, ranked_sampling: 1, diversity_sampling: 1, sampling: l.samplingPhase === 'model_threshold_selection' ? 3 : 1,
    resuming_selection: 3, resuming_discovery: 1,
    training: 2, selecting: 3, predicting: 4, auditing: 5 }[status]
  const done = [l.scopeCount > 0, l.sampledCount > 0, l.fitCount > 0, Boolean(l.selectedModel),
    l.predictedCount > 0 && l.predictedCount === l.scopeCount, Boolean(l.quality)]
  return ['读取召回并集特征', '样本排序与判断', '候选模型训练', '模型与阈值选择', '召回并集预测', ...(l.auditCount > 0 || status === 'auditing' ? ['历史独立抽验'] : [])]
    .map((label, i) => ({ label, state: i === active ? failed ? 'failed' : 'active' : done[i] ? 'done' : 'pending' }))
}

function renderLearningDetails(learning, failed) {
  const l = learning ?? {}, pipeline = el('ol', '', 'learning-stages')
  pipeline.setAttribute('aria-label', '学习式筛选阶段')
  for (const step of learningSteps(l, failed)) {
    const item = el('li'); item.dataset.state = step.state
    item.append(el('span', step.label), el('small', { pending: '尚未执行', done: '已记录', active: '进行中', failed: '中断' }[step.state])); pipeline.append(item)
  }
  const nodes = [pipeline]
  const allocation = sampleAllocation(l)
  if (allocation) {
    const table = el('table', '', 'model-comparison sample-allocation'), head = el('tr')
    for (const label of ['样本用途', '抽样总数', '有效标签', '未决']) head.append(el('th', label))
    const thead = el('thead'); thead.append(head); table.append(thead)
    const body = el('tbody')
    for (const [label, part] of [['训练模型', allocation.training], ['选择模型与阈值', allocation.selection]]) {
      const row = el('tr'); for (const value of [label, part.total, part.labeled, part.unknown]) row.append(el('td', value)); body.append(row)
    }
    table.append(body); nodes.push(table)
  }
  if (l.samplingRequestLimit) nodes.push(el('p', `抽样请求 ${l.samplingRequests ?? 0} / ${l.samplingRequestLimit}（不含自动重试）`, 'muted'))
  if (failed) nodes.push(el('p', l.status ? '执行中断' : '筛选算子失败', 'notice'))
  if (l.precisionTarget && l.recallTarget) nodes.push(el('p', `模型选择集目标：查准率 ≥ ${qualityValue(l.precisionTarget)}，召回率 ≥ ${qualityValue(l.recallTarget)}。`, 'muted'))
  if (l.selectedModel) nodes.push(el('p', `入选模型：${l.selectedModel} · 阈值 ${Number(l.threshold).toPrecision(4)}`))
  if (l.models?.length) {
    const table = el('table', '', 'model-comparison'), head = el('tr')
    for (const label of ['候选模型', '选择集查准率', '选择集召回率', '选用']) head.append(el('th', label))
    const thead = el('thead'); thead.append(head); table.append(thead)
    const body = el('tbody')
    for (const m of l.models) { const row = el('tr'); row.dataset.selected = String(m.name === l.selectedModel)
      for (const value of [m.name, qualityValue(m.precision), qualityValue(m.recall), m.name === l.selectedModel ? '✓' : '—']) row.append(el('td', value)); body.append(row) }
    table.append(body); nodes.push(table)
  }
  return nodes
}

function qualityGrid(quality) {
  const grid = el('div', '', 'quality-grid')
  const metrics = quality.basis === 'selection'
    ? [['选择集查准率', 'precision', 'precision_target'], ['选择集召回率', 'recall', 'recall_target']]
    : [['历史查准率下界', 'precision_lower', 'precision_target'], ['历史召回率下界', 'recall_lower', 'recall_target']]
  for (const [name, key, target] of metrics) {
    const item = el('div')
    item.append(el('span', name), el('strong', qualityValue(quality[key])), el('small', '目标 ' + qualityValue(quality[target])))
    grid.append(item)
  }
  return grid
}

/** 本轮快照替换判据、召回与学习摘要；修订后不延用上一轮的质量结论。 */
export function renderRetrieval(snapshot, { openKnowledge, showKnowledge } = {}) {
  const summary = retrievalSummary(snapshot), { plan, learning, quality } = summary
  $('plan-predicate').textContent = plan?.instruction || '正在理解你的要求，检索判据形成后会显示在这里。'
  $('plan-goal').textContent = !plan ? '规划中' : plan.goal?.mode === 'all' ? '查找全部符合条件的工单'
    : plan.goal?.mode === 'examples' && plan.goal.count ? '查找 ' + plan.goal.count + ' 条符合条件的工单' : '按问题覆盖决定停止'
  $('plan-keywords').replaceChildren(...(plan?.keywords ?? []).map(term => el('span', term, 'term')))
  $('plan-keywords').hidden = !plan?.keywords?.length
  $('plan-expressions').replaceChildren(...(plan?.expressions ?? []).map(value => el('li', value)))
  $('plan-rewrites').hidden = !plan?.expressions?.length
  const routes = plan?.knowledgeRoutes
  $('plan-knowledge').replaceChildren(...(routes?.length ? routes.map(route => {
    const item = el('li'), link = el('button', route.title, 'link'); link.type = 'button'; link.onclick = () => openKnowledge?.(route.entry_id)
    item.append(link, el('span', '：' + route.reason)); return item
  }) : [el('li', routes ? 'Agent 未选择适用知识，按用户判据和工单原文进行零样本判断。' : '等待检索 Agent 选择适用知识。')]))
  const channels = snapshot.node?.searchProgress?.channels ?? []
  $('recall-channels').replaceChildren(...[['keyword', '关键词宽召回'], ['vector', '语义召回']].map(([key, label]) => {
    const channel = channels.find(c => c.channel === key), card = el('article', '', 'recall-card')
    const state = channel ? { running: '检索中', completed: '已返回', failed: '通道失败', skipped: '本轮未使用' }[channel.status] : '等待启动'
    card.dataset.state = channel?.status ?? 'pending'
    const heading = el('div', '', 'row between'); heading.append(el('h3', label), el('span', state, 'channel-state'))
    card.append(heading, el('strong', channel ? Number(channel.count).toLocaleString() : '—', 'recall-count'), el('span', ' 条线索', 'muted'))
    return card
  }))
  $('learning-progress').hidden = !learning && !summary.filterActivity
  if (learning || summary.filterActivity) {
    $('learning-status').textContent = summary.status
    $('learning-progress').dataset.state = summary.filterActivity === 'failed' ? 'failed' : learning?.status ?? 'pending'
    $('learning-stages').replaceChildren(...renderLearningDetails(learning, summary.filterActivity === 'failed'))
    $('learning-metrics').replaceChildren(...[['召回并集工单数', learning?.scopeCount], ['抽样工单总数', learning?.sampledCount], ['训练有效标签', learning?.trainingCount], ['已预测', learning?.predictedCount], ['选择集总数（含未决）', learning?.selectionCount], ...(learning?.auditCount > 0 ? [['历史抽验', learning.auditCount]] : [])].map(([label, value]) => {
      const metric = el('div'); metric.append(el('strong', typeof value === 'number' ? value.toLocaleString() : '—'), el('span', label)); return metric
    }))
    $('learning-quality').replaceChildren(...(quality ? [qualityGrid(quality)] : [el('p', '正在评估模型', 'muted')]))
    if (learning?.knowledgeEntryCount && showKnowledge) { const link = el('button', '查看领域判断与知识引用 ↗', 'link'); link.type = 'button'; link.onclick = showKnowledge; $('learning-quality').append(link) }
  }
  const method = $('result-method')
  const methodKey = JSON.stringify([summary.accepted, quality])
  // 无关进度刷新不重建质量说明，保留用户的展开状态与键盘焦点。
  if (method.dataset.key === methodKey) return
  method.dataset.key = methodKey
  method.hidden = !summary.accepted
  method.replaceChildren()
  if (summary.accepted) {
    method.append(el('strong', summary.method))
    if (quality) {
      const details = el('details', '', 'method-quality')
      details.append(el('summary', quality.basis === 'selection' ? '查看选择集指标' : '查看历史抽验指标'), qualityGrid(quality))
      method.append(details)
    }
  }
}
