import { useState, type CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TicketCandidateRef } from '@retrieval-agent/contracts'

export interface CandidatePanelInjected {
  readonly exportCandidates: (sessionId: string, retrievalId: string, refs: readonly TicketCandidateRef[]) => Promise<void>
}

export type CandidatePanelProps = PropsRuntime<'conversation.chat.node', 'ticket-candidates'> & CandidatePanelInjected

const panel: CSSProperties = { border: '1px solid var(--border-color, #d7dce2)', borderRadius: 10, padding: 12, display: 'grid', gap: 10 }
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }
const card: CSSProperties = { border: '1px solid var(--border-color, #d7dce2)', borderRadius: 8, padding: 10, display: 'grid', gap: 5 }
const metadata: CSSProperties = { color: 'var(--muted-color, #68717d)', fontSize: 12 }

/** Accessible deterministic rendering; no model-authored Markdown is interpreted. */
export function CandidatePanel({ node, sessionId, exportCandidates }: CandidatePanelProps) {
  const data = node.data
  const refs = data.candidates.map(candidate => candidate.ref)
  const [expanded, setExpanded] = useState<ReadonlySet<TicketCandidateRef>>(() => new Set())
  const [exportStatus, setExportStatus] = useState<'idle' | 'preparing' | 'success' | 'error'>('idle')
  const toggle = (ref: TicketCandidateRef): void => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      return next
    })
  }
  const exportCurrent = async (): Promise<void> => {
    setExportStatus('preparing')
    try {
      await exportCandidates(String(sessionId), data.retrievalId, refs)
      setExportStatus('success')
    } catch {
      setExportStatus('error')
    }
  }
  return (
    <section style={panel} aria-label="工单检索候选" data-retrieval-status={data.status}>
      <header>
        <strong>工单候选</strong>
        <div style={metadata}>查询：{data.querySummary || '—'} · 快照：{data.snapshotShortId ?? '准备中'} · 完整性：{data.completeness}</div>
      </header>
      {data.message === undefined ? null : <p role={data.status === 'error' ? 'alert' : 'status'}>{data.message}</p>}
      {data.status === 'searching' ? <p role="status">正在检索授权范围内的工单…</p> : null}
      {data.candidates.length === 0 && data.status !== 'searching' ? <p>没有可显示的候选。</p> : null}
      <ol style={list}>
        {data.candidates.map(candidate => {
          const details = data.alreadyReadEvidence.filter(evidence => evidence.candidateRef === candidate.ref)
          const isExpanded = expanded.has(candidate.ref)
          const detailId = `ticket-detail-${candidate.ref}`
          return <li key={candidate.ref} style={card}>
            <strong>{candidate.rank}. {candidate.displayId} — {candidate.title}</strong>
            <span>{candidate.summary}</span>
            <span style={metadata}>状态：{candidate.l0.status ?? '未知'} · 优先级：{candidate.l0.priority ?? '未知'} · 来源版本：{candidate.sourceVersion}</span>
            <span><button type="button" aria-expanded={isExpanded} aria-controls={detailId} onClick={() => { toggle(candidate.ref) }}>{isExpanded ? '收起详情' : '查看已读取详情'}</button></span>
            {!isExpanded ? null : <div id={detailId}>
              {details.length === 0
                ? <p>本轮尚未读取更多详情；不会因展开而访问隐藏字段。</p>
                : details.map(detail => <section key={detail.evidenceId}>
                    <strong>{detail.field}</strong>
                    <p>{detail.text}</p>
                  </section>)}
            </div>}
          </li>
        })}
      </ol>
      <footer>
        <button
          type="button"
          disabled={!data.exportEnabled || exportStatus === 'preparing'}
          onClick={() => { void exportCurrent() }}
        >导出当前候选</button>
        <span role="status" aria-live="polite" style={metadata}>
          {exportStatus === 'preparing' ? '正在重新授权并准备 CSV…' : null}
          {exportStatus === 'success' ? 'CSV 下载已开始。' : null}
          {exportStatus === 'error' ? '导出失败；请确认会话与授权快照仍然有效。' : null}
        </span>
      </footer>
    </section>
  )
}
