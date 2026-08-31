import { useState } from 'react'
import { Button, IconChevronDownOutline14, IconChevronUpOutline14, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TicketCandidateRef, TicketCandidateNode } from '@retrieval-agent/contracts'
import css from './CandidatePanel.module.css'

export type CandidatePanelProps = PropsRuntime<'conversation.chat.node', 'ticket-candidates'>

const STATUS_LABELS: Record<TicketCandidateNode['status'], string> = {
  searching: '检索中',
  results: '候选已返回',
  empty: '无结果',
  partial: '部分结果',
  snapshot_invalid: '快照失效',
  permission_blocked: '权限受限',
  error: '来源异常',
  stopped: '已停止',
}

const COMPLETENESS_LABELS: Record<TicketCandidateNode['completeness'], string> = {
  pending: '等待检索',
  exhaustive: '已检索全部范围',
  bounded: '已检索限定范围',
  unknown: '范围未知',
}

function compactVersion(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 12)}…`
}

/** Deterministic collection renderer. It never interprets model-authored Markdown. */
export function CandidatePanel({ node }: CandidatePanelProps) {
  const data = node.data
  const [expanded, setExpanded] = useState<ReadonlySet<TicketCandidateRef>>(() => new Set())
  const toggle = (ref: TicketCandidateRef): void => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      return next
    })
  }
  const terminal = data.result !== undefined
  const statusLabel = terminal && data.result?.complete === true ? '已完成' : STATUS_LABELS[data.status]
  const heading = data.status === 'searching'
    ? '正在查找工单'
    : terminal
      ? `工单集合 · ${data.candidates.length} 条`
      : `候选工单 · ${data.candidates.length} 条`

  return (
    <section className={css.panel} aria-label="工单检索结果" data-retrieval-status={data.status}>
      <header className={css.header}>
        <div className={css.headingLine}>
          <div>
            <span className={css.eyebrow}>RETRIEVAL AGENT</span>
            <h2 className={css.heading}>{heading}</h2>
          </div>
          <Pill active={terminal}>{statusLabel}</Pill>
        </div>
        <p className={css.query}><span>检索条件</span>{data.querySummary || '—'}</p>
        <div className={css.context} aria-label="检索上下文">
          <span>{COMPLETENESS_LABELS[data.completeness]}</span>
          <span aria-hidden="true">·</span>
          <span>授权快照 {data.snapshotShortId ?? '准备中'}</span>
          {data.result === undefined ? null : <>
            <span aria-hidden="true">·</span>
            <span>{data.result.complete ? '集合完整' : '集合可能不完整'}</span>
          </>}
        </div>
      </header>

      {data.message === undefined ? null : (
        <p className={data.status === 'error' ? css.error : css.notice} role={data.status === 'error' ? 'alert' : 'status'}>
          {data.message}
        </p>
      )}
      {data.status === 'searching' ? <p className={css.empty} role="status">正在检索当前授权范围…</p> : null}
      {data.candidates.length === 0 && data.status !== 'searching' ? <p className={css.empty}>集合中没有工单。</p> : null}

      <ol className={css.list}>
        {data.candidates.map(candidate => {
          const details = data.alreadyReadEvidence.filter(evidence => evidence.candidateRef === candidate.ref)
          const isExpanded = expanded.has(candidate.ref)
          const detailId = `ticket-detail-${candidate.ref}`
          const facets = [
            candidate.l0.status === undefined ? undefined : `状态 ${candidate.l0.status}`,
            candidate.l0.priority === undefined ? undefined : `优先级 ${candidate.l0.priority}`,
            candidate.l0.category === undefined ? undefined : candidate.l0.category,
            ...(candidate.l0.additionalFields?.slice(0, 2).map(field => `${field.label} ${field.value}`) ?? []),
          ].filter((value): value is string => value !== undefined)
          return (
            <li key={candidate.ref} className={css.row}>
              <div className={css.rowHeading}>
                <span className={css.rank} aria-label={`第 ${candidate.rank} 名`}>{String(candidate.rank).padStart(2, '0')}</span>
                <div className={css.identity}>
                  <span className={css.ticketId}>{candidate.displayId}</span>
                  <h3 className={css.title}>{candidate.title}</h3>
                </div>
              </div>
              <p className={css.summary}>{candidate.summary}</p>
              {facets.length === 0 ? null : <div className={css.facets}>{facets.map(facet => <Pill key={facet}>{facet}</Pill>)}</div>}
              <div className={css.rowFooter}>
                <span className={css.source} title={candidate.sourceVersion}>来源 {compactVersion(candidate.sourceVersion)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={css.detailButton}
                  icon={isExpanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
                  aria-expanded={isExpanded}
                  aria-controls={detailId}
                  onClick={() => { toggle(candidate.ref) }}
                >
                  {isExpanded ? '收起已读详情' : '查看已读详情'}
                </Button>
              </div>
              {!isExpanded ? null : (
                <div id={detailId} className={css.details}>
                  {details.length === 0
                    ? <p>本轮没有读取额外字段；展开不会触发新的数据访问。</p>
                    : details.map(detail => (
                        <section key={detail.evidenceId} className={css.detail}>
                          <h4>{detail.field}</h4>
                          <p>{detail.text}</p>
                        </section>
                      ))}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
