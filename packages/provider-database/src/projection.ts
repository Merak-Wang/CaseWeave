import { normalizeLiteral, type NormalizedTicketRecord, type QueryFieldCapability } from '@retrieval-agent/contracts'
import { sha256, LEGACY_FIELD_CATALOG } from '@retrieval-agent/provider-local'

export { queryDocument } from '@retrieval-agent/provider-local'
import { queryDocument } from '@retrieval-agent/provider-local'

export function fieldCapabilities(records: readonly NormalizedTicketRecord[]): QueryFieldCapability[] {
  const documents = records.map(queryDocument)
  const keys = new Set([...LEGACY_FIELD_CATALOG.map(f => f.key), ...documents.flatMap(d => [...Object.keys(d.fields), ...Object.keys(d.texts)])])
  return [...keys].sort().map(key => {
    const searchable = documents.some(d => key in d.texts)
    const count = documents.filter(d => d.fields[key] != null || (d.texts[key]?.length ?? 0) > 0).length
    const generated = records.some(r => r.rawSource?.datasetId === 'deepseek-ai/ESFT') && ['title', 'product', 'category', 'type', 'priority'].includes(key)
    return { key, searchable, operations: ['eq', 'in', 'range', 'exists', ...(searchable ? ['contains', 'phrase'] as const : [])],
      availability: count === 0 ? 'unavailable' : count === records.length ? 'available' : 'partial',
      origin: generated ? 'generated' : 'source', source: generated ? `data/manifest.json#generatedFieldPolicy.${key}` : `normalized.${key}` }
  })
}

export interface TicketChunk { id: string; ticketId: string; sourceVersion: string; contentHash: string; field: string; part: number; start: number; end: number; text: string; textHash: string }
export function ticketChunks(record: NormalizedTicketRecord, maxChars = 360): TicketChunk[] {
  const doc = queryDocument(record)
  const rawDialogue = record.rawSource?.payload.raw_dialogue
  const dialogue = Array.isArray(rawDialogue) ? rawDialogue.flatMap(turn => {
    if (typeof turn === 'object' && turn !== null && 'text' in turn && typeof turn.text === 'string') return [turn.text]
    return []
  }) : []
  // ESFT problem_description is derived from customer turns already present in raw_dialogue.
  // Index summary + complete source dialogue once; SQL continues to search every original field.
  const views = dialogue.length ? { summary: [record.summary], 'source.raw_dialogue': [dialogue.join('\n')] } : doc.texts
  const seen = new Set<string>(); const chunks: TicketChunk[] = []
  for (const [field, sourceValues] of Object.entries(views)) {
    if (field.startsWith('metadata.') || field === 'title') continue
    // Pack short dialogue/source values into one versioned field view for embeddings.
    // Keyword evaluation continues to use independent values and cannot bridge them.
    const values = field === 'body' ? [sourceValues.join('\n')] : sourceValues
    for (const [part, text] of values.entries()) {
      if (seen.has(text)) continue
      seen.add(text)
      // Keep every character, including the tail; no embedding prefix truncation.
      const points = Array.from(text); let start = 0
      for (let i = 0; i < points.length; i += maxChars) {
        const content = points.slice(i, i + maxChars).join(''); const end = start + content.length
        chunks.push({ id: sha256(JSON.stringify([record.ticketId, record.contentHash, field, part, start, end])), ticketId: record.ticketId,
          sourceVersion: record.sourceVersion, contentHash: record.contentHash, field, part, start, end, text: content, textHash: sha256(content) })
        start = end
      }
    }
  }
  return chunks
}
export function grams(text: string): string[] {
  const points = Array.from(normalizeLiteral(text)); const result = new Set<string>()
  for (let i = 0; i < points.length - 1; i++) result.add(points[i]! + points[i + 1]!)
  return [...result]
}
