import { describe, expect, it } from 'vitest'
import { displayFieldPart } from './workbench-content.js'
import { TASK_WORKBENCH_HTML } from './workbench.js'
import { DEFAULT_ONLINE_MODELS, ONLINE_MODEL_NAMES } from '@retrieval-agent/contracts'

it('offers the complete online bank and keeps no-feedback choices available', () => {
  const bank = TASK_WORKBENCH_HTML.split('id="online-models"')[1]!.split('</fieldset>')[0]!
  const methods = [...bank.matchAll(/value="([^"]+)"/gu)].map(m => m[1])
  const selected = [...bank.matchAll(/value="([^"]+)" checked/gu)].map(m => m[1])
  expect(methods).toEqual([...ONLINE_MODEL_NAMES])
  expect(methods).toHaveLength(14)
  expect(selected).toEqual([...DEFAULT_ONLINE_MODELS])
  expect(TASK_WORKBENCH_HTML).toContain('value="stratified_diverse">分层多样性')
  expect(TASK_WORKBENCH_HTML).toContain('value="ranked_top128" selected>优先高排名')
  expect(TASK_WORKBENCH_HTML).toContain('value="single">最佳单模型')
  expect(TASK_WORKBENCH_HTML).toContain('value="selective" selected>二分类多数投票')
  expect(TASK_WORKBENCH_HTML).toContain('候选模型（14 种）')
  expect(TASK_WORKBENCH_HTML).toContain('标题摘要 TF-IDF 逻辑回归')
  expect(TASK_WORKBENCH_HTML).toContain('标题摘要 TF-IDF 线性 SVM')
  for (const method of ['dual_description_margin', 'name_gmm', 'kmeans']) {
    expect(TASK_WORKBENCH_HTML).toContain(`value="${method}"`)
  }
})

describe('source dialogue presentation', () => {
  it('decodes dialogue and maps real source offsets through escaped quotes and newlines', () => {
    const raw = JSON.stringify({ speaker: 'agent', text: '您好，"手厅"\n暂不支持。' })
    const start = raw.indexOf('暂不支持')
    const shown = displayFieldPart(raw, [{ start, end: start + 4, text: '暂不支持' }])
    expect(shown.speaker).toBe('客服')
    expect(shown.value).toBe('您好，"手厅"\n暂不支持。')
    expect(shown.value.slice(shown.ranges[0]!.start, shown.ranges[0]!.end)).toBe('暂不支持')
  })
  it('does not invent highlights for stale or partly escaped citations', () => {
    const raw = '{"speaker":"customer","text":"a\\n故障"}'
    const escape = raw.indexOf('\\n')
    expect(displayFieldPart(raw, [{ start: escape + 1, end: escape + 2, text: 'n' }]).ranges).toEqual([])
    expect(displayFieldPart(raw, [{ start: 0, end: 2, text: '旧值' }]).ranges).toEqual([])
  })
  it('retains ordinary text and unfamiliar structured records verbatim', () => {
    for (const raw of ['客户说：<script>故障</script>', '{"speaker":"agent","text":"故障","extra":true}', 'not json']) {
      expect(displayFieldPart(raw).value).toBe(raw)
      expect(displayFieldPart(raw).speaker).toBeUndefined()
    }
  })
})
