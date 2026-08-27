import { describe, expect, it } from 'vitest'
import { csvCell, encodeCsv, protectSpreadsheetCell } from './csv.js'

describe('CSV encoding', () => {
  it('neutralizes spreadsheet formulas after leading whitespace and strips NUL bytes', () => {
    expect(protectSpreadsheetCell('=1+1')).toBe("'=1+1")
    expect(protectSpreadsheetCell('  @SUM(A1:A2)')).toBe("'  @SUM(A1:A2)")
    expect(protectSpreadsheetCell('\t-cmd')).toBe("'\t-cmd")
    expect(protectSpreadsheetCell('safe\u0000value')).toBe('safevalue')
    expect(protectSpreadsheetCell('ordinary text')).toBe('ordinary text')
  })

  it('uses RFC 4180 quoting, a UTF-8 BOM, and CRLF rows', () => {
    expect(csvCell('a"b')).toBe('"a""b"')
    expect(encodeCsv(['name', 'value'], [['plain', '=unsafe'], ['line', 'a\nb']]))
      .toBe('\uFEFF"name","value"\r\n"plain","\'=unsafe"\r\n"line","a\nb"\r\n')
  })

  it('rejects rows that do not match the allowlisted header width', () => {
    expect(() => encodeCsv([], [])).toThrow(/headers/u)
    expect(() => encodeCsv(['one'], [['one', 'two']])).toThrow(/row width/u)
  })
})
