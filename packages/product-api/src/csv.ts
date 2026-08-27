/** Neutralize spreadsheet formula interpretation before RFC 4180 quoting. */
export function protectSpreadsheetCell(value: string): string {
  const normalized = value.replace(/\u0000/gu, '')
  return /^[\s]*[=+\-@\t\r]/u.test(normalized) ? `'${normalized}` : normalized
}
export function csvCell(value: string): string {
  const protectedValue = protectSpreadsheetCell(value)
  return `"${protectedValue.replace(/"/gu, '""')}"`
}

export function encodeCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (headers.length === 0) throw new TypeError('CSV headers must not be empty')
  for (const row of rows) if (row.length !== headers.length) throw new TypeError('CSV row width must match headers')
  return `\uFEFF${[headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}
