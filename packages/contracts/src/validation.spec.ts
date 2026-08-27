import { describe, expect, it } from 'vitest'
import { assertTicketFilter, assertTicketFilterField } from './validation.js'

describe('ticket filter runtime validation', () => {
  it('accepts only the operator family owned by each allowlisted field', () => {
    expect(() => assertTicketFilter({ field: 'status', op: 'eq', value: '已解决' })).not.toThrow()
    expect(() => assertTicketFilter({ field: 'createdAt', op: 'gte', value: '2026-08-01T00:00:00.000Z' })).not.toThrow()
    expect(() => assertTicketFilter({ field: 'errorCodes', op: 'contains', value: 'AUTH-1' })).not.toThrow()

    expect(() => assertTicketFilter({ field: 'status', op: 'gte', value: 'P1' } as never)).toThrow(/eq\/neq/u)
    expect(() => assertTicketFilter({ field: 'createdAt', op: 'eq', value: '2026-08-01' } as never)).toThrow(/gte\/lte/u)
    expect(() => assertTicketFilter({ field: 'errorCodes', op: 'eq', value: 'AUTH-1' } as never)).toThrow(/contains/u)
  })

  it('fails closed for malformed model-created filter values and fields', () => {
    expect(() => assertTicketFilter({ field: 'status', op: 'eq' } as never)).toThrow(/筛选值/u)
    expect(() => assertTicketFilter({ field: 'tenantId', op: 'eq', value: 'other' } as never)).toThrow(/不支持/u)
    expect(() => assertTicketFilter({ field: 'createdAt', op: 'gte', value: 'not-a-date' })).toThrow(/有效时间/u)
    expect(() => assertTicketFilterField(undefined)).toThrow(/不支持/u)
  })
})
