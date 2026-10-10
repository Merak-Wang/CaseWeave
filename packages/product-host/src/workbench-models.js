const $ = id => document.getElementById(id)
const node = (tag, text, cls = '') => { const e = document.createElement(tag); e.textContent = text; e.className = cls; return e }
const names = { 'openai-completions': 'OpenAI 兼容 · Chat Completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' }

export function createModelUI({ api, getTaskId }) {
  let data, epoch = 0, source, probing
  const path = () => '/api/retrieval-agent/models' + (getTaskId() ? '?task=' + encodeURIComponent(getTaskId()) : '')
  const showError = error => { $('model-error').textContent = error.message; $('model-error').hidden = false }
  const clearError = () => { $('model-error').hidden = true }
  const chosen = () => data?.configured.find(p => p.id === data.selected?.provider)
  function label() {
    const value = data?.selected?.model ?? '选择模型'
    for (const id of ['model-selector', 'model-selector-task']) { $(id).querySelector('span').textContent = value; $(id).title = value + ' · 切换模型或管理供应商' }
    $('model-scope').textContent = data?.notice || (getTaskId() ? '选择将用于当前检索的后续步骤。正在生成的内容会继续完成。' : '为新检索选择模型，主 Agent 与领域专家沿用相同供应商。')
  }
  async function load() {
    const current = ++epoch
    const next = await api(path())
    if (current !== epoch) return
    data = next
    label(); renderList()
  }
  function busy(value) {
    for (const id of ['model-save', 'model-reasoning', 'manage-models', 'models-back', 'model-discover']) $(id).disabled = value
    for (const control of $('model-config-form').querySelectorAll('input, select')) control.disabled = value
    for (const button of $('model-options').querySelectorAll('button')) button.disabled = value
    $('model-probe-cancel').hidden = !value
  }
  async function choose(body) {
    if (probing) return false
    const controller = new AbortController(); probing = controller
    clearError(); busy(true)
    const status = $('model-probe-status'); status.hidden = false; status.textContent = `正在检测 ${body.model}…最多等待 30 秒。`
    try {
      const next = await api(path(), body, AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]))
      if (controller.signal.aborted) return false
      data = next; label(); renderList()
      status.textContent = `已连接，耗时 ${next.probe.elapsedMs} ms，已选择 ${data.selected.model}。` + (next.probe.finish === 'max-tokens' ? '短输出达到上限；本次仅检测连接。' : next.probe.outputKind === 'reasoning' ? '模型已返回推理响应；本次仅检测连接。' : '')
      return true
    } catch (error) {
      if (controller.signal.aborted) status.textContent = '已取消检测，原模型选择保持不变。'
      else { status.textContent = '连接检测失败，可以再次点击重试。'; showError(error) }
      if (body.action === 'save') await load().catch(() => {})
      return false
    } finally { probing = undefined; busy(false); renderList() }
  }
  function renderList() {
    const currentModel = chosen()?.models.find(m => m.id === data.selected?.model)
    const efforts = currentModel?.reasoningEfforts ?? []
    $('model-reasoning-row').hidden = !efforts.length
    $('model-reasoning').replaceChildren(...[{ id: '', name: '模型默认' }, ...efforts].map(e => {
      const o = node('option', ({ off: '关闭深度思考', low: '快速思考', medium: '均衡思考', high: '深入思考', max: '最大思考强度' })[e.id] ?? e.name ?? e.id); o.value = e.id; return o
    }))
    $('model-reasoning').value = data?.selected?.reasoningEffort ?? ''
    const query = $('model-search').value.toLowerCase(), list = $('model-options'); list.replaceChildren()
    for (const p of data?.configured ?? []) {
      const models = p.models.filter(m => [p.name, m.name, m.id].join(' ').toLowerCase().includes(query))
      if (!models.length) continue
      list.append(node('p', p.name, 'model-group'))
      for (const m of models) {
        const b = node('button', '', 'model-option'); b.type = 'button'; b.setAttribute('role', 'option')
        const selected = p.id === data.selected?.provider && m.id === data.selected?.model
        b.setAttribute('aria-selected', String(selected))
        const copy = node('div', ''); copy.append(node('strong', m.name), node('small', m.contextWindow ? `${m.contextWindow >= 1000000 ? (m.contextWindow / 1000000).toFixed(1).replace('.0', '') + 'M' : Math.round(m.contextWindow / 1000) + 'K'} 上下文` : '容量由供应商提供'))
        b.append(copy, node('span', selected ? '✓' : ''))
        b.disabled = Boolean(probing)
        b.onclick = () => void choose({ action: 'select', provider: p.id, model: m.id, ...(selected && data.selected.reasoningEffort ? { reasoningEffort: data.selected.reasoningEffort } : {}) })
        list.append(b)
      }
    }
    if (!list.children.length) list.append(node('p', '没有匹配模型。添加供应商后即可在这里选择。', 'muted'))
  }
  function edit(provider = chosen()?.id) {
    $('model-picker-view').hidden = true; $('model-settings-view').hidden = false; clearError()
    const ids = new Map((data.providers ?? []).map(p => [p.id, p.name]))
    for (const p of data.configured) ids.set(p.id, p.name)
    ids.set('ollama', 'Ollama · 本地模型'); ids.set('custom', '自定义 OpenAI 兼容服务')
    $('provider-choice').replaceChildren(...[...ids].map(([id, name]) => { const o = node('option', name); o.value = id; return o }))
    $('provider-choice').value = ids.has(provider) ? provider : 'custom'
    $('provider-api').replaceChildren(node('option', '使用供应商默认协议'), ...data.protocols.map(p => { const o = node('option', names[p] ?? p); o.value = p; return o }))
    $('provider-api').options[0].value = ''
    populate(); $('provider-choice').focus()
  }
  function populate() {
    const id = $('provider-choice').value, profile = data.configured.find(p => p.id === id)
    $('provider-id').value = id === 'custom' ? '' : id
    $('provider-id').readOnly = id !== 'custom'
    $('provider-api').value = profile?.api || (['custom', 'ollama'].includes(id) ? 'openai-completions' : '')
    $('provider-url').value = profile?.baseURL || (id === 'ollama' ? 'http://host.docker.internal:11434/v1' : '')
    $('provider-key').value = ''; $('provider-key').placeholder = profile?.hasCredential ? '已保存 · 留空保留现有密钥' : 'Ollama 可留空；其他服务按其要求填写'
    const model = profile?.models.find(m => m.id === data.selected?.model) ?? profile?.models[0]
    $('provider-model').value = model?.id ?? ''; $('provider-context').value = model?.contextWindow ?? ''
    $('provider-output').value = model?.maxTokens ?? ''
    $('provider-model-list').replaceChildren(...(profile?.models ?? []).map(m => { const o = node('option', m.name); o.value = m.id; return o }))
    $('model-local-note').hidden = id !== 'ollama'
  }
  const draft = action => ({ action, provider: $('provider-id').value.trim(), model: $('provider-model').value.trim(),
    api: $('provider-api').value, baseURL: $('provider-url').value.trim(),
    ...($('provider-key').value ? { apiKey: $('provider-key').value } : {}), revision: data.revision,
    ...($('provider-context').value ? { contextWindow: Number($('provider-context').value) } : {}),
    ...($('provider-output').value ? { maxTokens: Number($('provider-output').value) } : {}),
    ...($('provider-id').value.trim() === data.selected?.provider && $('provider-model').value.trim() === data.selected?.model && data.selected.reasoningEffort ? { reasoningEffort: data.selected.reasoningEffort } : {}) })
  async function open(settings = false) {
    source = document.activeElement; clearError(); $('model-probe-status').hidden = true; $('model-picker-view').hidden = false; $('model-settings-view').hidden = true
    $('model-options').replaceChildren(node('p', '正在读取模型…', 'shimmer-text')); $('model-dialog').showModal()
    try { await load(); if (settings) edit(); else $('model-search').focus() } catch (e) { showError(e) }
  }
  for (const id of ['model-selector', 'model-selector-task']) $(id).onclick = () => void open()
  $('model-settings').onclick = () => void open(true)
  $('manage-models').onclick = () => edit()
  $('models-back').onclick = () => { $('model-settings-view').hidden = true; $('model-picker-view').hidden = false; clearError(); renderList() }
  $('model-close').onclick = () => $('model-dialog').close()
  $('model-probe-cancel').onclick = () => probing?.abort()
  $('model-dialog').onclose = () => { probing?.abort(); $('provider-key').value = ''; source?.focus({ preventScroll: true }) }
  $('model-search').oninput = renderList; $('provider-choice').onchange = populate
  $('model-reasoning').onchange = () => void choose({ action: 'select', ...data.selected, reasoningEffort: $('model-reasoning').value })
  $('model-discover').onclick = async () => {
    clearError(); $('model-discover').disabled = true
    try { const result = await api(path(), draft('discover')); $('provider-model-list').replaceChildren(...result.models.map(m => { const o = node('option', m.name || m.id); o.value = m.id; return o })); $('model-discovery-status').textContent = `已发现 ${result.models.length} 个模型，可在模型 ID 中选择。` }
    catch (e) { showError(e) } finally { $('model-discover').disabled = false }
  }
  $('model-config-form').onsubmit = async e => {
    e.preventDefault()
    if (await choose(draft('save'))) { $('provider-key').value = ''; $('model-settings-view').hidden = true; $('model-picker-view').hidden = false }
  }
  void load().catch(() => { /* The chooser presents a retryable error when opened. */ })
  return { refresh: () => load().catch(() => {}) }
}
