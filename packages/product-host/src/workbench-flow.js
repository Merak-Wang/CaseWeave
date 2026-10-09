/** 阶段由真实检索和报告状态推导；完成后仍保留每步的过程入口。 */
export function workflowSteps(snapshot, reportStatus = 'pending') {
  const o = snapshot.orchestration, result = snapshot.node?.result, learning = o?.retrieval?.learning
  const unavailable = Boolean(snapshot.failure) || ['error', 'permission_blocked', 'snapshot_invalid'].includes(snapshot.node?.status)
  const review = ['review', 'experts', 'synthesis'].includes(o?.stage)
  const execution = o?.retrieval?.execution
  const frozen = typeof execution?.onlineFeedbackTraining === 'boolean' ? !execution.onlineFeedbackTraining
    : execution?.onlineLearning === false || ['direct', 'direct_teacher', 'dual_description_margin', 'name_gmm', 'kmeans'].includes(execution?.semanticMethod)
  const recalled = o?.fastQueryComplete || snapshot.node?.searchProgress?.channels.some(c => c.status === 'completed')
  const filtered = Boolean(result) && o?.outcome !== 'cancelled' && o?.retrieval?.filterActivity !== 'failed'
  const reportState = !result || unavailable ? 'upcoming' : reportStatus === 'ready' ? 'done'
    : ['queued', 'running'].includes(reportStatus) ? 'active' : reportStatus === 'failed' ? 'failed' : 'upcoming'
  if (execution?.orchestration === 'fixed') {
    const planned = Boolean(o.retrieval.plan)
    return [
      { key: 'plan', label: '意图理解', view: 'process', target: 'plan-heading', state: planned ? 'done' : unavailable ? 'failed' : 'active', note: '一次模型调用产生检索计划' },
      { key: 'recall', label: '检索与排序', view: 'process', target: 'recall-channels', state: recalled ? 'done' : unavailable ? 'failed' : planned ? 'active' : 'upcoming', note: '关键词 OR 与向量并集排序' },
      { key: 'judge', label: frozen ? '无反馈判断' : '在线学习', view: 'process', target: 'learning-progress', state: unavailable ? 'failed' : filtered ? 'done' : recalled ? 'active' : 'upcoming', note: frozen ? '所选算法直接判断' : '排序前 128 条伪标签训练与投票' },
      { key: 'result', label: '返回结果', view: 'results', state: unavailable ? 'failed' : filtered ? 'done' : 'upcoming', note: '模型是集合与 XLSX' },
    ]
  }
  return [
    { key: 'search', label: '线索召回', view: 'process', target: 'plan-heading',
      state: recalled ? 'done' : o?.terminal || unavailable ? 'stopped' : 'active', note: '判据与召回记录' },
    { key: 'review', label: '语义筛选', view: 'process', target: learning ? 'learning-progress' : 'activity-log',
      state: o?.retrieval?.filterActivity === 'failed' ? 'failed' : filtered ? 'done' : o?.terminal || unavailable ? 'stopped' : review ? 'active' : 'upcoming',
      note: frozen ? ['dual_description_margin', 'name_gmm', 'kmeans'].includes(execution?.semanticMethod) ? '固定判别 · 未测量候选' : '固定判据逐条判断' : execution?.onlineFusion === 'selective' ? '抽样、领域判断与融合选择' : '抽样、领域判断与选模' },
    { key: 'report', label: '检索报告', view: 'report', state: reportState,
      note: reportState === 'done' ? '已生成 · 查看报告' : reportState === 'active' ? '正在整理确认结果' : reportState === 'failed' ? '生成失败 · 可重试' : result ? '可生成报告' : '筛选结束后生成' },
  ]
}

/** 训练数是有效标签，选择数包含执行未完成样本；展开两侧同口径的数量关系。 */
export function sampleAllocation(learning) {
  const q = learning?.quality
  if (q?.basis !== 'selection' || ![q.selection_unknown, learning.unresolvedCount, learning.trainingCount, learning.selectionCount].every(n => Number.isSafeInteger(n) && n >= 0) || q.selection_unknown > learning.unresolvedCount || q.selection_unknown > learning.selectionCount) return
  const trainingUnknown = learning.unresolvedCount - q.selection_unknown
  if (!Number.isSafeInteger(learning.trainingCount + trainingUnknown)) return
  return {
    training: { total: learning.trainingCount + trainingUnknown, labeled: learning.trainingCount, unknown: trainingUnknown },
    selection: { total: learning.selectionCount, labeled: learning.selectionCount - q.selection_unknown, unknown: q.selection_unknown },
  }
}
