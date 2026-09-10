import type { RetrievalDecision, RetrievalState } from '@retrieval-agent/contracts'
import type { MySqlTaskStore } from '@retrieval-agent/agent-plugin'

export interface ActivityItem { id: string; seq: number; actor: string; kind: string; text: string; at?: string }
interface Row { seq: number; kind: string; at: string; command: { kind: string; text?: string } | null;
  action: RetrievalDecision['action'] | null; channels: { channel: string; resultCount: number }[] | null;
  operations: { path: string; value?: unknown }[] | null; reason: string | null }

/** Project only committed public actions. Original expert work remains readable across input generations. */
export function activityItems(rows: Row[], state: RetrievalState): ActivityItem[] {
  return rows.flatMap(row => {
    const item = (suffix: string, actor: string, kind: string, text: string): ActivityItem => ({ id: `${row.seq}:${suffix}`, seq: row.seq, actor, kind, text, at: row.at })
    if (row.command) return [item('user', '你', 'user', row.command.text ?? '停止检索')]
    if (row.action) {
      const a = row.action
      const text = a.kind === 'delegate' ? `分派 ${a.assignments.length} 项专项核查：${a.assignments.map(x => x.goal).join('；')}`
        : a.kind === 'inspect' ? `读取${a.candidateRefs?.length ? ` ${a.candidateRefs.length} 条工单` : '下一组'}依据`
          : a.kind === 'clarify' ? a.question : a.kind === 'finish' ? a.explanation
            : a.continueRanking ? '继续获取检索结果下一页' : a.delta?.kind === 'rewrite_semantic_query' ? `补充语义搜索：${a.delta.text}` : '按更新的关键词或条件补充检索'
      return [item('main', '主检索 Agent', a.kind, text)]
    }
    if (row.channels) return row.channels.map((c, i) => item(`search-${i}`, c.channel === 'keyword' ? '关键词检索' : '语义检索', 'search', `找到 ${c.resultCount} 条线索`))
    if (row.operations) {
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
      return [...updates].flatMap(([key, u]) => {
        const task = u.index === undefined ? state.expertTasks?.find(t => t.id === u.id) : state.expertTasks?.[u.index]
        const domain = task?.domainId ?? u.domainId
        const actor = (state.knowledgeCatalog?.domains.find(d => d.id === domain)?.description ?? domain ?? '领域') + '专家'
        const text = u.status === 'superseded' ? '用户补充后，本轮发现保留供追溯；按新要求重新复核'
          : u.status === 'completed' ? '已提交核查发现，交由主 Agent 综合'
            : u.status === 'failed' ? '专项核查未完成，已保留取得的依据'
              : u.kind === 'search' ? '补充搜索' + (u.query ? `：${u.query}` : '')
                : u.kind === 'inspect' ? '正在核对工单原文' : u.kind === 'report' ? '正在整理核查发现' : u.kind === 'starting' ? '正在阅读领域知识' : undefined
        return text ? [item(`expert-${key}`, actor, u.status === 'completed' ? 'finding' : u.kind ?? 'action', text)] : []
      })
    }
    if (row.reason) return [item('stopped', '检索助手', 'finish', row.reason === 'cancelled' ? '已按用户要求停止，结果与轨迹已保留' : ['top_k_accepted', 'no_result'].includes(row.reason) ? '本轮检索已完成' : '本轮暂停，保留已有结果与未完成记录')]
    return []
  })
}

export async function readActivity(store: MySqlTaskStore, id: string, state: RetrievalState, after: number) {
  const rows = await store.rows<Row>(`SELECT e.seq,e.kind,JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.occurredAt')) AS at,
    JSON_EXTRACT(e.data_json,'$.command') AS command,
    JSON_EXTRACT(e.data_json,'$.data.decision.action') AS action,
    JSON_EXTRACT(e.data_json,'$.data.page.trace.channels') AS channels,
    JSON_UNQUOTE(JSON_EXTRACT(e.data_json,'$.data.reason')) AS reason,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('path',o.path,'value',o.value)) FROM JSON_TABLE(e.data_json,'$.data.patch.operations[*]'
      COLUMNS (path VARCHAR(191) PATH '$.path', value JSON PATH '$.value')) o
      WHERE o.path REGEXP '^/expertTasks(/-|/[0-9]+/(activity(/(kind|query)){0,1}|status)){0,1}$') AS operations
    FROM ra_task_event e WHERE e.task_id=? AND e.seq>? AND
      (e.kind IN ('command/accepted','retrieval/decision-submitted','retrieval/search-completed','retrieval/stopped')
       OR (e.kind='retrieval/state-patched' AND EXISTS (SELECT 1 FROM JSON_TABLE(e.data_json,'$.data.patch.operations[*]'
         COLUMNS (path VARCHAR(191) PATH '$.path')) p WHERE p.path REGEXP '^/expertTasks(/-|/[0-9]+/(activity(/(kind|query)){0,1}|status)){0,1}$')))
    ORDER BY e.seq LIMIT 101`, [id, after])
  const page = rows.slice(0, 100)
  return { items: activityItems(page, state), after: page.at(-1)?.seq ?? after, more: rows.length > 100 }
}
