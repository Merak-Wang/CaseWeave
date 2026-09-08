import { useRef, useState } from 'react'
import type { TicketCandidateNode } from '@retrieval-agent/contracts'
import { exportCandidates } from '@retrieval-agent/product-api/download-client'
import css from './CandidatePanel.module.css'

export function ResultDelivery({ data, sessionId }: { readonly data: TicketCandidateNode; readonly sessionId: string }) {
  const result = data.result!
  const inFlight = useRef(false)
  const [download, setDownload] = useState<{ loading?: boolean; message?: string; error?: boolean }>({})
  const exportTickets = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setDownload({ loading: true })
    try {
      const receipt = await exportCandidates(sessionId, data.retrievalId, result.resultRevision)
      setDownload({ message: `已生成 ${receipt.rowCount} 条确认工单，文件校验通过。SHA-256：${receipt.contentSha256}` })
    } catch (error) {
      setDownload({ error: true, message: error instanceof Error ? error.message : '下载失败，请重试。' })
    } finally { inFlight.current = false }
  }
  return <section className={css.delivery} aria-label="确认结果与下载">
    <h3>{result.tickets.length === 0 ? '本次尚无可确认结果' : `已确认 ${result.tickets.length} 条工单`}</h3>
    <p>{result.explanation ?? '请结合当前查询范围和证据使用确认结果。'}</p>
    {result.stoppingReason === 'top_k_accepted' || result.stoppingReason === 'no_result' ? null
      : <p>本次检索尚未完成，已确认部分可以交付；其余候选仍需复核。</p>}
    <details>
      <summary>查看检索说明与确认依据</summary>
      <p>查询：{result.query}</p>
      <p>{result.resultPagesExhausted ? '当前检索表达式已枚举完。' : '当前检索表达式尚未枚举完。'}
        {result.semanticRecallKnown ? '' : ' 尚不能证明语义相关工单已全部找出。'}</p>
      <ul>{result.tickets.slice(0, 5).map(ticket => <li key={ticket.ref}>
        <strong>{ticket.displayId} · {ticket.title}</strong>
        <p>{result.judgments.find(judgment => judgment.candidateRef === ticket.ref)?.reason ?? '历史结果未记录逐项确认理由。'}</p>
        {result.evidence.filter(evidence => evidence.candidateRef === ticket.ref).slice(0, 2).map(evidence =>
          <blockquote key={evidence.evidenceId}>{evidence.text}</blockquote>)}
      </li>)}</ul>
      {result.tickets.length > 5 ? <p>此处展示前 5 条依据，完整确认集合可下载。</p> : null}
      <p>来源快照：{result.snapshotShortId ?? '未建立'}；结果版本：{result.resultRevision}</p>
    </details>
    <button type="button" className={css.moreButton} disabled={!data.exportEnabled || download.loading === true}
      onClick={() => { void exportTickets() }}>
      {download.loading ? '正在生成确认结果文件…' : `下载全部确认工单（${result.tickets.length} 条 CSV）`}
    </button>
    {download.message === undefined ? null : <p role={download.error ? 'alert' : 'status'}>{download.message}</p>}
  </section>
}
