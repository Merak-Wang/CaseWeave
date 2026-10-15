import { expect, it } from 'vitest'
import { DEFAULT_ONLINE_MODELS } from '@retrieval-agent/contracts'
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
    .toMatchObject({ kind: 'query', text: '副卡', execution: { onlineLearning: true, onlineFusion: 'selective',
      onlineModels: [...DEFAULT_ONLINE_MODELS], onlineSampling: 'ranked_top128' } })
})


it('persists explicit online bank and rejects unknown, duplicated, empty or offline model settings', () => {
  const execution = { onlineLearning: true, semanticMethod: 'auto', onlineFusion: 'selective',
    onlineModels: ['dense_lr', 'joint_lr'], onlineSampling: 'ranked_top128' }
  expect(parseTaskCommand({ operationId: 'online-bank', kind: 'query', text: '合成查询', execution }).command)
    .toEqual({ kind: 'query', text: '合成查询', execution })
  const diverse = { ...execution, onlineSampling: 'stratified_diverse' }
  expect(parseTaskCommand({ operationId: 'existing-diverse', kind: 'query', text: '合成查询', execution: diverse }).command)
    .toEqual({ kind: 'query', text: '合成查询', execution: diverse })
  const single = { ...execution, onlineFusion: 'single', onlineModels: ['joint_lr'] }
  expect(parseTaskCommand({ operationId: 'existing-single', kind: 'query', text: '合成查询', execution: single }).command)
    .toEqual({ kind: 'query', text: '合成查询', execution: single })
  for (const bad of [
    { ...execution, onlineModels: [] }, { ...execution, onlineModels: ['dense_lr', 'dense_lr'] },
    { ...execution, onlineModels: ['unregistered'] }, { ...execution, onlineFusion: 'average_all' },
    { ...execution, onlineSampling: 'whole_corpus' },
    { ...execution, onlineLearning: false }, { ...execution, semanticMethod: 'direct_teacher' },
  ]) expect(() => parseTaskCommand({ operationId: 'bad-bank', kind: 'query', text: '合成查询', execution: bad })).toThrow()
})

it('rejects retired probability and calibration execution controls', () => {
  const execution = { onlineLearning: true, semanticMethod: 'auto' }
  for (const retired of [{ judgeMode: 'anyjev_l0' }, { judgeMode: 'compact_binary' }, { judgePrior: 'none' }]) {
    expect(() => parseTaskCommand({ operationId: 'retired-judge', kind: 'query', text: '账号权限',
      execution: { ...execution, ...retired } })).toThrow()
  }
})

it('binds a dataset only on a new query and accepts existing publication names', () => {
  expect(parseTaskCommand({ operationId: 'dataset-task', kind: 'query', text: '账号权限', datasetId: '运保.2026-10' }).command)
    .toMatchObject({ kind: 'query', datasetId: '运保.2026-10' })
  for (const datasetId of ['', ' ', 12, 'a'.repeat(192)]) expect(() => parseTaskCommand({
    operationId: 'bad-dataset', kind: 'query', text: '账号权限', datasetId })).toThrow()
  expect(() => parseTaskCommand({ operationId: 'change-dataset', kind: 'supplement', text: '补充条件', datasetId: 'other' })).toThrow()
})
