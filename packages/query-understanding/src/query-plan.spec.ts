import { describe, expect, it } from 'vitest'
import { evaluateQuery, type QueryDocument } from '@retrieval-agent/contracts'
import { compileQueryPlan } from './query-plan.js'
import { buildPlannedTicketRequest } from './index.js'
import { assertTicketRetrievalRequest } from '@retrieval-agent/contracts'
import { compileUserConditions } from './conditions.js'

const doc = (title: string, body: string, region: string | null = null): QueryDocument => ({ texts: { title: [title], body: [body] }, fields: { region, status: null } })
describe('sourced Boolean QueryPlan', () => {
  it('recalls either topic in ordinary language while preserving explicit intersections', () => {
    const query = '查找副卡与跨域有关的工单'
    const plan = compileQueryPlan(query, ['副卡', '跨域'])
    for (const body of ['副卡解绑', '跨域业务', '跨域副卡']) expect(evaluateQuery(plan.keyword, doc('', body))).toBe(true)
    expect(evaluateQuery(plan.keyword, doc('', '普通宽带'))).toBe(false)
    for (const query of ['副卡 AND 跨域', '查找必须同时包含副卡与跨域的工单']) {
      const explicit = compileQueryPlan(query, ['副卡', '跨域'])
      expect(evaluateQuery(explicit.keyword, doc('副卡', '跨域'))).toBe(true)
      expect(evaluateQuery(explicit.keyword, doc('副卡', '普通业务'))).toBe(false)
    }
    const scoped = compileQueryPlan('只看上海的副卡与跨域工单', ['副卡', '跨域'])
    expect(evaluateQuery(scoped.hard, doc('', '跨域', '广东'))).toBe(false)
  })
  it('keeps an explicit result count outside the literal business expression', () => {
    const plan = compileQueryPlan('查找必须同时包含跨域和副卡解绑的工单，只需1条。', ['跨域', '副卡解绑', '需', '工单'])
    expect(evaluateQuery(plan.keyword, doc('副卡解绑', '跨域办理失败'))).toBe(true)
    expect(evaluateQuery(plan.keyword, doc('副卡解绑', '本地办理失败'))).toBe(false)
  })
  it('retrieves a named ticket without requiring retrieval instructions in its business text', () => {
    const query = '请找工单 ESFT-SUMMARY-TRAIN-013309，核对原始对话后给出该工单的确认结果。'
    const plan = compileQueryPlan(query, ['请', 'ESFT', 'SUMMARY', 'TRAIN', '核对', '原始', '对话', '给出'])
    const ticket: QueryDocument = { texts: { body: ['客户咨询跨域副卡解绑。'] }, fields: { displayId: 'ESFT-SUMMARY-TRAIN-013309' } }
    expect(evaluateQuery(plan.keyword, ticket)).toBe(true)
    expect(evaluateQuery(plan.keyword, { ...ticket, fields: { displayId: 'ESFT-SUMMARY-TRAIN-013310' } })).toBe(false)
    expect(plan.vector.text).toBe(query)
    // Explicit business requirements and quoted source text still constrain the named ticket.
    const constrained = compileQueryPlan('请找工单 ESFT-SUMMARY-TRAIN-013309，正文包含“确认结果”', ['请', '确认结果'])
    expect(evaluateQuery(constrained.keyword, ticket)).toBe(false)
    const topic = compileQueryPlan('请找宽带工单 ESFT-SUMMARY-TRAIN-013309，读取原始对话', ['请', '宽带', '读取', '原始', '对话'])
    expect(evaluateQuery(topic.keyword, ticket)).toBe(false)
  })
  it('preserves explicit include and exclude regions in a workbench supplement', () => {
    for (const query of ['只看上海，排除北京工单', '排除北京工单，继续只看上海']) {
      const conditions = compileUserConditions(query, [], new Date('2026-09-08T00:00:00Z'), 'Asia/Shanghai')
      expect(conditions.ambiguities).toEqual([])
      expect(conditions.filters).toEqual(expect.arrayContaining([{ field: 'region', op: 'eq', value: '上海' }, { field: 'region', op: 'neq', value: '北京' }]))
    }
    expect(compileUserConditions('上海或北京工单', [], new Date(), 'Asia/Shanghai').ambiguities).toHaveLength(2)
    expect(compileUserConditions('只看上海或排除北京工单', [], new Date(), 'Asia/Shanghai').ambiguities).toHaveLength(2)
  })
  it('keeps the real workbench request for only one ticket as an explicit target', async () => {
    const query = '查找摘要包含“手厅暂不支持”的跨域主副卡解绑工单，只需1条。请读取原始对话确认业务情况，短语只要求在摘要中出现，不要求对话逐字相同。'
    const request = await buildPlannedTicketRequest(query, { parse: async input => compileQueryPlan(input.query, ['跨域', '主副卡', '解绑', '手厅'], input) }, { fields: [], now: new Date('2026-09-08T00:00:00Z'), timeZone: 'Asia/Shanghai' })
    expect(request).toMatchObject({ countPolicy: 'explicit', requestedCount: 1, queryContract: { resultPolicy: 'explicit_top_k', resultLimit: 1 } })
  })
  it('accepts an engine-neutral parser without an NLP token schema', async () => {
    const request = await buildPlannedTicketRequest('副卡 AND 跨域', { parse: async input => compileQueryPlan(input.query, ['副卡', '跨域'], input) }, {
      now: new Date('2026-09-07T00:00:00Z'), timeZone: 'Asia/Shanghai', fields: [],
    })
    expect(request.queryContract?.schemaVersion).toBe(9)
    expect(request.queryContract?.nlp).toBeUndefined()
    expect(() => assertTicketRetrievalRequest(request)).not.toThrow()
  })
  it('preserves branch scope, cross-field conjunction, and the exact vector input', () => {
    const query = '上海的副卡问题，或广东的宽带问题'
    const plan = compileQueryPlan(query, ['副卡', '宽带'])
    expect(evaluateQuery(plan.keyword, doc('副卡', '问题', '上海'))).toBe(true)
    expect(evaluateQuery(plan.keyword, doc('副卡', '问题', '广东'))).toBe(false)
    expect(evaluateQuery(plan.keyword, doc('宽带', '问题', '广东'))).toBe(true)
    expect(plan.vector.text).toBe(query)
    for (const requirement of plan.requirements) expect(query.slice(requirement.span.start, requirement.span.end)).toBe(requirement.span.text)
  })
  it('preserves parentheses and literal NOT without joining field boundaries', () => {
    const plan = compileQueryPlan('(副卡 AND 跨域) OR (宽带 AND NOT 测试单)', ['副卡', '跨域', '宽带', '测试单'])
    expect(evaluateQuery(plan.keyword, doc('副卡', '跨域'))).toBe(true)
    expect(evaluateQuery(plan.keyword, doc('宽带', '测试单'))).toBe(false)
    const phrase = compileQueryPlan('只要正文包含“跨域融合”、且不出现“测试单”的', [])
    expect(evaluateQuery(phrase.keyword, doc('跨域', '融合'))).toBe(false)
    expect(evaluateQuery(phrase.keyword, doc('', '跨域融合'))).toBe(true)
  })
  it('keeps semantic cause exclusions for evidence review, not literal NOT', () => {
    const plan = compileQueryPlan('找副卡不能上网，排除欠费导致的', ['副卡', '上网', '欠费'])
    expect(evaluateQuery(plan.keyword, doc('副卡', '已缴清欠费仍不能上网'))).toBe(true)
    expect(plan.requirements.some(r => r.kind === 'semantic' && r.status === 'evidence_required')).toBe(true)
  })
  it('does not admit unknown fields through negation and supports explicit null queries', () => {
    expect(evaluateQuery({ kind: 'not', child: { kind: 'field', field: 'region', op: 'eq', values: ['上海'] } }, doc('', ''))).toBeNull()
    expect(evaluateQuery({ kind: 'not', child: { kind: 'field', field: 'status', op: 'exists' } }, doc('', ''))).toBe(true)
  })
  it('anchors relative dates and does not split a conjunction character inside a word', () => {
    const plan = compileQueryPlan('上个月创建的上海宽带工单', ['宽带'], { now: new Date('2026-09-07T00:00:00Z'), timeZone: 'Asia/Shanghai' })
    expect(evaluateQuery(plan.keyword, { texts: { body: ['宽带'] }, fields: { region: '上海', createdAt: '2026-08-15T00:00:00.000Z' } })).toBe(true)
    expect(evaluateQuery(plan.keyword, { texts: { body: ['宽带'] }, fields: { region: '上海', createdAt: '2026-09-01T00:00:00.000Z' } })).toBe(false)
    const word = compileQueryPlan('呼和浩特宽带', ['呼和浩特', '宽带'])
    expect(evaluateQuery(word.keyword, doc('呼和浩特', '宽带'))).toBe(true)
  })
})
