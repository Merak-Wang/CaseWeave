import { useEffect, useMemo, useState } from 'react'
import { Button, IconDownloadOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  describeExportCandidatesFailure,
  exportCandidates,
  type ExportCandidatesFailure,
} from '@retrieval-agent/product-api/download-client'
import {
  isCompactHeaderWidth,
  NARROW_HEADER_IDENTITY_MAX_WIDTH,
} from './responsive.js'
import { latestTicketCandidateNode } from './selection.js'

export type ProductHeaderExportProps = PropsRuntime<'conversation.session.header.utilities'>

const narrowHeaderStyle = `
@media (max-width: ${NARROW_HEADER_IDENTITY_MAX_WIDTH}px) {
  header [data-slot="conversation.session.header.actions"] > * {
    display: none !important;
  }
}
`

function useCompactHeaderUtility(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && isCompactHeaderWidth(window.innerWidth),
  )
  useEffect(() => {
    const query = window.matchMedia('(max-width: 480px)')
    const update = (event: MediaQueryListEvent): void => { setCompact(event.matches) }
    setCompact(query.matches)
    query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [])
  return compact
}

export function ProductHeaderExport({ sessionId, useChat }: ProductHeaderExportProps) {
  const order = useChat(snapshot => snapshot.order)
  const nodes = useChat(snapshot => snapshot.nodes)
  const data = useMemo(() => latestTicketCandidateNode(order, nodes), [nodes, order])
  const [status, setStatus] = useState<'idle' | 'preparing' | 'success' | 'error'>('idle')
  const [failure, setFailure] = useState<ExportCandidatesFailure>()
  const compact = useCompactHeaderUtility()
  useEffect(() => {
    setStatus('idle')
    setFailure(undefined)
  }, [data?.retrievalId, data?.result?.resultRevision])
  const disabled = data?.exportEnabled !== true || data.result?.schemaVersion !== 2 || status === 'preparing'
  const run = async (): Promise<void> => {
    if (data?.result?.schemaVersion !== 2 || data.exportEnabled !== true) return
    setStatus('preparing')
    setFailure(undefined)
    try {
      await exportCandidates(String(sessionId), data.retrievalId, data.result.resultRevision)
      setStatus('success')
    } catch (error) {
      setFailure(describeExportCandidatesFailure(error))
      setStatus('error')
    }
  }
  const label = status === 'preparing' ? '正在导出…' : status === 'success' ? '已开始下载' : status === 'error' ? '导出失败，重试' : '导出工单'
  return (
    <>
      <style data-retrieval-agent-responsive>{narrowHeaderStyle}</style>
      <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
        <Button
          variant="ghost"
          size="sm"
          icon={<IconDownloadOutline16 />}
          disabled={disabled}
          aria-busy={status === 'preparing'}
          aria-label="下载全部确认工单"
          title={data === undefined
            ? '当前会话还没有已确认的工单结果'
            : failure === undefined ? undefined : `${failure.message} ${failure.action}`}
          onClick={() => { void run() }}
        >{compact ? null : label}</Button>
        <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>
          {status === 'success'
            ? 'CSV 下载已开始。'
            : failure === undefined ? '' : `导出失败：${failure.message} ${failure.action} 错误码：${failure.code}。`}
        </span>
        <Modal
          open={failure !== undefined}
          onClose={() => { setFailure(undefined) }}
          title="导出失败"
          closeLabel="关闭导出错误"
          description={failure?.message ?? ''}
          footer={<>
            <Button variant="ghost" onClick={() => { setFailure(undefined) }}>关闭</Button>
            {failure?.retryable === true
              ? <Button variant="primary" onClick={() => { void run() }}>重试</Button>
              : null}
          </>}
        >
          {failure === undefined ? null : <div>
            <p>错误码：<code>{failure.code}</code></p>
            <p>{failure.action}</p>
          </div>}
        </Modal>
      </span>
    </>
  )
}
