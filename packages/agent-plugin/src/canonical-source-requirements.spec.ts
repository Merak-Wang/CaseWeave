import { describe, expect, it } from 'vitest'
import type { SemanticQueryPlan } from '@retrieval-agent/contracts'
import { assertCanonicalSourceRequirements, canonicalSourceRequirements, canonicalSourceRequirementsMatch } from './canonical-source-requirements.js'

const unavailable = ['problemDescription', 'conversationOrUpdates', 'resolutionSteps', 'rootCause', 'answer', 'source.raw_dialogue', 'source.resolution']
const plan = (unsupported?: SemanticQueryPlan['unsupported_constraints']): SemanticQueryPlan => ({
  schemaVersion: 1, original: '合成查询', instruction: '依据标题摘要判断。', keywords: [], retrieval_expressions: [],
  goal: { mode: 'all', count: null }, manifest_id: 'synthetic-manifest', inputGeneration: 0,
  steps: [{ id: 'filter', op: 'sem_filter', inputs: ['$source'], instruction: '依据标题摘要判断。',
    params: { require_source: false, required_fields: [] } }],
  ...(unsupported ? { unsupported_constraints: unsupported } : {}),
})

describe('host provenance for explicit unavailable raw-source requests', () => {
  it.each([
    '筛选明确描述光猫、路由器、终端或其他设备故障，或者为处理设备故障而请求或实施重启、更换的工单。',
    '筛选明确描述拨号认证、业务认证或账号登录失败、报错、异常或无法完成的工单。',
    '筛选明确描述预约改期、延期、重新预约，或者联系客户时无人接听、联系不上或无法联系的工单。',
    '找设备更换处理过程、根因或答复涉及路由器的工单',
    '无需查看原始对话，找设备更换工单',
    '找标题包含“原始对话”的工单',
  ])('ordinary or explicitly unnecessary raw sources never become hard constraints: %s', query => {
    expect(canonicalSourceRequirements(query, unavailable)).toEqual([])
    expect(canonicalSourceRequirementsMatch(plan(), query, unavailable)).toBe(true)
  })

  it.each([
    ['找设备故障工单，必须逐字核对对话原文', '必须逐字核对对话原文', 'source.raw_dialogue'],
    ['找原始对话中客户要求更换设备的工单', '找原始对话中客户要求更换设备的工单', 'source.raw_dialogue'],
    ['必须读取处理过程原文确认实施更换', '必须读取处理过程原文确认实施更换', 'source.resolution'],
    ['必须查看原始对话中不需要更换设备的工单', '必须查看原始对话中不需要更换设备的工单', 'source.raw_dialogue'],
  ])('preserves a genuinely explicit raw source from actual task text: %s', (query, sourceText, field) => {
    const expected = [{ field, source_text: sourceText, provenance: 'host-explicit-raw-request-v1' as const }]
    expect(canonicalSourceRequirements(query, unavailable)).toEqual(expected)
    expect(() => assertCanonicalSourceRequirements(plan(expected), query, unavailable)).not.toThrow()
    expect(canonicalSourceRequirementsMatch(plan(), query, unavailable)).toBe(false)
  })

  it('rejects an exact but ordinary quoted query falsely mapped to an unavailable field', () => {
    const query = '找请求更换设备的工单'
    const forged = plan([{ field: 'resolutionSteps', source_text: query, provenance: 'host-explicit-raw-request-v1' }])
    expect(canonicalSourceRequirementsMatch(forged, query, unavailable)).toBe(false)
    expect(() => assertCanonicalSourceRequirements(forged, query, unavailable)).toThrow('当前用户明确要求')
  })

  it('invalidates legacy cached canonical plans that still require model-chosen source fields', () => {
    const old = { ...plan(), steps: [{ ...plan().steps[0]!, params: { require_source: true, required_fields: ['resolutionSteps'] } }] }
    expect(canonicalSourceRequirementsMatch(old, '设备更换', unavailable)).toBe(false)
  })

  it('does not reuse an explicit hard requirement after user text changed', () => {
    const query = '必须核对对话原文'
    const old = plan(canonicalSourceRequirements(query, unavailable))
    expect(canonicalSourceRequirementsMatch(old, '设备故障', unavailable)).toBe(false)
  })

  it('honors later user feedback withdrawing an earlier source requirement', () => {
    const oldText = '必须逐字核对对话原文'
    const changed = oldText + '\n无需查看原始对话，只根据标题摘要判断设备故障'
    expect(canonicalSourceRequirements(changed, unavailable)).toEqual([])
    expect(canonicalSourceRequirementsMatch(plan(canonicalSourceRequirements(oldText, unavailable)), changed, unavailable)).toBe(false)
    expect(canonicalSourceRequirementsMatch(plan(), changed, unavailable)).toBe(true)
  })
})
