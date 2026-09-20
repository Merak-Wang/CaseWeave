const $ = id => document.getElementById(id)
const el = (tag, value = '', cls = '') => { const node = document.createElement(tag); node.textContent = value; node.className = cls; return node }
export const qualityValue = value => typeof value === 'number' ? (value * 100).toFixed(1) + '%' : '未测量'
export const evidenceScopeChanged = (previous, next) => previous.inputRevision !== next.inputRevision
  || previous.node?.snapshotShortId !== next.node?.snapshotShortId
  || ['snapshot_invalid', 'permission_blocked'].includes(next.node?.status)
  || Boolean(previous.node?.result && previous.node.result.resultRevision !== next.node?.result?.resultRevision)
export const collectionBoundary = result => (result.resultPagesExhausted ? '当前检索表达式已枚举完；这不代表每条线索都已判定。' : '当前检索表达式尚未枚举完。')
  + (result.semanticRecallKnown ? '' : '其他表述的相关工单仍可能遗漏。')

const learningStates = {
  sampling: '正在抽样判断', quality_passed: '集合质量检验通过', quality_not_met: '集合质量尚未达标',
  needs_coverage: '正在补充表达覆盖', needs_information: '需要补充工单证据', needs_selection_coverage: '模型选择样本覆盖不足',
}
export function retrievalSummary(snapshot) {
  const process = snapshot.orchestration?.retrieval
  const learning = process?.learning
  const result = snapshot.node?.result?.learnedSet
  const accepted = Boolean(result || learning?.resultAvailable)
  return { plan: process?.plan, learning, accepted, quality: result?.quality ?? learning?.quality,
    status: learningStates[learning?.status] ?? '正在准备全集筛选',
    method: accepted ? '包含模型预测的确认集合' : '按证据持续确认',
    explanation: accepted ? '集合通过抽样质量检验；模型预测项未逐条调用语言模型判断。'
      : 'Agent 按当前要求核对工单，确认结果会持续出现在下方。',
  }
}

function qualityGrid(quality) {
  const grid = el('div', '', 'quality-grid')
  for (const [name, key, target] of [['查准率下界', 'precision_lower', 'precision_target'], ['召回率下界', 'recall_lower', 'recall_target']]) {
    const item = el('div')
    item.append(el('span', name), el('strong', qualityValue(quality[key])), el('small', '目标 ' + qualityValue(quality[target])))
    grid.append(item)
  }
  return grid
}

/** 本轮快照替换判据、召回与学习摘要；修订后不延用上一轮的质量结论。 */
export function renderRetrieval(snapshot) {
  const summary = retrievalSummary(snapshot), { plan, learning, quality } = summary
  $('plan-predicate').textContent = plan?.instruction || '正在理解你的要求，检索判据形成后会显示在这里。'
  $('plan-goal').textContent = !plan ? '规划中' : plan.goal?.mode === 'all' ? '查找全部符合条件的工单'
    : plan.goal?.mode === 'examples' && plan.goal.count ? '查找 ' + plan.goal.count + ' 条符合条件的工单' : '按问题覆盖决定停止'
  $('plan-keywords').replaceChildren(...(plan?.keywords ?? []).map(term => el('span', term, 'term')))
  $('plan-keywords').hidden = !plan?.keywords?.length
  $('plan-expressions').replaceChildren(...(plan?.expressions ?? []).map(value => el('li', value)))
  $('plan-rewrites').hidden = !plan?.expressions?.length
  const channels = snapshot.node?.searchProgress?.channels ?? []
  $('recall-channels').replaceChildren(...[['keyword', '关键词宽召回', '按关键词跨字段查找字面命中'], ['vector', '语义召回', '从原句与语义改写发现相关线索']].map(([key, label, note]) => {
    const channel = channels.find(c => c.channel === key), card = el('article', '', 'recall-card')
    const state = channel ? { running: '检索中', completed: '已返回', failed: '通道失败', skipped: '本轮未使用' }[channel.status] : '等待启动'
    card.dataset.state = channel?.status ?? 'pending'
    const heading = el('div', '', 'row between'); heading.append(el('h3', label), el('span', state, 'channel-state'))
    card.append(heading, el('strong', channel ? Number(channel.count).toLocaleString() : '—', 'recall-count'), el('span', ' 条线索', 'muted'), el('p', note, 'muted'))
    return card
  }))
  $('learning-progress').hidden = !learning
  if (learning) {
    $('learning-status').textContent = summary.status
    $('learning-progress').dataset.state = learning.status
    $('learning-metrics').replaceChildren(...[['筛选范围', learning.scopeCount], ['已抽样判断', learning.sampledCount], ['训练样本', learning.trainingCount], ['独立抽验', learning.auditCount]].map(([label, value]) => {
      const metric = el('div'); metric.append(el('strong', typeof value === 'number' ? value.toLocaleString() : '—'), el('span', label)); return metric
    }))
    $('learning-quality').replaceChildren(...(quality ? [qualityGrid(quality), el('p', '相对抽验参考标签的集合质量下界，依赖标签可靠性；不是单条工单的置信度，也不证明全库找全。', 'muted')] : [el('p', '抽样与全集预测完成后进行独立检验；质量结果尚未产生。', 'muted')]))
  }
  const method = $('result-method')
  const methodKey = JSON.stringify([summary.accepted, quality])
  // 无关进度刷新不重建质量说明，保留用户的展开状态与键盘焦点。
  if (method.dataset.key === methodKey) return
  method.dataset.key = methodKey
  method.hidden = !summary.accepted
  method.replaceChildren()
  if (summary.accepted) {
    method.append(el('strong', summary.method), el('p', summary.explanation))
    if (quality) {
      const details = el('details', '', 'method-quality')
      details.append(el('summary', '查看集合质量'), qualityGrid(quality), el('small', '质量下界相对抽验标签计算，依赖参考标签可靠性。'))
      method.append(details)
    }
  }
}
