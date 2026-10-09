import { sampleAllocation } from './workbench-flow.js'
const $ = id => document.getElementById(id)
const el = (tag, value = '', cls = '') => { const node = document.createElement(tag); node.textContent = value; node.className = cls; return node }
export const qualityValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? (value * 100).toFixed(1) + '%' : '未测量'
export const trainingCrossfitNote = '训练组交叉拟合教师一致率用于选模；不是业务准确率，也不是最终独立验收。'
export const qualityDescription = q => q.basis === 'training_group_crossfit'
  ? `训练组交叉拟合教师一致率 P/R：${qualityValue(q.precision)} / ${qualityValue(q.recall)}；用于选模，非独立验收。`
  : q.basis === 'selection'
  ? `选择集 P/R：${qualityValue(q.precision)} / ${qualityValue(q.recall)}`
  : q.basis == null || q.basis === 'independent_audit'
    ? `历史抽验 P/R 下界：${qualityValue(q.precision_lower)} / ${qualityValue(q.recall_lower)}` : '质量参考未测量。'
export const evidenceScopeChanged = (previous, next) => previous.inputRevision !== next.inputRevision
  || previous.node?.snapshotShortId !== next.node?.snapshotShortId
  || ['snapshot_invalid', 'permission_blocked'].includes(next.node?.status)
  || Boolean(previous.node?.result && previous.node.result.resultRevision !== next.node?.result?.resultRevision)
export const collectionBoundary = result => result.resultPagesExhausted ? '当前检索表达式已枚举完。' : '当前检索表达式未全部枚举。'
const candidateMethods = ['dual_description_margin', 'name_gmm', 'kmeans']
export const usesFeedbackLearning = execution => typeof execution?.onlineFeedbackTraining === 'boolean'
  ? execution.onlineFeedbackTraining : execution?.onlineLearning !== false && !['direct', 'direct_teacher', ...candidateMethods].includes(execution?.semanticMethod)
export const frozenMethodLabel = execution => ({ dual_description_margin: '双描述匹配', name_gmm: 'GMM 名称聚类', kmeans: 'KMeans 聚类' })[execution?.semanticMethod] ?? '固定判据逐条判断'
export const hasUnmeasuredCandidates = execution => candidateMethods.includes(execution?.semanticMethod)
export const executionDescription = execution => !execution ? '' : usesFeedbackLearning(execution)
  ? '本任务：在线学习（模型伪标签）' + (['single', 'selective'].includes(execution.onlineFusion) ? ' · ' + (execution.onlineFusion === 'selective' ? '二分类多数投票' : '最佳单模型') : '')
    + (execution.onlineModels?.length ? ' · ' + execution.onlineModels.length + ' 个候选模型' : '') + '。'
  : `本任务：${frozenMethodLabel(execution)}。`
export const hasFinalTeacherReference = q => q?.reference_basis === 'teacher' && q.used_for_selection === false && q.raw_before_label_override === true
  && Number.isSafeInteger(q.reference_records) && q.reference_records > 0
export const selectionReasonDescription = reason => ({ single_requested: '按本任务设置选择最佳单模型。',
  no_oof_diversity_gain: '训练组交叉拟合比较中，融合未优于单模型。', oof_diversity_gain: '训练组交叉拟合比较中，融合提升了教师一致性。',
  validated_same_cohort_snapshot_fallback: '复用经核验的同批训练结果。' })[reason] ?? '选择原因未记录。'
export const finalTeacherAgreementDescription = q => hasFinalTeacherReference(q)
  ? `最终留出集教师一致率 P/R：${qualityValue(q.precision)} / ${qualityValue(q.recall)}；未用于选模，使用教师标签回填前的预测。不是业务准确率或最终独立验收。`
  : '最终留出教师参考未验证。'


const learningStates = {
  unlabeled_scanning: '正在读取候选特征', unlabeled_fitting: '正在建立本任务固定判别', unlabeled_predicting: '正在生成候选判断',
  resuming_selection: '复用已有模型，继续补充选择样本', resuming_discovery: '复用已有抽样池，继续补充发现',
  scanning: '正在读取召回并集特征', ranked_sampling: '正在为召回并集排序样本', diversity_sampling: '正在进行 K-means++ 多样性采样', training: '正在训练候选模型',
  selecting: '正在比较模型', predicting: '正在预测', auditing: '正在抽样判断',
  sampling: '正在抽样判断', quality_passed: '模型选择完成', quality_not_met: '未完成：质量未达标',
  quality_fallback: '模型选择完成', model_unknown: '未完成：质量未达标',
  needs_coverage: '等待补充样本', needs_information: '等待工单证据', needs_selection_coverage: '等待选择样本',
}
export function retrievalSummary(snapshot) {
  const process = snapshot.orchestration?.retrieval
  const learning = process?.learning
  const result = snapshot.node?.result?.learnedSet
  const accepted = Boolean(result || learning?.resultAvailable), quality = result?.quality ?? learning?.quality
  const unmeasured = hasUnmeasuredCandidates(process?.execution) || learning?.qualityBasis === 'unmeasured'
  return { plan: process?.plan, execution: process?.execution, learning, accepted, quality, unmeasured,
    filterActivity: process?.filterActivity,
    status: process?.filterActivity === 'failed' ? '语义筛选失败'
      : learning?.status === 'model_unknown' ? unmeasured ? '算法判定已保存' : '未完成：质量未达标'
        : accepted ? '语义筛选已完成'
          : learningStates[learning?.status] ?? '准备语义筛选',
    method: !usesFeedbackLearning(process?.execution) ? frozenMethodLabel(process?.execution) : accepted ? '语义筛选结果' : '语义筛选',
  }
}

export function learningSteps(learning, failed = false) {
  const l = learning ?? {}, status = l.status
  const active = { scanning: 0, ranked_sampling: 1, diversity_sampling: 1, sampling: l.samplingPhase === 'model_threshold_selection' ? 3 : 1,
    resuming_selection: 3, resuming_discovery: 1,
    training: 2, selecting: 3, predicting: 4, auditing: 5 }[status]
  const done = [l.scopeCount > 0, l.sampledCount > 0, l.fitCount > 0, Boolean(l.selectedModel),
    l.predictedCount > 0 && l.predictedCount === l.scopeCount, Boolean(l.quality)]
  return ['读取召回并集特征', '样本排序与判断', '候选模型训练', l.quality?.basis === 'training_group_crossfit' ? '训练组交叉拟合与模型选择' : '模型与阈值选择', '召回并集预测', ...(l.auditCount > 0 || status === 'auditing' ? ['历史独立抽验'] : [])]
    .map((label, i) => ({ label, state: i === active ? failed ? 'failed' : 'active' : done[i] ? 'done' : 'pending' }))
}

function renderLearningDetails(learning, failed, execution) {
  if (!usesFeedbackLearning(execution)) {
    const unmeasured = hasUnmeasuredCandidates(execution), l = learning ?? {}
    return [el('p', `${frozenMethodLabel(execution)}；不使用教师伪标签训练分类器。`, 'muted'),
      ...(unmeasured ? [el('p', '直接交付该算法判定为相关的工单和 XLSX；质量未人工评测。', 'notice')] : []),
      ...(typeof l.fitCount === 'number' ? [el('p', `本任务拟合次数 ${l.fitCount}`, 'muted')] : []),
      el('p', `判断请求 ${l.samplingRequests ?? 0} 次；教师样本 ${l.sampledCount ?? 0} 条（最多排序前 128 条，自动重试另计）`, 'muted'), ...(failed ? [el('p', '执行中断', 'notice')] : [])]
  }
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
    for (const label of ['样本用途', '抽样总数', '有效标签', '执行未完成']) head.append(el('th', label))
    const thead = el('thead'); thead.append(head); table.append(thead)
    const body = el('tbody')
    for (const [label, part] of [['训练模型', allocation.training], ['选择模型与阈值', allocation.selection]]) {
      const row = el('tr'); for (const value of [label, part.total, part.labeled, part.unknown]) row.append(el('td', value)); body.append(row)
    }
    table.append(body); nodes.push(table)
  }
  nodes.push(el('p', `判断请求 ${l.samplingRequests ?? 0} 次；教师样本 ${l.sampledCount ?? 0} 条（最多排序前 128 条，自动重试另计）`, 'muted'))
  if (l.judgeMetrics) nodes.push(el('p', `实际判断：L0概率 ${l.judgeMetrics.l0_records ?? 0} 条，旋转概率 ${l.judgeMetrics.rotation_only_records ?? 0} 条，降级简洁判断 ${l.judgeMetrics.compact_fallback_records ?? 0} 条。`, 'muted'))
  if (failed) nodes.push(el('p', l.status ? '执行中断' : '筛选算子失败', 'notice'))
  if (l.precisionTarget && l.recallTarget) nodes.push(el('p', `${l.quality?.basis === 'training_group_crossfit' ? '训练组交叉拟合教师一致率目标' : '模型选择集目标'}：查准率 ≥ ${qualityValue(l.precisionTarget)}，召回率 ≥ ${qualityValue(l.recallTarget)}。`, 'muted'))
  if (l.quality?.basis === 'training_group_crossfit') nodes.push(el('p', trainingCrossfitNote, 'muted'))
  if (Number.isSafeInteger(l.crossfitFolds) && l.crossfitFolds > 0) nodes.push(el('p', `训练组交叉拟合：${l.crossfitFolds} 折`, 'muted'))
  if (typeof l.selectedEnsemble === 'boolean') nodes.push(el('p', '入选方案：' + (l.selectedEnsemble ? '模型融合' : '单模型')))
  if (l.selectionReason) nodes.push(el('p', selectionReasonDescription(l.selectionReason), 'muted'))
  if (l.selectedMembers?.length) nodes.push(el('p', `入选成员：${l.selectedMembers.join('、')}`))
  if (l.singleBaseline?.name) nodes.push(el('p', `单模型基线：${l.singleBaseline.name} · 训练组交叉拟合教师一致率 P/R ${qualityValue(l.singleBaseline.precision)} / ${qualityValue(l.singleBaseline.recall)}`, 'muted'))
  if (l.finalTeacherAgreement) {
    const reference = l.finalTeacherAgreement
    nodes.push(el('p', finalTeacherAgreementDescription(reference), 'muted'))
    if (hasFinalTeacherReference(reference)) nodes.push(el('p', `最终留出集：教师参考 ${reference.reference_records} 条 · 一致率 ${qualityValue(reference.agreement)} · 覆盖率 ${qualityValue(reference.coverage)} · F1 ${qualityValue(reference.f1)}`, 'muted'))
  }
  if (l.selectedModel) nodes.push(el('p', `入选模型：${l.selectedModel} · 阈值 ${typeof l.threshold === 'number' && Number.isFinite(l.threshold) ? l.threshold.toPrecision(4) : '未记录'}`))
  if (l.models?.length) {
    const table = el('table', '', 'model-comparison'), head = el('tr')
    for (const label of ['候选模型', ...(l.quality?.basis === 'training_group_crossfit' ? ['交叉拟合教师查准率', '交叉拟合教师召回率'] : ['选择集查准率', '选择集召回率']), '选用']) head.append(el('th', label))
    const thead = el('thead'); thead.append(head); table.append(thead)
    const body = el('tbody')
    for (const m of l.models) { const row = el('tr'), selected = l.selectedMembers?.includes(m.name) ?? m.name === l.selectedModel; row.dataset.selected = String(selected)
      for (const value of [m.name, qualityValue(m.precision), qualityValue(m.recall), selected ? '✓' : '—']) row.append(el('td', value)); body.append(row) }
    table.append(body); nodes.push(table)
  }
  return nodes
}

function qualityGrid(quality) {
  const grid = el('div', '', 'quality-grid')
  if (quality.basis != null && !['selection', 'training_group_crossfit', 'independent_audit'].includes(quality.basis)) {
    grid.append(el('p', '质量参考未测量。', 'muted quality-reference')); return grid
  }
  const metrics = quality.basis === 'training_group_crossfit'
    ? [['交叉拟合教师查准率', 'precision', 'precision_target'], ['交叉拟合教师召回率', 'recall', 'recall_target']]
    : quality.basis === 'selection'
    ? [['选择集查准率', 'precision', 'precision_target'], ['选择集召回率', 'recall', 'recall_target']]
    : [['历史查准率下界', 'precision_lower', 'precision_target'], ['历史召回率下界', 'recall_lower', 'recall_target']]
  for (const [name, key, target] of metrics) {
    const item = el('div')
    item.append(el('span', name), el('strong', qualityValue(quality[key])), el('small', '目标 ' + qualityValue(quality[target])))
    grid.append(item)
  }
  if (quality.basis === 'training_group_crossfit') grid.append(el('p', trainingCrossfitNote, 'muted quality-reference'))
  return grid
}

/** 本轮快照替换判据、召回与学习摘要；修订后不延用上一轮的质量结论。 */
export function renderRetrieval(snapshot, { openKnowledge, showKnowledge } = {}) {
  const summary = retrievalSummary(snapshot), { plan, learning, quality, execution } = summary
  $('execution-mode').hidden = !execution
  $('execution-mode').textContent = executionDescription(execution)
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
    $('learning-stages').replaceChildren(...renderLearningDetails(learning, summary.filterActivity === 'failed', execution))
    const metrics = !usesFeedbackLearning(execution) ? [['召回并集工单数', learning?.scopeCount], ...(summary.unmeasured ? [['判断为相关', learning?.positiveCount], ['判断为不相关', learning?.negativeCount], ['执行未完成', learning?.unresolvedCount]] : []), ['独立判断请求', learning?.samplingRequests]]
      : [['召回并集工单数', learning?.scopeCount], ['抽样工单总数', learning?.sampledCount], ['训练有效标签', learning?.trainingCount], ['已预测', learning?.predictedCount], ...(quality?.basis === 'training_group_crossfit' ? [] : [['选择集总数（含待处理）', learning?.selectionCount]]), ...(Number.isSafeInteger(learning?.finalHoldoutCount) ? [['最终留出集工单数', learning.finalHoldoutCount]] : []), ...(learning?.auditCount > 0 ? [['历史抽验', learning.auditCount]] : [])]
    $('learning-metrics').replaceChildren(...metrics.map(([label, value]) => {
      const metric = el('div'); metric.append(el('strong', Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—'), el('span', label)); return metric
    }))
    $('learning-quality').replaceChildren(...(quality && usesFeedbackLearning(execution) ? [qualityGrid(quality)] : [el('p', !usesFeedbackLearning(execution) ? summary.unmeasured ? '质量未人工评测；当前结果是所选算法判定为相关的工单。' : '逐条判断，不显示训练选择集指标。' : '正在评估模型', 'muted')]))
    if (learning?.knowledgeEntryCount && showKnowledge) { const link = el('button', '查看领域判断与知识引用 ↗', 'link'); link.type = 'button'; link.onclick = showKnowledge; $('learning-quality').append(link) }
  }
  const method = $('result-method')
  const methodKey = JSON.stringify([summary.accepted, quality, execution])
  // 无关进度刷新不重建质量说明，保留用户的展开状态与键盘焦点。
  if (method.dataset.key === methodKey) return
  method.dataset.key = methodKey
  method.hidden = !summary.accepted
  method.replaceChildren()
  if (summary.accepted) {
    method.append(el('strong', summary.method))
    if (quality && usesFeedbackLearning(execution)) {
      const details = el('details', '', 'method-quality')
      details.append(el('summary', quality.basis === 'training_group_crossfit' ? '查看训练组交叉拟合教师一致率' : quality.basis === 'selection' ? '查看选择集指标' : quality.basis == null || quality.basis === 'independent_audit' ? '查看历史抽验指标' : '查看质量参考'), qualityGrid(quality))
      method.append(details)
    }
  }
}
