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
  resuming_selection: '复用已有模型，继续补充选择样本', resuming_discovery: '复用已有抽样池，继续补充发现',
  scanning: '正在读取全范围特征', ranked_sampling: '正在按原句相关性排序样本', diversity_sampling: '正在进行 K-means++ 多样性采样', training: '正在训练候选模型',
  selecting: '正在比较模型与阈值', predicting: '正在分块预测全范围', auditing: '正在进行独立质量抽验',
  sampling: '正在抽样判断', quality_passed: '集合质量检验通过', quality_not_met: '集合质量尚未达标',
  needs_coverage: '训练样本类别覆盖不足', needs_information: '需要补充工单证据', needs_selection_coverage: '模型选择样本覆盖不足',
}
export function trainingExplanation(l = {}) {
  if (l.fitCount > 0) return `已完成 ${l.fitCount} 次分类模型拟合；模型训练使用数值特征，在 Python 本地执行。`
  if (typeof l.positiveCount !== 'number') return '分类模型训练尚未开始；需要有依据的正例与反例，未决样本不作为训练标签。'
  const counts = `当前正例 ${l.positiveCount} 条、反例 ${l.negativeCount} 条、未决 ${l.unresolvedCount} 条。`
  return counts + (l.positiveCount === 0 || l.negativeCount === 0
    ? `尚缺${l.positiveCount === 0 && l.negativeCount === 0 ? '正反例' : l.positiveCount === 0 ? '正例' : '反例'}，还不能训练二分类模型。`
    : '已获得正反例，样本批次完成后开始训练。')
}
export function retrievalSummary(snapshot) {
  const process = snapshot.orchestration?.retrieval
  const learning = process?.learning
  const result = snapshot.node?.result?.learnedSet
  const accepted = Boolean(result || learning?.resultAvailable)
  return { plan: process?.plan, learning, accepted, quality: result?.quality ?? learning?.quality,
    filterActivity: process?.filterActivity,
    status: process?.filterActivity === 'failed' ? '语义筛选未完成' : learningStates[learning?.status] ?? '正在准备全集筛选',
    method: accepted ? '包含模型预测的确认集合' : '按证据持续确认',
    explanation: accepted ? '集合通过抽样质量检验；模型预测项未逐条调用语言模型判断。'
      : 'Agent 按当前要求核对工单，确认结果会持续出现在下方。',
  }
}

export function learningSteps(learning, failed = false) {
  const l = learning ?? {}, status = l.status
  const active = { scanning: 0, ranked_sampling: 1, diversity_sampling: 1, sampling: l.samplingPhase === 'model_threshold_selection' ? 3 : 1,
    resuming_selection: 3, resuming_discovery: 1,
    training: 2, selecting: 3, predicting: 4, auditing: 5 }[status]
  const done = [l.scopeCount > 0, l.sampledCount > 0, l.fitCount > 0, Boolean(l.selectedModel),
    l.predictedCount > 0 && l.predictedCount === l.scopeCount, Boolean(l.quality)]
  return ['读取特征', '样本排序与判断', '候选模型训练', '模型与阈值选择', '全范围预测', '独立质量抽验']
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
  if (failed) nodes.push(el('p', l.status ? '执行已中断，以下保留最后一次实际进度。' : '算子在学习开始前失败，尚无样本判断、训练或选模记录。', 'notice'))
  if (l.samplingMethod === 'ngram_vector_desc') nodes.push(el('p', `按原句 n-gram 覆盖率与向量相似度从高到低判断${l.sampleSize ? `，每轮最多 ${l.sampleSize} 条` : ''}。训练与模型选择样本交错留出，不随机补样；排名只决定判断顺序，不代表已经命中。`, 'muted'))
  else if (l.samplingMethod) nodes.push(el('p', `该历史运行使用混合采样${l.sampleSize ? `，首轮 ${l.sampleSize} 条` : ''}，方法为 ${l.samplingMethod}。`, 'muted'))
  nodes.push(el('p', trainingExplanation(l), 'notice'))
  if (l.batchSize) nodes.push(el('p', `大模型${l.concurrency ? `最多 ${l.concurrency} 路并发，` : ''}每次请求判断 ${l.batchSize} 条样本，并在预测后参与独立抽验；采样和模型拟合本身不调用大模型。`, 'muted'))
  if (l.reusedLabelCount) nodes.push(el('p', `本轮沿用 ${l.reusedLabelCount} 条已有判断${l.reusedTrainingCount ? `及 ${l.reusedTrainingCount} 条样本训练出的模型` : ''}，继续补充缺少的样本。`, 'muted'))
  if (l.reusedUnresolvedCount) nodes.push(el('p', `${l.reusedUnresolvedCount} 条未决样本的证据没有变化，保留原判断，未再次请求模型。`, 'muted'))
  if (l.precisionTarget && l.recallTarget) nodes.push(el('p', `本次独立抽验目标：查准率下界 ≥ ${qualityValue(l.precisionTarget)}，召回率下界 ≥ ${qualityValue(l.recallTarget)}。`, 'muted'))
  if (l.knowledgeEntryCount) nodes.push(el('p', `本轮样本判断请求已带入 ${l.knowledgeEntryCount} 条专家知识，用于解释业务术语、状态与歧义；标签依据仍来自工单原文。`, 'muted'))
  if (l.candidateModels?.length) nodes.push(el('p', '候选分类模型：' + l.candidateModels.join(' · ')))
  if (l.selectedModel) nodes.push(el('p', `入选模型：${l.selectedModel} · 阈值 ${Number(l.threshold).toPrecision(4)}`))
  if (l.models?.length) {
    const table = el('table', '', 'model-comparison'), head = el('tr')
    for (const label of ['候选模型', '选择集查准率', '选择集召回率', '选择集达标']) head.append(el('th', label))
    const thead = el('thead'); thead.append(head); table.append(thead)
    const body = el('tbody')
    for (const m of l.models) { const row = el('tr'); row.dataset.selected = String(m.name === l.selectedModel)
      for (const value of [m.name, qualityValue(m.precision), qualityValue(m.recall), m.feasible_on_selection ? '是' : '否']) row.append(el('td', value)); body.append(row) }
    table.append(body); nodes.push(table, el('small', '上述指标来自模型选择样本；最终集合质量另用独立样本检验。', 'muted'))
  }
  return nodes
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
  const routes = plan?.knowledgeRoutes
  $('plan-knowledge').replaceChildren(...(routes?.length ? routes.map(route => {
    const item = el('li'); item.append(el('strong', route.title), el('span', '：' + route.reason)); return item
  }) : [el('li', routes ? 'Agent 未选择适用知识，按用户判据和工单原文进行零样本判断。' : '等待检索 Agent 选择适用知识。')]))
  const channels = snapshot.node?.searchProgress?.channels ?? []
  $('recall-channels').replaceChildren(...[['keyword', '关键词宽召回', '按关键词跨字段查找字面命中'], ['vector', '语义召回', 'Top 15 保底 · 相似度 > 0.75 全部召回 · 每批 100 条']].map(([key, label, note]) => {
    const channel = channels.find(c => c.channel === key), card = el('article', '', 'recall-card')
    const state = channel ? { running: '检索中', completed: '已返回', failed: '通道失败', skipped: '本轮未使用' }[channel.status] : '等待启动'
    card.dataset.state = channel?.status ?? 'pending'
    const heading = el('div', '', 'row between'); heading.append(el('h3', label), el('span', state, 'channel-state'))
    card.append(heading, el('strong', channel ? Number(channel.count).toLocaleString() : '—', 'recall-count'), el('span', ' 条线索', 'muted'), el('p', note, 'muted'))
    return card
  }))
  $('learning-progress').hidden = !learning && !summary.filterActivity
  if (learning || summary.filterActivity) {
    $('learning-status').textContent = summary.status
    $('learning-progress').dataset.state = summary.filterActivity === 'failed' ? 'failed' : learning?.status ?? 'pending'
    $('learning-stages').replaceChildren(...renderLearningDetails(learning, summary.filterActivity === 'failed'))
    $('learning-metrics').replaceChildren(...[['筛选范围', learning?.scopeCount], ['已抽样判断', learning?.sampledCount], ['训练样本', learning?.trainingCount], ['已预测', learning?.predictedCount], ['选择样本', learning?.selectionCount], ['独立抽验', learning?.auditCount]].map(([label, value]) => {
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
