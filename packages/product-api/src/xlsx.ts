import { crc32 } from 'node:zlib'
import { RetrievalError } from '@retrieval-agent/contracts'

export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const MAX_ROWS = 1_048_576, MAX_COLUMNS = 16_384, MAX_CELL_CHARS = 32_767

function column(index: number): string {
  let label = ''
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label
  return label
}
/** ST_Xstring escaping represents XML-illegal controls; CR is an explicit character reference. */
function text(value: string): string {
  if (value.length > MAX_CELL_CHARS) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '文字单元格超过 XLSX 的 32767 字符限制；请改用 JSONL 导出完整字段。')
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point >= 0xd800 && point <= 0xdfff) throw new RetrievalError('INVALID_REQUEST', 'XLSX 文字含不完整的 Unicode 字符。')
  }
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu,
      character => `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
    .replace(/[&<>]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!)
    .replace(/\r/gu, '&#13;')
}

// Split literal escape-looking text across rich-text runs so Excel and readers preserve it verbatim.
function inlineString(value: string): string {
  if (value.length > MAX_CELL_CHARS) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', '文字单元格超过 XLSX 的 32767 字符限制；请改用 JSONL 导出完整字段。')
  const parts = value.split(/(?<=_)(?=x[0-9a-f]{4}_)/giu)
  const encoded = parts.map(part => `<t xml:space="preserve">${text(part)}</t>`)
  return parts.length === 1 ? encoded[0]! : encoded.map(part => `<r>${part}</r>`).join('')
}

interface ZipEntry { name: Buffer; offset: number; crc: number; size: number }
/** Narrow, dependency-free ZIP STORE writer with data descriptors and a central directory. */
class ZipWriter {
  private offset = 0
  private entries: ZipEntry[] = []
  private active: ZipEntry | undefined
  constructor(readonly write: (bytes: Uint8Array) => Promise<void>) {}
  private async emit(bytes: Buffer) { await this.write(bytes); this.offset += bytes.length }
  async begin(name: string): Promise<void> {
    if (this.active) throw new Error('ZIP entry is still open')
    const entry: ZipEntry = { name: Buffer.from(name, 'utf8'), offset: this.offset, crc: 0, size: 0 }
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0808, 6)
    header.writeUInt16LE(33, 12); header.writeUInt16LE(entry.name.length, 26)
    await this.emit(header); await this.emit(entry.name); this.active = entry
  }
  async data(value: string): Promise<void> {
    if (!this.active) throw new Error('ZIP entry is not open')
    const bytes = Buffer.from(value, 'utf8')
    this.active.crc = crc32(bytes, this.active.crc); this.active.size += bytes.length
    if (this.active.size > 0xffffffff) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', 'XLSX 分块超过 ZIP 大小限制。')
    await this.emit(bytes)
  }
  async end(): Promise<void> {
    if (!this.active) throw new Error('ZIP entry is not open')
    const footer = Buffer.alloc(16)
    footer.writeUInt32LE(0x08074b50); footer.writeUInt32LE(this.active.crc, 4)
    footer.writeUInt32LE(this.active.size, 8); footer.writeUInt32LE(this.active.size, 12)
    await this.emit(footer); this.entries.push(this.active); this.active = undefined
  }
  async file(name: string, value: string) { await this.begin(name); await this.data(value); await this.end() }
  async finish(): Promise<void> {
    if (this.active) throw new Error('ZIP entry is still open')
    const start = this.offset
    for (const entry of this.entries) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6)
      header.writeUInt16LE(0x0808, 8); header.writeUInt16LE(33, 14); header.writeUInt32LE(entry.crc, 16)
      header.writeUInt32LE(entry.size, 20); header.writeUInt32LE(entry.size, 24)
      header.writeUInt16LE(entry.name.length, 28); header.writeUInt32LE(entry.offset, 42)
      await this.emit(header); await this.emit(entry.name)
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(this.offset - start, 12); end.writeUInt32LE(start, 16); await this.emit(end)
  }
}

/** One worksheet, every cell inline text; no formulas, numeric coercion, macros or external links. */
export class XlsxWriter {
  private readonly zip: ZipWriter
  private rows = 0
  private closed = false
  private constructor(readonly headers: readonly string[], write: (bytes: Uint8Array) => Promise<void>) { this.zip = new ZipWriter(write) }
  static async create(headers: readonly string[], write: (bytes: Uint8Array) => Promise<void>): Promise<XlsxWriter> {
    if (!headers.length || headers.length > MAX_COLUMNS) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', 'XLSX 列数超出范围。')
    const writer = new XlsxWriter(headers, write), zip = writer.zip
    await zip.file('[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>')
    await zip.file('_rels/.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    await zip.file('xl/workbook.xml', XML + `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Confirmed tickets" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    await zip.file('xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
    await zip.file('xl/styles.xml', XML + `<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
    await zip.begin('xl/worksheets/sheet1.xml')
    await zip.data(XML + `<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultColWidth="22" defaultRowHeight="15"/><sheetData>`)
    await writer.addRow(headers)
    return writer
  }
  async addRow(values: readonly string[]): Promise<void> {
    if (this.closed) throw new Error('XLSX writer is closed')
    if (values.length !== this.headers.length) throw new TypeError('XLSX row width must match headers')
    if (this.rows >= MAX_ROWS) throw new RetrievalError('EXPORT_LIMIT_EXCEEDED', 'XLSX 超过 1048576 行限制；请改用 JSONL。')
    const row = this.rows + 1
    // Explicit inlineStr prevents =/+/-/@ prefixes and long numeric IDs from becoming formulas/numbers.
    const cells = values.map((value, index) => `<c r="${column(index)}${row}" t="inlineStr" s="${row === 1 ? 1 : 0}"><is>${inlineString(value)}</is></c>`).join('')
    await this.zip.data(`<row r="${row}">${cells}</row>`); this.rows = row
  }
  async finish(): Promise<void> {
    if (this.closed) throw new Error('XLSX writer is closed')
    await this.zip.data(`</sheetData><autoFilter ref="A1:${column(this.headers.length - 1)}${this.rows}"/></worksheet>`)
    await this.zip.end(); await this.zip.finish(); this.closed = true
  }
}
