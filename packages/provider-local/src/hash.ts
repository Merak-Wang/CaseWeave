import { createHash } from 'node:crypto'

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`
}

export function shortOpaque(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${sha256(parts.join('\u0000')).slice(0, 32)}`
}
