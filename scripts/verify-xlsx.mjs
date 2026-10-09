import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { XlsxWriter } from '../packages/product-api/lib/xlsx.js'

// Synthetic export QA only. No database, model, credentials or business records.
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const python = option('--python', 'python'), output = resolve(option('--out', '.cache/xlsx-qa'))
if (args.some((arg, index) => index % 2 === 0 && !['--python', '--out'].includes(arg)) || !python) throw new Error('Usage: node scripts/verify-xlsx.mjs [--python executable] [--out directory]')
const values = ['00123456789012345678901234567890', '中文😀<>&"', '第一行\r\n第二行\t末尾 ', '=HYPERLINK("https://invalid.example","x")', '+1', '-1', '@SUM(A1)', '_x0000_和_x005F_与_xABCD_', '']
const headers = values.map((_, index) => 'column-' + index), chunks = []
const writer = await XlsxWriter.create(headers, async chunk => { chunks.push(chunk) })
await writer.addRow(values); await writer.finish()
const bytes = Buffer.concat(chunks), filename = join(output, 'synthetic.xlsx')
await mkdir(output, { recursive: true }); await writeFile(filename, bytes)
const script = `import json, sys, zipfile, xml.etree.ElementTree as ET
import openpyxl
spec=json.load(sys.stdin)
with zipfile.ZipFile(spec['filename']) as archive:
    assert archive.testzip() is None, 'ZIP CRC failure'
    for name in archive.namelist():
        ET.fromstring(archive.read(name))
    assert not any('externalLink' in name or 'vba' in name for name in archive.namelist())
workbook=openpyxl.load_workbook(spec['filename'], data_only=False)
sheet=workbook.active
rows=list(sheet.iter_rows())
assert sheet.title=='Confirmed tickets'
assert sheet.freeze_panes=='A2'
assert sheet.max_row==2 and sheet.max_column==len(spec['values'])
assert [[cell.value for cell in row] for row in rows]==[spec['headers'],spec['values']]
assert all(cell.data_type=='s' and cell.number_format=='@' for row in rows for cell in row)
assert sheet.auto_filter.ref=='A1:I2'
print(json.dumps({'reader':'openpyxl','version':openpyxl.__version__,'dataRows':sheet.max_row-1,'columns':sheet.max_column,'allCellsText':True,'exactValues':True,'zipCrcVerified':True}))
`
const result = spawnSync(python, ['-X', 'utf8', '-c', script], { input: JSON.stringify({ filename, headers, values }), encoding: 'utf8', maxBuffer: 1000000 })
if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
const report = { ...JSON.parse(result.stdout), filename, byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
