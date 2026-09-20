import { describe, expect, it } from 'vitest'
import { compileSql } from './sql.js'
import { fieldCapabilities, ticketChunks } from './projection.js'
import { normalizeFixtureTicket, normalizePublicSnapshotTicket } from '@retrieval-agent/provider-local'
const fields = fieldCapabilities([])
describe('SQL compiler boundary', () => {
  it('advertises source dialogue under the same name used by evidence reads', () => {
    const record = normalizePublicSnapshotTicket({ ticket_id: 'dialogue', source_dataset: 'deepseek-ai/ESFT', source_version: 'v1',
      source_kind: 'public_research_corpus', title: '定位标题', summary: '上游摘要', pii_redaction_status: 'redacted',
      raw_dialogue: [{ speaker: 'customer', text: '宽带尚未装好' }] },
    { tenantId: 'demo', allowedSubjectIds: [], requiredAttributes: {} })
    const fields = fieldCapabilities([record])
    expect(fields.find(f => f.key === 'source.raw_dialogue')).toMatchObject({ availability: 'available', searchable: true })
    expect(fields.find(f => f.key === 'conversationOrUpdates')).toMatchObject({ availability: 'unavailable' })
  })
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
