import type { RetrievalDecision, RetrievalState } from '@retrieval-agent/contracts'
import type { MySqlTaskStore } from '@retrieval-agent/agent-plugin'

export interface ActivityItem { id: string; seq: number; actor: string; kind: string; text: string; at?: string; records?: number }
interface Row { seq: number; kind: string; at: string; command: { kind: string; text?: string } | null;
  action: RetrievalDecision['action'] | null; channels: { channel: string; resultCount: number }[] | null;
  operations: { path: string; value?: unknown }[] | null; reason: string | null;
  searchSeq?: number; searchStage?: string; fingerprint?: string; loaded?: number; exhausted?: boolean; previewOnly?: boolean; operationName?: string; failure?: string;
  decisionOrigin?: string; operatorManifestId?: string; judgmentCount?: number }

const operatorNames: Record<string, string> = { query_plan: '检索规划', sem_search: '补充召回', sem_filter: '语义筛选', sem_extract: '事实提取', sem_agg: '证据汇总' }
const learningNames: Record<string, string> = { scanning: '读取全范围数值特征', diversity_sampling: '使用 K-means++ 选择多样性样本',
  ranked_sampling: '按原句 n-gram 与向量相似度排序样本',
  resuming_selection: '复用已训练模型，继续补充独立选择样本', resuming_discovery: '复用已有抽样池和标签，继续补充发现',
  sampling: '语言模型判断真实样本', training: '训练候选分类模型', selecting: '比较模型并选择阈值', predicting: '使用入选模型分块预测全范围',
  auditing: '历史独立抽验', quality_passed: '全集预测完成', quality_not_met: '模型选择已完成',
  quality_fallback: '全集预测完成', model_unknown: '筛选已停止',
  needs_coverage: '样本类别覆盖不足，需补充发现', needs_information: '样本证据不足', needs_selection_coverage: '模型选择样本覆盖不足' }

/** Project only committed public actions. Original expert work remains readable across input generations. */
export function activityItems(rows: Row[], state: RetrievalState): ActivityItem[] {
  const items = rows.flatMap(row => {
    const item = (suffix: string, actor: string, kind: string, text: string): ActivityItem => ({ id: `${row.seq}:${suffix}`, seq: row.seq, actor, kind, text, at: row.at })
    if (row.command) return [item('user', '你', 'user', row.command.text ?? (row.command.kind === 'resume' ? '恢复检索' : '停止检索'))]
    if (row.action) {
      const a = row.action
      // 算子判断提交复用了 inspect 事件；新记录带来源，旧记录依据算子清单识别。
      if (row.decisionOrigin === 'semantic_operator' || row.operatorManifestId && a.kind === 'inspect' && !a.fields?.length && !a.candidateRefs?.length) {
        return [{ ...item('judgments', '语义筛选', 'judgment', `已写入 ${row.judgmentCount ?? 0} 条样本判断`), records: row.judgmentCount ?? 0 }]
      }
      const text = a.kind === 'delegate' ? `分派 ${a.assignments.length} 项专项核查：${a.assignments.map(x => x.goal).join('；')}`
        : a.kind === 'inspect' ? `读取${a.candidateRefs?.length ? ` ${a.candidateRefs.length} 条工单` : '下一组'}依据`
          : a.kind === 'clarify' ? a.question : a.kind === 'finish' ? '结束本轮检索'
            : a.continueRanking ? '继续获取检索结果下一页' : a.delta?.kind === 'rewrite_semantic_query' ? `补充语义搜索：${a.delta.text}` : '按更新的关键词或条件补充检索'
      return [item('main', '主检索 Agent', a.kind, text)]
    }
    if (row.channels) return row.channels.map(c => ({
      ...item('search', c.channel === 'keyword' ? '关键词检索' : '语义检索', 'search',
        `命中 ${c.resultCount} 条线索${row.previewOnly ? ' · 命中集合已建立，正文按抽样需要读取' : `${row.channels!.length === 1 && typeof row.loaded === 'number' ? ` · 已读取 ${row.loaded} 条` : ''} · ${row.exhausted ? '本次表达式枚举完成' : '正在读取结果'}`}`),
      // 同一次搜索的分页覆盖原卡片；不同检索表达式、重跑仍保留独立记录。
      id: `search:${row.searchSeq ?? row.seq}:${c.channel}`,
    }))
    if (row.failure) return [item('failure', '执行失败', 'error', row.failure)]
    if (row.operations) {
      const milestones: ActivityItem[] = []
      const values = new Map(row.operations.map(o => [o.path, o.value]))
      const activity = values.get('/operatorActivity') as { operation?: string; status?: string } | undefined
      const status = activity?.status ?? values.get('/operatorActivity/status')
      const operation = activity?.operation ?? row.operationName
      if (status) milestones.push(item('operator', '语义算子', status === 'failed' ? 'error' : 'operator',
        `${operatorNames[operation ?? ''] ?? '算子'}${status === 'running' ? '开始执行' : status === 'failed' ? '未完成，后续阶段尚未执行' : '执行完成'}`))
      const usage = values.get('/budget/operatorUsage') as { learning?: Record<string, unknown> } | undefined
      const learning = (values.get('/budget/operatorUsage/learning') ?? usage?.learning) as Record<string, unknown> | undefined
      const phase = learning?.stop_reason ?? values.get('/budget/operatorUsage/learning/stop_reason')
      const selected = learning?.selected_model ?? values.get('/budget/operatorUsage/learning/selected_model')
      if (phase && learningNames[String(phase)]) milestones.push(item('learning', '学习式筛选', 'learning', learningNames[String(phase)]!))
      if (selected) milestones.push(item('model', '模型选择', 'learning', `入选分类模型：${selected}；经验指标见模型选择集`))
      const updates = new Map<string, { index?: number; kind?: string; status?: string; query?: string; id?: string; domainId?: string }>()
      const addTask = (t: unknown) => {
        if (!t || typeof t !== 'object') return
        const task = t as { id?: string; domainId?: string; status?: string }
        if (task.id) updates.set(task.id, { ...task, kind: 'starting' })
      }
      for (const op of row.operations) {
        if (op.path === '/expertTasks' && Array.isArray(op.value)) { op.value.forEach(addTask); continue }
        if (op.path === '/expertTasks/-') { addTask(op.value); continue }
        const match = /^\/expertTasks\/(\d+)\/(activity(?:\/(?:kind|query))?|status)$/u.exec(op.path)
        if (!match) continue
        const index = Number(match[1]), update = updates.get(match[1]!) ?? { index }
        if (match[2] === 'activity' && op.value && typeof op.value === 'object') Object.assign(update, op.value)
        else if (match[2] === 'activity/kind') update.kind = String(op.value)
        else if (match[2] === 'activity/query') update.query = String(op.value)
        else if (match[2] === 'status') update.status = String(op.value)
        updates.set(match[1]!, update)
      }
      return [...milestones, ...[...updates].flatMap(([key, u]) => {
        const task = u.index === undefined ? state.expertTasks?.find(t => t.id === u.id) : state.expertTasks?.[u.index]
        const domain = task?.domainId ?? u.domainId
        const actor = (state.knowledgeCatalog?.domains.find(d => d.id === domain)?.description ?? domain ?? '领域') + '专家'
        const text = u.status === 'superseded' ? '用户补充后，本轮发现保留供追溯；按新要求重新复核'
          : u.status === 'completed' ? '已提交核查发现，交由主 Agent 综合'
            : u.status === 'failed' ? '专项核查未完成，已保留取得的依据'
              : u.kind === 'search' ? '补充搜索' + (u.query ? `：${u.query}` : '')
                : u.kind === 'inspect' ? '正在核对工单原文' : u.kind === 'report' ? '正在整理核查发现' : u.kind === 'starting' ? '正在阅读领域知识' : undefined
        return text ? [item(`expert-${key}`, actor, u.status === 'completed' ? 'finding' : u.kind ?? 'action', text)] : []
      })]
    }
    if (row.reason) return [item('stopped', '检索助手', 'finish', row.reason === 'cancelled' ? '已按用户要求停止，结果与轨迹已保留' : ['top_k_accepted', 'no_result'].includes(row.reason) ? '本轮检索已完成' : '本轮暂停，保留已有结果与未完成记录')]
    return []
  })
  return [...new Map(items.map(item => [item.id, item])).values()]
}

const activityPaths = '^/(expertTasks(/-|/[0-9]+/(activity(/(kind|query)){0,1}|status)){0,1}|operatorActivity(/(operation|status)){0,1}|budget/operatorUsage(/learning(/(stop_reason|sampling_phase|selected_model)){0,1}){0,1})$'
export async function readActivity(store: MySqlTaskStore, id: string, state: RetrievalState, after: number) {
  const rows = await store.rows<Row>(`SELECT e.seq,e.kind,JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.occurredAt')) AS at,
    JSON_EXTRACT(e.data_json,'$.command') AS command,
    JSON_EXTRACT(e.data_json,'$.data.decision.action') AS action,
    JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.data.origin')) AS decisionOrigin,
    JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.data.decision.judgments[0].operatorManifestId')) AS operatorManifestId,
    JSON_LENGTH(JSON_EXTRACT(e.data_json,'$.data.decision.judgments')) AS judgmentCount,
    JSON_EXTRACT(e.data_json,'$.data.page.trace.channels') AS channels,
    JSON_EXTRACT(e.data_json,'$.data.page.trace.signals[last].finalRank') AS loaded,
    JSON_EXTRACT(e.data_json,'$.data.page.boundary.resultPagesExhausted') AS exhausted,
    JSON_EXTRACT(e.data_json,'$.data.previewOnly') AS previewOnly,
    JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.data.page.trace.stage')) AS searchStage,
    JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.data.page.queryFingerprint')) AS fingerprint,
    CASE WHEN e.kind='job/failed' THEN JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.error')) END AS failure,
    JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.data.reason')) AS reason,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('path',o.path,'value',o.value)) FROM JSON_TABLE(e.data_json,'$.data.patch.operations[*]'
      COLUMNS (path VARCHAR(191) PATH '$.path', value JSON PATH '$.value')) o
      WHERE o.path REGEXP '${activityPaths}') AS operations
    FROM ra_task_event e WHERE e.task_id=? AND e.seq>? AND
      (e.kind IN ('command/accepted','retrieval/decision-submitted','retrieval/search-completed','retrieval/stopped','job/failed')
       OR (e.kind='retrieval/state-patched' AND EXISTS (SELECT 1 FROM JSON_TABLE(e.data_json,'$.data.patch.operations[*]'
         COLUMNS (path VARCHAR(191) PATH '$.path')) p WHERE p.path REGEXP '${activityPaths}')))
    ORDER BY e.seq LIMIT 101`, [id, after])
  const page = rows.slice(0, 100)
  // 普通进度批次不回扫整段历史；只有分页或缺少名称的状态变更才补读归属。
  const searches = page.some(row => row.searchStage === 'next_page') ? await store.rows<{ seq: number; fingerprint: string }>(`SELECT seq,
    JSON_UNQUOTE(JSON_EXTRACT(data_json,'$.data.page.queryFingerprint')) AS fingerprint
    FROM ra_task_event WHERE task_id=? AND seq<=? AND kind='retrieval/search-completed'
      AND JSON_UNQUOTE(JSON_EXTRACT(data_json,'$.data.page.trace.stage'))<>'next_page'`, [id, page.at(-1)?.seq ?? after]) : []
  // 只读取很小的算子名称变更列，在内存排序；不要让 MySQL 对含大状态补丁的 JSON 行排序。
  const operations = page.some(row => row.operations?.some(op => op.path === '/operatorActivity/status'))
    ? await store.rows<{ seq: number; name: string }>(`SELECT e.seq,
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.value,'$.operation')),JSON_UNQUOTE(o.value)) AS name
    FROM ra_task_event e, JSON_TABLE(e.data_json,'$.data.patch.operations[*]'
      COLUMNS (path VARCHAR(191) PATH '$.path', value JSON PATH '$.value')) o
    WHERE e.task_id=? AND e.seq<=? AND e.kind='retrieval/state-patched'
      AND o.path IN ('/operatorActivity','/operatorActivity/operation')`, [id, page.at(-1)?.seq ?? after]) : []
  operations.sort((a, b) => a.seq - b.seq)
  let index = 0, name: string | undefined
  for (const row of page) {
    while (index < operations.length && operations[index]!.seq <= row.seq) name = operations[index++]!.name
    if (name) row.operationName = name
    row.searchSeq = row.searchStage === 'next_page'
      ? searches.filter(s => s.seq < row.seq && s.fingerprint === row.fingerprint).reduce((seq, s) => Math.max(seq, s.seq), 0) || row.seq
      : row.seq
  }
  return { items: activityItems(page, state), after: page.at(-1)?.seq ?? after, more: rows.length > 100 }
}
