import { describe, expect, it } from 'vitest'
import { compileQueryPlan } from './query-plan.js'

describe('semantic scope and exclusions keep their source meaning', () => {
  it('does not turn an excluded later issue into an OR retrieval branch', () => {
    const query = '查找副卡解绑受阻的工单，不纳入套餐或关系已解除后仅剩独立合账取消的诉求'
    const plan = compileQueryPlan(query, ['副卡', '解绑', '套餐', '关系', '合账'])
    expect(plan.requirements).toContainEqual(expect.objectContaining({ kind: 'semantic', status: 'evidence_required', polarity: 'exclude',
      span: expect.objectContaining({ text: '不纳入套餐或关系已解除后仅剩独立合账取消的诉求' }) }))
    expect(JSON.stringify(plan.keyword)).not.toMatch(/套餐|关系|合账/)
    expect(plan.vector.text).toBe(query)
  })
  it('distinguishes a quoted business scope from an explicit literal phrase', () => {
    const semantic = compileQueryPlan('检查是否属于“解绑仍受阻”的范围', ['解绑', '受阻'])
    expect(semantic.requirements).toContainEqual(expect.objectContaining({ kind: 'semantic', status: 'evidence_required',
      span: expect.objectContaining({ text: '“解绑仍受阻”' }) }))
    expect(semantic.hard).toEqual({ kind: 'constant', value: true })
    const literal = compileQueryPlan('摘要包含“解绑仍受阻”', ['解绑', '受阻'])
    expect(literal.hard).toEqual({ kind: 'literal', field: 'summary', op: 'phrase', text: '解绑仍受阻' })
  })
})
