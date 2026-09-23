const $ = id => document.getElementById(id)
const count = value => value.toLocaleString()
const reasonNames = { working_set: '工作集达到整理阈值', window_pressure: '完整请求接近模型窗口', provider_overflow: '供应商返回上下文容量错误' }
const operationNames = { query_plan: '检索规划', sem_filter: '样本判断', sem_agg: '证据汇总', sem_extract: '事实提取' }

/** 当前窗口与累计消耗分开显示；压缩后的估算优先于压缩前的供应商回执。 */
export function runtimeMetricsText(context, usage) {
  const tokens = context?.projectedInputTokens ?? context?.measuredInputTokens ?? context?.estimatedInputTokens
  const percent = context?.limit && tokens !== undefined ? Math.round(tokens / context.limit * 100) : undefined
  const label = percent === undefined ? tokens === undefined ? '待测量' : '约 ' + count(tokens) : percent + '%'
  const stats = context?.compression, last = stats?.last
  const compression = stats ? `工作上下文整理 ${stats.workingSetCount} 次 · 容量重建 ${stats.capacityCount} 次\nDSH 历史压缩 ${stats.dshCount ?? 0} 次${stats.dshActive ? ' · 正在压缩' : ''}${stats.dshFailures ? ' · 未完成 ' + stats.dshFailures + ' 次' : ''}`
    : `历史整理/压缩 ${context?.compactionCount ?? 0} 次（旧记录未区分原因）`
  const trigger = last ? `\n最近一次重建：${reasonNames[last.reason]}；触发前约 ${count(last.beforeTokens)} tokens${last.reason === 'provider_overflow' ? '' : '，阈值 ' + count(last.thresholdTokens)}。` : ''
  const amount = tokens === undefined ? '上下文用量将在第一次模型请求后显示。'
    : `${context?.projectedInputTokens !== undefined ? '下一次请求预计输入' : context?.measuredInputTokens === undefined ? '估算输入' : '实际输入'} ${count(tokens)} tokens${context?.limit ? ' / 窗口 ' + count(context.limit) + '（' + percent + '%）' : '；模型窗口未知'}`
  const breakdown = context?.breakdown
  const composition = breakdown ? `\n组成估算：系统 ${count(breakdown.systemTokens)} · 工具 ${count(breakdown.toolsTokens)} · 会话 ${count(breakdown.messageTokens)} tokens（与供应商计量口径不同，不作为占用总和）` : ''
  const description = context?.source === 'operator'
    ? `最近一次语义算子请求：${operationNames[context.operation] ?? context.operation}${context.model ? ' · ' + context.model : ''}\n${amount}\n算子按批次独立请求，此处显示单次窗口占用；累计用量见输出统计。`
    : `${amount}${context?.projectedInputTokens !== undefined && context.measuredInputTokens !== undefined ? '\n上次请求实际输入 ' + count(context.measuredInputTokens) + ' tokens' : ''}${context?.reservedTokens === undefined ? '' : '\n输出及协议预留 ' + count(context.reservedTokens) + ' tokens'}${composition}\n${compression}${trigger}\n工作集整理不表示模型窗口已满。原始轨迹与来源保留。`
  if (!usage) return { percent, label, description, outputLabel: '输出待计量', usageDescription: '收到模型用量回执后更新。' }
  const speed = usage.speed?.tokensPerSecond
  const timing = `生成速度：${speed == null ? '待计量' : speed.toFixed(1) + ' tokens/s'}\n平均首 token：${usage.speed?.firstTokenMs == null ? '待计量' : (usage.speed.firstTokenMs / 1000).toFixed(2) + ' 秒'}`
  const buckets = usage.mainTokenUsage
  const cache = buckets ? `\n主 Agent 输入明细：未缓存 ${count(buckets.uncachedInputTokens)} · 缓存读取 ${count(buckets.cacheReadTokens)} · 缓存写入 ${count(buckets.cacheWriteTokens)} tokens` : ''
  const usageDescription = `累计输出 ${count(usage.outputTokens)} tokens\n主 Agent：${count(usage.mainOutputTokens)}\n专家合计：${count(usage.expertOutputTokens)}\n语义算子：${count(usage.operatorOutputTokens ?? 0)}\n累计输入：${usage.inputTokens == null ? '回执不完整' : count(usage.inputTokens) + ' tokens'}${cache}\n${timing}\n时间统计覆盖 ${usage.speed?.measuredSteps ?? 0} 个已结束模型步骤，${usage.speed?.timedSteps ?? 0} 个有首 token 时间。速度按有输出回执的解码时间计算，并行请求耗时相加；历史缺失值不按零速度补齐。\n模型请求：${usage.modelRequests} 次（整个任务累计）\n主 Agent ${usage.mainRequests ?? '—'} 次 · 专家 ${usage.expertRequests ?? '—'} 次 · 语义算子 ${usage.operatorRequests ?? '—'} 次\n`
    + Object.entries(usage.operatorUsage?.calls_by_operation ?? {}).map(([op, n]) => `${operationNames[op] ?? op}：${n} 次`).join('\n')
    + '\n样本排序、分类模型训练与全集预测在 Python 本地执行，不调用大模型。\n'
    + usage.experts.map(e => `${e.title}（第 ${e.inputGeneration + 1} 轮）：${count(e.outputTokens)}`).join('\n')
  return { percent, label, description, outputLabel: `输出 ${count(usage.outputTokens)} tokens${speed == null ? '' : ' · ' + speed.toFixed(1) + ' tokens/s'}`, usageDescription }
}

export function renderRuntimeMetrics(context, usage) {
  const view = runtimeMetricsText(context, usage), meter = $('context-meter')
  $('context-label').textContent = view.label
  $('context-fill').setAttribute('stroke-dasharray', `${Math.min(100, view.percent ?? 0) * 56.55 / 100} 56.55`)
  meter.dataset.pressure = view.percent >= 80 ? 'high' : 'normal'
  meter.title = view.description; meter.setAttribute('aria-label', view.description)
  $('context-description').textContent = view.description
  $('output-usage').textContent = view.outputLabel
  $('usage-description').textContent = view.usageDescription
}

export function bindRuntimeMetrics() {
  $('context-meter').onclick = () => $('context-dialog').showModal()
  $('context-close').onclick = () => $('context-dialog').close()
  $('output-usage').onclick = () => $('usage-dialog').showModal()
  $('usage-close').onclick = () => $('usage-dialog').close()
}
