import { describe, expect, it } from 'vitest'
import { XlsxWriter } from './xlsx.js'
import { unpackXlsx, xlsxRows } from '../../../tests/xlsx-assertions.js'

async function workbook(headers: string[], rows: string[][]): Promise<Buffer> {
  const parts: Uint8Array[] = []
  const writer = await XlsxWriter.create(headers, async part => { parts.push(part) })
  for (const row of rows) await writer.addRow(row)
  await writer.finish()
  return Buffer.concat(parts)
}
describe('real XLSX workbook', () => {
  it('uses valid OOXML ZIP parts and preserves Unicode, long IDs, formula prefixes and literal escapes as text', async () => {
    const values = ['00123456789012345678901234567890', '中文😀<>&"', '第一行\r\n第二行\t末尾 ', '=HYPERLINK("https://invalid.example","x")', '+1', '-1', '@SUM(A1)', '_x0000_和_x005F_与_xABCD_', '\u0000\u000b']
    const bytes = await workbook(values.map((_, index) => 'column-' + index), [values])
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]))
    const files = unpackXlsx(bytes)
    expect(files.size).toBe(6)
    expect(files.get('xl/worksheets/sheet1.xml')).not.toContain('\u0000')
    expect(files.get('xl/_rels/workbook.xml.rels')).toContain('Target="worksheets/sheet1.xml"')
    expect(xlsxRows(bytes)).toEqual([values.map((_, index) => 'column-' + index), values])
  })
  it('covers columns after Z, header-only output and structural bounds without truncating', async () => {
    const headers = Array.from({ length: 32 }, (_, index) => 'h' + index)
    const bytes = await workbook(headers, [])
    expect(xlsxRows(bytes)).toEqual([headers])
    expect(unpackXlsx(bytes).get('xl/worksheets/sheet1.xml')).toContain('r="AF1"')
    await expect(workbook([], [])).rejects.toMatchObject({ code: 'EXPORT_LIMIT_EXCEEDED' })
    await expect(workbook(Array(16_385).fill('x'), [])).rejects.toMatchObject({ code: 'EXPORT_LIMIT_EXCEEDED' })
    await expect(workbook(['x'], [['x'.repeat(32_768)]])).rejects.toMatchObject({ code: 'EXPORT_LIMIT_EXCEEDED' })
    await expect(workbook(['x'], [['\ud800']])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(workbook(['x'], [['a', 'b']])).rejects.toThrow('width')
  })
})
