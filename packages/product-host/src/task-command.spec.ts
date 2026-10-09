import { expect, it } from 'vitest'
import { parseTaskCommand } from './tasks.js'

it('admits explicit no-feedback execution only on the query command', () => {
  const execution = { onlineLearning: false, semanticMethod: 'auto' }
  expect(parseTaskCommand({ operationId: 'frozen-1', kind: 'query', text: '副卡', execution }).command)
    .toEqual({ kind: 'query', text: '副卡', execution })
  for (const bad of [{ onlineLearning: 'false', semanticMethod: 'auto' },
    { onlineLearning: false, semanticMethod: 'unverified-model' },
    { onlineLearning: false, semanticMethod: 'direct', endpoint: 'untrusted' }]) {
    expect(() => parseTaskCommand({ operationId: 'bad-1', kind: 'query', text: '副卡', execution: bad })).toThrow()
  }
  expect(() => parseTaskCommand({ operationId: 'bad-2', kind: 'resume', execution })).toThrow()
  expect(parseTaskCommand({ operationId: 'legacy-1', kind: 'query', text: '副卡' }).command)
    .toMatchObject({ kind: 'query', text: '副卡', execution: { onlineLearning: true, onlineFusion: 'selective', judgeMode: 'compact_binary',
      onlineModels: ['dense_lr', 'dense_svm', 'dense_mlp', 'dense_hgb', 'feedback_margin', 'relation_logistic'] } })
})


it('persists explicit online bank and rejects unknown, duplicated, empty or offline model settings', () => {
  const execution = { onlineLearning: true, semanticMethod: 'auto', onlineFusion: 'selective',
    onlineModels: ['dense_lr', 'relation_logistic'] }
  expect(parseTaskCommand({ operationId: 'online-bank', kind: 'query', text: '合成查询', execution }).command)
    .toEqual({ kind: 'query', text: '合成查询', execution })
  for (const bad of [
    { ...execution, onlineModels: [] }, { ...execution, onlineModels: ['dense_lr', 'dense_lr'] },
    { ...execution, onlineModels: ['unregistered'] }, { ...execution, onlineFusion: 'average_all' },
    { ...execution, onlineLearning: false }, { ...execution, semanticMethod: 'direct_teacher' },
  ]) expect(() => parseTaskCommand({ operationId: 'bad-bank', kind: 'query', text: '合成查询', execution: bad })).toThrow()
})
