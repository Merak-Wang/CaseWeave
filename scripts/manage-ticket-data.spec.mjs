import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizedRecord, redactText } from './manage-ticket-data.mjs'

test('redacts contextual names and detailed addresses without claiming individual verification', () => {
  const input = '客户张三反映测试村8组16号宽带故障。'
  const cleaned = redactText(input)
  assert.ok(!cleaned.text.includes('张三'))
  assert.ok(!cleaned.text.includes('测试村'))
  assert.ok(!cleaned.text.includes('16号'))
  assert.ok(cleaned.text.includes('宽带故障'))
  assert.ok(cleaned.counts.person_name > 0 && cleaned.counts.address > 0)
  const row = { id: 1, dataset: 'synthetic', messages: [
    { role: 'user', content: '【坐席】请问有什么问题？【客户】' + input }, { role: 'assistant', content: input }] }
  const before = JSON.stringify(row), value = normalizedRecord('train', row)
  assert.equal(JSON.stringify(row), before)
  assert.equal(value.pii_redaction_status, 'rules_applied')
  assert.equal(value.transformation.pii_redaction_verification, 'not_individually_reviewed')
  for (const text of [value.title, value.summary, value.problem_description, ...value.raw_dialogue.map(t => t.text)]) {
    assert.ok(!text.includes('张三') && !text.includes('测试村') && !text.includes('16号'))
  }
})
