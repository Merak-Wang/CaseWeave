import { useRef, useState } from 'react'
import type { TicketCandidateNode } from '@retrieval-agent/contracts'
import { exportCandidates } from '@retrieval-agent/product-api/download-client'
import css from './CandidatePanel.module.css'

const qualityValue = (value: unknown): string => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1
  ? '未测量' : `${(value * 100).toFixed(1)}%`

export function ResultDelivery({ data, sessionId }: { readonly data: TicketCandidateNode; readonly sessionId: string }) {
  const result = data.result!
  const total = result.learnedSet?.returned ?? result.tickets.length
  const resultLabel = result.learnedSet ? '模型推断相关' : '已确认'
  const downloadLabel = result.learnedSet ? '模型推断相关工单' : '确认工单'
  const inFlight = useRef(false)
  const [download, setDownload] = useState<{ loading?: boolean; message?: string; error?: boolean }>({})
  const exportTickets = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setDownload({ loading: true })
    try {
      const receipt = await exportCandidates(sessionId, data.retrievalId, result.resultRevision)
      setDownload({ message: `已生成 ${receipt.rowCount} 条${downloadLabel}，文件校验通过。SHA-256：${receipt.contentSha256}` })
    } catch (error) {
      setDownload({ error: true, message: error instanceof Error ? error.message : '下载失败，请重试。' })
    } finally { inFlight.current = false }
  }
  return <section className={css.delivery} aria-label={`${resultLabel}结果与下载`}>
    <h3>{total === 0 ? '本次尚无可确认结果' : `${resultLabel} ${total} 条工单`}</h3>
    <p>{result.explanation ?? '请结合当前查询范围和证据使用确认结果。'}</p>
    {result.learnedSet ? <p>模型预测未逐条经过语言模型判断。{result.learnedSet.quality.basis === 'training_group_crossfit'
      ? <>训练组交叉拟合教师参考查准率 {qualityValue(result.learnedSet.quality.precision)}，召回率 {qualityValue(result.learnedSet.quality.recall)}；这些指标用于选模，不代表业务准确率或最终独立验收。</>
      : result.learnedSet.quality.basis === 'selection'
      ? <>选择集查准率 {qualityValue(result.learnedSet.quality.precision)}，选择集召回率 {qualityValue(result.learnedSet.quality.recall)}；{result.learnedSet.quality.acceptance === 'fallback' ? '未达原目标，采用最佳模型预测，查准率达到 60% 门槛' : '模型达标后直接预测'}，未进行独立抽验，指标不代表全库质量。</>
      : <>历史抽验查准率下界 {qualityValue(result.learnedSet.quality.precision_lower)}，召回率下界 {qualityValue(result.learnedSet.quality.recall_lower)}；这是旧版记录，不是实际召回率。</>}</p> : null}
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
      {total > 5 ? <p>此处展示前 5 条依据，完整确认集合可下载。</p> : null}
      <p>来源快照：{result.snapshotShortId ?? '未建立'}；结果版本：{result.resultRevision}</p>
    </details>
    <button type="button" className={css.moreButton} disabled={!data.exportEnabled || download.loading === true}
      onClick={() => { void exportTickets() }}>
      {download.loading ? '正在生成确认结果文件…' : `下载全部${downloadLabel}（${total} 条 CSV）`}
    </button>
    {download.message === undefined ? null : <p role={download.error ? 'alert' : 'status'}>{download.message}</p>}
  </section>
}
