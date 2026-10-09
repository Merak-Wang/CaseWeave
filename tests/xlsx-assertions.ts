import { crc32 } from 'node:zlib'

/** Test reader uses the central directory and verifies every CRC/size/offset/descriptor. */
export function unpackXlsx(data: Uint8Array): Map<string, string> {
  const bytes = Buffer.from(data), end = bytes.length - 22
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('ZIP end missing')
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt32LE(end + 12) !== end - start) throw new Error('ZIP directory size mismatch')
  const files = new Map<string, string>(); let offset = start
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt16LE(offset + 10) !== 0) throw new Error('Unsupported ZIP entry')
    const crc = bytes.readUInt32LE(offset + 16), size = bytes.readUInt32LE(offset + 20)
    const length = bytes.readUInt16LE(offset + 28), local = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8')
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== 0 || bytes.readUInt16LE(local + 6) !== 0x0808) throw new Error('ZIP local header mismatch')
    const bodyStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const content = bytes.subarray(bodyStart, bodyStart + size), descriptor = bodyStart + size
    if (crc32(content) !== crc || bytes.readUInt32LE(descriptor) !== 0x08074b50 || bytes.readUInt32LE(descriptor + 4) !== crc
      || bytes.readUInt32LE(descriptor + 8) !== size || bytes.readUInt32LE(descriptor + 12) !== size) throw new Error('ZIP CRC or descriptor mismatch')
    if (files.has(name)) throw new Error('ZIP duplicate entry')
    files.set(name, content.toString('utf8'))
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
  }
  if (offset !== end) throw new Error('ZIP directory not exhausted')
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    if (!files.has(name)) throw new Error('Missing OOXML part: ' + name)
  }
  return files
}
export function xlsxRows(bytes: Uint8Array): string[][] {
  const sheet = unpackXlsx(bytes).get('xl/worksheets/sheet1.xml')!
  if (/<f(?:\s|>)/u.test(sheet)) throw new Error('Workbook contains a formula')
  return [...sheet.matchAll(/<row\b[^>]*>(.*?)<\/row>/gsu)].map(row =>
    [...row[1]!.matchAll(/<c\b([^>]*)>(.*?)<\/c>/gsu)].map(cell => {
      if (!cell[1]!.includes('t="inlineStr"')) throw new Error('Workbook cell is not text')
      return [...cell[2]!.matchAll(/<t\b[^>]*>(.*?)<\/t>/gsu)].map(part => part[1]!
        .replace(/&(?:amp|lt|gt|#13);/gu, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#13;': '\r' })[entity]!)
        .replace(/_x([0-9a-f]{4})_/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))).join('')
    }))
}
