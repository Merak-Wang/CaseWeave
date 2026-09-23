/** 阶段由真实检索和报告状态推导；完成后仍保留每步的过程入口。 */
export function workflowSteps(snapshot, reportStatus = 'pending') {
  const o = snapshot.orchestration, result = snapshot.node?.result, learning = o?.retrieval?.learning
  const unavailable = Boolean(snapshot.failure) || ['error', 'permission_blocked', 'snapshot_invalid'].includes(snapshot.node?.status)
  const review = ['review', 'experts', 'synthesis'].includes(o?.stage)
  const recalled = o?.fastQueryComplete || snapshot.node?.searchProgress?.channels.some(c => c.status === 'completed')
  const filtered = Boolean(result) && o?.outcome !== 'cancelled' && o?.retrieval?.filterActivity !== 'failed'
  const reportState = !result || unavailable ? 'upcoming' : reportStatus === 'ready' ? 'done'
    : ['queued', 'running'].includes(reportStatus) ? 'active' : reportStatus === 'failed' ? 'failed' : 'upcoming'
  return [
    { key: 'search', label: '线索召回', view: 'process', target: 'plan-heading',
      state: recalled ? 'done' : o?.terminal || unavailable ? 'stopped' : 'active', note: '判据与召回记录' },
    { key: 'review', label: '语义筛选', view: 'process', target: learning ? 'learning-progress' : 'activity-log',
      state: o?.retrieval?.filterActivity === 'failed' ? 'failed' : filtered ? 'done' : o?.terminal || unavailable ? 'stopped' : review ? 'active' : 'upcoming',
      note: '抽样、领域判断与选模' },
    { key: 'report', label: '检索报告', view: 'report', state: reportState,
      note: reportState === 'done' ? '已生成 · 查看报告' : reportState === 'active' ? '正在整理确认结果' : reportState === 'failed' ? '生成失败 · 可重试' : result ? '可生成报告' : '筛选结束后生成' },
  ]
}

/** 训练数是有效标签，选择数包含未决；展开两侧同口径的数量关系。 */
export function sampleAllocation(learning) {
  const q = learning?.quality
  if (q?.basis !== 'selection' || ![q.selection_unknown, learning.unresolvedCount, learning.trainingCount, learning.selectionCount].every(n => typeof n === 'number')) return
  const trainingUnknown = learning.unresolvedCount - q.selection_unknown
  return {
    training: { total: learning.trainingCount + trainingUnknown, labeled: learning.trainingCount, unknown: trainingUnknown },
    selection: { total: learning.selectionCount, labeled: learning.selectionCount - q.selection_unknown, unknown: q.selection_unknown },
  }
}
