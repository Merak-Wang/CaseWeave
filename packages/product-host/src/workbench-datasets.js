const stages = { connecting: '连接数据库', download: '下载工单', clean: '清洗与去重', embed: '构建向量', index: '发布索引', ready: '可用于检索', failed: '构建失败', cancelled: '已取消' }
const terminal = new Set(['ready', 'failed', 'cancelled'])
const text = (tag, value, cls = '') => { const e = document.createElement(tag); e.textContent = value; e.className = cls; return e }
const dateValue = value => value ? value + (value.length === 16 ? ':00+08:00' : '+08:00') : null

export const datasetPreviewTimeout = request => ((request?.timeoutSeconds ?? 30) + 5) * 1000

export function datasetInitialDates(now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 3600000)
  const end = shanghai.toISOString().slice(0, 19)
  const month = shanghai.getUTCMonth() - 1
  const day = Math.min(shanghai.getUTCDate(), new Date(Date.UTC(shanghai.getUTCFullYear(), month + 1, 0)).getUTCDate())
  const start = new Date(Date.UTC(shanghai.getUTCFullYear(), month, day, shanghai.getUTCHours(), shanghai.getUTCMinutes(), shanghai.getUTCSeconds())).toISOString().slice(0, 19)
  return { start, end, name: '运保中心·' + end.slice(0, 10) }
}

export function datasetPayload(values) {
  if (values.start && values.end && values.start >= values.end) throw new Error('结束时间必须晚于开始时间。')
  return { name: values.name.trim(), connection: { uri: values.uri.trim(), database: values.database.trim(), collection: values.collection.trim() },
    time: { field: values.timeField.trim(), type: values.timeType, start: dateValue(values.start), end: dateValue(values.end), timezone: 'Asia/Shanghai' },
    source: { field: values.sourceField.trim(), value: values.sourceValue.trim() }, fields: { id: values.idField.trim(), title: values.titleField.trim(), abstract: values.abstractField.trim() },
    limit: Number(values.limit), timeoutSeconds: Number(values.timeout) }
}

export function datasetProgressText(row) {
  const c = row.counts ?? {}
  return `读取 ${c.read ?? 0} · 有效 ${c.valid ?? 0} · 重复 ${c.duplicate ?? 0} · 跳过 ${c.skipped ?? 0} · 向量 ${c.embeddedChunks ?? 0}/${c.totalChunks ?? 0} · 已索引 ${c.indexedChunks ?? 0}`
}

export function preferredDataset(rows, selected, defaultDatasetId) {
  const ids = rows.filter(r => r.stage === 'ready').map(r => r.datasetId ?? r.id)
  return ids.includes(selected) ? selected : ids.includes(defaultDatasetId) ? defaultDatasetId : ids[0] ?? ''
}

export function createDatasetUI({ api, onSelectionChange }) {
  const $ = id => document.getElementById(id), base = '/api/retrieval-agent/datasets'
  const selector = $('dataset-selector'), form = $('dataset-form')
  let rows = [], selected = '', defaultDatasetId, bound, poll, loading = false
  const error = e => { if ($('dataset-error')) { $('dataset-error').textContent = e.message; $('dataset-error').hidden = false } else if ($('dataset-selection-note')) $('dataset-selection-note').textContent = '数据目录读取失败，请打开数据管理重试。' }
  const clearError = () => { if ($('dataset-error')) $('dataset-error').hidden = true }
  const busy = value => { for (const id of ['dataset-preview', 'dataset-build']) if ($(id)) $(id).disabled = value }
  function render() {
    if (selector && !bound) {
      const ready = rows.filter(r => r.stage === 'ready'), old = selected || selector.value
      selector.replaceChildren(...ready.map(r => { const option = text('option', `${r.name} · ${r.counts?.valid ?? r.recordCount ?? 0} 条`); option.value = r.datasetId ?? r.id; return option }))
      if (!ready.length) selector.append(text('option', '暂无可检索数据，请连接并构建'))
      selected = preferredDataset(rows, old, defaultDatasetId)
      selector.value = selected; selector.disabled = !ready.length
      onSelectionChange?.(selected)
    }
    const list = $('dataset-list'); if (!list) return
    list.replaceChildren(...rows.map(row => {
      const card = text('article', '', 'dataset-card'); card.append(text('h3', row.name), text('p', stages[row.stage] ?? row.stage), text('p', datasetProgressText(row)))
      if (row.error) card.append(text('p', row.error, 'notice error'))
      if (row.stage === 'ready') { const link = text('a', '在检索工作台使用'); link.href = '/retrieval?dataset=' + encodeURIComponent(row.datasetId ?? row.id); card.append(link) }
      else if (!terminal.has(row.stage)) { const cancel = text('button', '取消构建', 'secondary'); cancel.type = 'button'; cancel.onclick = async () => { cancel.disabled = true; try { await api(base + '/' + encodeURIComponent(row.id) + '/cancel', {}); await refresh() } catch (e) { error(e); cancel.disabled = false } }; card.append(cancel) }
      if (row.counts?.totalChunks > 0) { const progress = document.createElement('progress'); progress.max = row.counts.totalChunks; progress.value = row.counts.indexedChunks ?? row.counts.embeddedChunks ?? 0; progress.setAttribute('aria-label', '向量索引构建进度'); card.append(progress) }
      return card
    }))
    if (!rows.length) list.append(text('p', '尚无数据。连接MongoDB并预览后开始构建。', 'muted'))
  }
  async function refresh() {
    if (loading) return
    loading = true
    try { const result = await api(base); rows = result.datasets; defaultDatasetId = result.defaultDatasetId; render(); clearTimeout(poll); if (rows.some(r => !terminal.has(r.stage))) poll = setTimeout(() => void refresh().catch(error), 1500) }
    finally { loading = false }
  }
  function payload() {
    const value = id => $(id).value
    return datasetPayload({ name: value('dataset-name'), uri: value('mongo-uri'), database: value('mongo-database'), collection: value('mongo-collection'),
      timeField: value('dataset-time-field'), timeType: value('dataset-time-type'), start: value('dataset-start'), end: value('dataset-end'),
      sourceField: value('dataset-source-field'), sourceValue: value('dataset-source-value'), idField: value('dataset-id-field'), titleField: value('dataset-title-field'), abstractField: value('dataset-abstract-field'), limit: value('dataset-limit'), timeout: value('dataset-timeout') })
  }
  if (selector) { selected = new URLSearchParams(location.search).get('dataset') ?? ''; selector.onchange = () => { selected = selector.value; onSelectionChange?.(selected) } }
  if (form) {
    const initial = datasetInitialDates()
    if (!$('dataset-start').value) $('dataset-start').value = initial.start
    if (!$('dataset-end').value) $('dataset-end').value = initial.end
    if (!$('dataset-name').value || $('dataset-name').value === '运保中心工单') $('dataset-name').value = initial.name
    $('dataset-preview').onclick = async () => {
      if (!form.reportValidity()) return
      clearError(); busy(true); $('dataset-status').textContent = '正在连接并读取筛选预览…'
      try { const request = payload(), preview = await api(base + '/preview', request, AbortSignal.timeout(datasetPreviewTimeout(request))); $('dataset-preview-panel').hidden = false
        $('dataset-preview-summary').textContent = `符合筛选 ${preview.matchedCount} 条 · 时间类型 ${preview.timeType} · 字段：${preview.fields.join('、')}`
        if (preview.timeType === 'date' || preview.timeType === 'string') $('dataset-time-type').value = preview.timeType
        $('dataset-preview-samples').replaceChildren(...preview.samples.map(s => { const card = text('article', '', 'dataset-sample'); card.append(text('strong', s.title || '无标题'), text('p', s.abstract || '无摘要'), text('small', `${s.id} · ${s.date ?? ''} · ${s.source ?? ''}`)); return card }))
        $('dataset-status').textContent = '预览完成，请确认范围后下载并构建。'
      } catch (e) { error(e); $('dataset-status').textContent = '连接或预览失败，可调整配置重试。' } finally { busy(false) }
    }
    form.onsubmit = async event => {
      event.preventDefault(); clearError(); busy(true)
      try { const row = await api(base, payload()); $('mongo-uri').value = ''; $('dataset-status').textContent = `已启动“${row.name}”，可刷新页面查看进度。`; await refresh() }
      catch (e) { error(e); $('dataset-status').textContent = '构建未启动，可调整配置重试。' } finally { busy(false) }
    }
    $('dataset-refresh').onclick = () => void refresh().catch(error)
  }
  void refresh().catch(error)
  return { refresh, selectedId: () => selected, showBound(datasetId) { bound = datasetId; if (selector) { selector.hidden = true; selector.disabled = true } for (const id of ['dataset-bound', 'dataset-bound-task']) if ($(id)) { $(id).hidden = false; $(id).textContent = `本任务绑定数据集：${datasetId}` } }, dispose() { clearTimeout(poll) } }
}
