import { describe, expect, it } from 'vitest'
import { displayFieldPart } from './workbench-content.js'

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
