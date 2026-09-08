import { describe, expect, it } from 'vitest'
import { compileSql } from './sql.js'
import { fieldCapabilities, ticketChunks } from './projection.js'
import { normalizeFixtureTicket } from '@retrieval-agent/provider-local'
const fields = fieldCapabilities([])
describe('SQL compiler boundary', () => {
  it('binds SQL-looking input and preserves scalar NULL under NOT', () => {
    const value = "上海' OR 1=1 --"
    const result = compileSql({ kind: 'not', child: { kind: 'field', field: 'region', op: 'eq', values: [value] } }, fields)
    expect(result.sql).not.toContain(value)
    expect(result.params).toEqual([value.toLowerCase(), 'region'])
    expect(result.sql).toContain('SELECT MAX(')
  })
  it('rejects identifiers outside source capabilities', () => {
    expect(() => compileSql({ kind: 'field', field: 'password', op: 'eq', values: ['secret'] }, fields)).toThrow('Unsupported')
  })
  it('keeps Unicode literal characters, percent and underscore as substring data', () => {
    const plan = compileSql({ kind: 'literal', op: 'contains', text: 'Ａ%_\\' }, [{ key: 'body', searchable: true, operations: ['contains'], availability: 'available', origin: 'source', source: 'fixture' }])
    expect(plan.sql).toContain('LOCATE(')
    expect(plan.params).toEqual(['a%_\\'])
  })
  it('preserves every tail and source offset in long fields', () => {
    const body = '正文🧪'.repeat(300)
    const record = normalizeFixtureTicket({ ticketId: 'long', displayId: 'long', tenantId: 'demo', allowedSubjectIds: [], requiredAttributes: {}, sourceVersion: 'v1', title: 'test', summary: 'summary', problemDescription: body, conversationOrUpdates: [], resolutionSteps: [], errorCodes: [], piiRedactionStatus: 'not_applicable' })
    const chunks = ticketChunks(record, 100).filter(c => c.field === 'problemDescription')
    expect(chunks.map(c => c.text).join('')).toBe(body)
    for (const c of chunks) expect(body.slice(c.start, c.end)).toBe(c.text)
  })
})
