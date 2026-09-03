import { useEffect, useRef, useState } from 'react'
import { IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  TicketCandidate,
  TicketCandidateNode,
  TicketCandidateRef,
  TicketDetail,
} from '@retrieval-agent/contracts'
import css from './CandidatePanel.module.css'
import { continueFailureMessage, continueRetrieval } from './continue.js'
import { detailFailureMessage, readTicketDetail } from './detail.js'

export type CandidatePanelProps = PropsRuntime<'conversation.chat.node', 'ticket-candidates'>

const STATUS_LABELS: Record<TicketCandidateNode['status'], string> = {
  searching: '检索中',
  results: '已加载候选',
  empty: '无结果',
  partial: '部分结果',
  snapshot_invalid: '快照失效',
  permission_blocked: '权限受限',
  error: '来源异常',
  stopped: '已停止',
}

const DETAIL_LABELS: Readonly<Record<string, string>> = {
  problemDescription: '问题描述',
  conversationOrUpdates: '处理过程与更新',
  resolutionSteps: '处理步骤',
  rootCause: '根因',
  answer: '处理结果',
  'source.resolution': '来源解决方案',
}

type DetailLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly detail: TicketDetail }
  | { readonly status: 'error'; readonly message: string }

type ContinueLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'success' }
  | { readonly status: 'error'; readonly message: string }

function compactVersion(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 16)}…`
}

function displayDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

function boundaryText(data: TicketCandidateNode): string {
  if (data.resultPagesExhausted) return data.semanticRecallKnown
    ? '当前检索表达式已到底，并且有外部证据证明语义召回边界。'
    : '当前检索表达式没有更多结果；这不证明相关工单已全部找出。'
  if (data.result?.topKAccepted === true) return '当前 Top-K 已接受；语义召回范围仍未知。'
  if (data.nextPageAvailable) return '当前检索表达式仍有后续候选，检索尚未完成。'
  if (data.completeness === 'bounded') return '结果来自限定检索范围，可能不完整。'
  return data.completeness === 'unknown' ? '数据源未声明完整范围。' : '正在确认检索范围。'
}

function candidateMetadata(candidate: TicketCandidate): readonly { readonly label: string; readonly value: string }[] {
  const values = [
    ['类型', candidate.l0.type],
    ['类别', candidate.l0.category],
    ['产品', candidate.l0.product],
    ['组件', candidate.l0.component],
    ['状态', candidate.l0.status],
    ['优先级', candidate.l0.priority],
    ['区域', candidate.l0.region],
    ['创建', displayDate(candidate.l0.createdAt)],
    ['更新', displayDate(candidate.l0.updatedAt)],
    ['解决', displayDate(candidate.l0.resolvedAt)],
    ...candidate.l0.additionalFields?.map(field => [field.label, field.value] as const) ?? [],
  ] as const
  return values
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1].trim().length > 0)
    .map(([label, value]) => ({ label, value }))
}

function DetailBody({
  state,
  labels,
  retry,
}: {
  readonly state: DetailLoadState | undefined
  readonly labels: ReadonlyMap<string, string>
  readonly retry: () => void
}) {
  if (state === undefined || state.status === 'loading') {
    return <p className={css.detailStatus} role="status">正在从工单数据源重新授权并读取详情…</p>
  }
  if (state.status === 'error') {
    return <div className={css.detailError} role="alert">
      <p>{state.message}</p>
      <button type="button" className={css.retryButton} onClick={retry}>重试</button>
    </div>
  }
  const fields = Object.entries(state.detail.fields)
    .flatMap(([field, values]) => (values ?? []).map((value, index) => ({ field, value, index })))
  return <div className={css.detailContent}>
    <div className={css.detailIdentity}>
      <span><b>工单编号</b>{state.detail.displayId}</span>
      <span><b>来源版本</b>{compactVersion(state.detail.sourceVersion)}</span>
    </div>
    {state.detail.summary.trim().length === 0 || state.detail.summary.trim() === state.detail.title.trim()
      ? null
      : <p className={css.detailSummary}>{state.detail.summary}</p>}
    {fields.length === 0
      ? <p className={css.detailStatus}>当前授权字段中没有额外的正文详情。</p>
      : <dl className={css.detailGrid}>
        {fields.map(({ field, value, index }) => <div key={`${field}-${index}`} className={css.detailField}>
          <dt>{DETAIL_LABELS[field] ?? labels.get(field) ?? field}</dt>
          <dd>{value}</dd>
        </div>)}
      </dl>}
    {state.detail.unavailableFields.length === 0 ? null : (
      <p className={css.unavailable}>未返回：{state.detail.unavailableFields.map(field => DETAIL_LABELS[field] ?? labels.get(field) ?? field).join('、')}</p>
    )}
  </div>
}

/** Deterministic collection renderer. Detail clicks always go through the trusted Product Host. */
export function CandidatePanel({ node, sessionId }: CandidatePanelProps) {
  const data = node.data
  const [collectionExpanded, setCollectionExpanded] = useState(false)
  const [visibleCount, setVisibleCount] = useState(5)
  const [expanded, setExpanded] = useState<ReadonlySet<TicketCandidateRef>>(() => new Set())
  const [detailStates, setDetailStates] = useState<ReadonlyMap<TicketCandidateRef, DetailLoadState>>(() => new Map())
  const [continueState, setContinueState] = useState<ContinueLoadState>({ status: 'idle' })
  const continueInFlight = useRef(false)
  const terminal = data.result !== undefined
  const collectionId = `ticket-collection-${data.retrievalId}`
  const labels = new Map(data.detailFields.map(field => [field.key, field.label]))
  const statusLabel = terminal && data.result?.stoppingReason === 'top_k_accepted'
    ? '当前结果已就绪'
    : STATUS_LABELS[data.status]
  const heading = terminal
    ? `候选工单 · ${data.candidates.length} 条`
    : `候选工单 · 已加载 ${data.candidates.length} 条`

  useEffect(() => {
    continueInFlight.current = false
    setContinueState({ status: 'idle' })
  }, [data.version])

  const loadNextPage = async (): Promise<void> => {
    if (continueInFlight.current) return
    continueInFlight.current = true
    setContinueState({ status: 'loading' })
    try {
      await continueRetrieval(String(sessionId), data.retrievalId)
      setContinueState({ status: 'success' })
    } catch (error) {
      continueInFlight.current = false
      setContinueState({ status: 'error', message: continueFailureMessage(error) })
    }
  }

  const loadDetail = async (ref: TicketCandidateRef): Promise<void> => {
    setDetailStates(current => new Map(current).set(ref, { status: 'loading' }))
    try {
      const detail = await readTicketDetail(
        String(sessionId),
        data.retrievalId,
        ref,
        data.detailFields.map(field => field.key),
      )
      setDetailStates(current => new Map(current).set(ref, { status: 'loaded', detail }))
    } catch (error) {
      setDetailStates(current => new Map(current).set(ref, { status: 'error', message: detailFailureMessage(error) }))
    }
  }

  const toggleCandidate = (ref: TicketCandidateRef): void => {
    const opening = !expanded.has(ref)
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      return next
    })
    const detailState = detailStates.get(ref)
    if (opening && detailState?.status !== 'loaded' && detailState?.status !== 'loading') void loadDetail(ref)
  }

  return (
    <section className={css.panel} aria-label="工单检索结果" data-retrieval-status={data.status}>
      <button
        type="button"
        className={css.collectionToggle}
        aria-expanded={collectionExpanded}
        aria-controls={collectionId}
        disabled={data.candidates.length === 0 && !terminal}
        onClick={() => { setCollectionExpanded(value => !value) }}
      >
        <div className={css.headingLine}>
          <div>
            <h2 className={css.heading}>{heading}</h2>
          </div>
          <span className={css.headingActions}>
            <span className={terminal ? css.statusFinal : css.status}>{statusLabel}</span>
            {data.candidates.length === 0
              ? null
              : collectionExpanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
          </span>
        </div>
        <p className={css.query}><span>原始查询</span>{data.querySummary || '—'}</p>
        <p className={css.logic}>
          <span>提取关键词</span>
          {(data.fastQuery?.keyword?.terms ?? []).length === 0
            ? <em>—</em>
            : data.fastQuery!.keyword!.terms.map(term => <em key={term}>{term}</em>)}
        </p>
        {data.queryAmbiguities === undefined || data.queryAmbiguities.length === 0 ? null : (
          <p className={css.noticeInline}>待确认：{data.queryAmbiguities.map(item => item.text).join('；')}</p>
        )}
        <div className={css.context} aria-label="检索上下文">
          <span>{boundaryText(data)}</span>
        </div>
      </button>

      {!collectionExpanded ? null : <div id={collectionId} className={css.collectionBody}>
        {data.message === undefined ? null : (
          <p className={data.status === 'error' ? css.error : css.notice} role={data.status === 'error' ? 'alert' : 'status'}>
            {data.message}
          </p>
        )}
        {data.candidates.length === 0 ? <p className={css.empty}>集合中没有工单。</p> : null}
        <ol className={css.list}>
          {data.candidates.slice(0, visibleCount).map(candidate => {
            const isExpanded = expanded.has(candidate.ref)
            const detailId = `ticket-detail-${candidate.ref}`
            const detailState = detailStates.get(candidate.ref)
            const metadata = candidateMetadata(candidate)
            return <li key={candidate.ref} className={css.row}>
              <button
                type="button"
                className={css.rowToggle}
                aria-expanded={isExpanded}
                aria-controls={detailId}
                onClick={() => { toggleCandidate(candidate.ref) }}
              >
                <span className={css.rank} aria-label={`第 ${candidate.rank} 名`}>{String(candidate.rank).padStart(2, '0')}</span>
                <span className={css.rowContent}>
                  <span className={css.identityLine}>
                    <span className={css.ticketId}>工单编号 {candidate.displayId}</span>
                    <span className={css.detailAction}>{detailState?.status === 'loading'
                      ? '正在查询…'
                      : isExpanded ? '收起详细信息' : '查询详细信息'}</span>
                  </span>
                  <strong className={css.title}>{candidate.title}</strong>
                  {candidate.summary.trim().length === 0 || candidate.summary.trim() === candidate.title.trim()
                    ? null
                    : <span className={css.summary}>{candidate.summary}</span>}
                  {metadata.length === 0 ? null : <span className={css.metadata}>
                    {metadata.map(item => <span key={`${item.label}-${item.value}`}><b>{item.label}</b>{item.value}</span>)}
                  </span>}
                  <span className={css.source} title={candidate.sourceVersion}>来源 {compactVersion(candidate.sourceVersion)}</span>
                </span>
                <span className={css.rowChevron}>{isExpanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}</span>
              </button>
              {!isExpanded ? null : <div id={detailId} className={css.details}>
                <DetailBody
                  state={detailState}
                  labels={labels}
                  retry={() => { void loadDetail(candidate.ref) }}
                />
              </div>}
            </li>
          })}
        </ol>
        {visibleCount >= data.candidates.length ? null : (
          <button
            type="button"
            className={css.moreButton}
            onClick={() => { setVisibleCount(count => Math.min(data.candidates.length, count + 5)) }}
          >
            继续显示 {Math.min(5, data.candidates.length - visibleCount)} 条
          </button>
        )}
        {terminal || !data.nextPageAvailable ? null : (
          <div className={css.cursorControls}>
            <button
              type="button"
              className={css.moreButton}
              disabled={continueState.status === 'loading' || continueState.status === 'success'}
              onClick={() => { void loadNextPage() }}
            >
              {continueState.status === 'loading' ? '正在继续检索…'
                : continueState.status === 'success' ? '已请求下一批，等待结果更新…'
                  : continueState.status === 'error' ? '重试继续检索' : '继续检索下一批'}
            </button>
            {continueState.status !== 'error' ? null : (
              <p className={css.cursorError} role="alert">{continueState.message}</p>
            )}
          </div>
        )}
      </div>}
    </section>
  )
}
