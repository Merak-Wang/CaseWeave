import { describe, expect, it } from 'vitest'
import { compileUserConditions } from './conditions.js'

const compile = (text: string) => compileUserConditions(text, [], new Date('2026-09-09T00:00:00Z'), 'Asia/Shanghai')

describe('user conditions versus quoted evidence', () => {
  it('does not turn a clarification example into an exclusion filter', () => {
    const result = compile('也包括用户身处异地产生的跨区域服务/营业厅办理场景(如c1跨域受理、c9用户不在北京)')
    expect(result.filters).toEqual([])
    expect(result.ambiguities).toEqual([])
  })
  it('treats removal as removal, not as a new inclusion of the mentioned city', () => {
    const result = compile('确认移除/放宽 region!=北京 约束,继续检索所有副卡+跨域工单')
    expect(result.filters).toEqual([])
    expect(result).toMatchObject({ removedFilterFields: ['region'] })
  })
  it('keeps direct user restrictions outside examples', () => {
    expect(compile('只看上海的副卡工单（例如 c9 用户不在北京）').filters)
      .toEqual([{ field: 'region', op: 'eq', value: '上海' }])
    expect(compile('排除北京的副卡工单').filters).toEqual([{ field: 'region', op: 'neq', value: '北京' }])
  })

  it.each(['北京', '深圳'])('applies the same geographic intent checks to NER mentions of %s', city => {
    const analyze = (query: string, mode: 'request' | 'supplement' = 'request') => compileUserConditions(query,
      [...query.matchAll(new RegExp(city, 'gu'))].map(match => ({ text: city, label: 'GPE', start: match.index, end: match.index + city.length })),
      new Date('2026-09-09T00:00:00Z'), 'Asia/Shanghai', { mode })
    expect(analyze(`查找用户不在${city}时副卡办理失败的工单`).filters).toEqual([])
    expect(analyze(`也包括${city}营业厅办理的情况`, 'supplement').filters).toEqual([])
    expect(analyze(`只看${city}的副卡工单`, 'supplement').filters).toEqual([{ field: 'region', op: 'eq', value: city }])
    expect(analyze(`排除${city}的副卡工单`).filters).toEqual([{ field: 'region', op: 'neq', value: city }])
    expect(analyze(`查找用户不在${city}时副卡办理失败的工单，只看${city}的工单`).filters)
      .toEqual([{ field: 'region', op: 'eq', value: city }])
  })
})
