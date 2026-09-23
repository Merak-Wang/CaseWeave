import { expect, it } from 'vitest'
import type { SemanticQueryPlan, TicketFieldDescriptor } from '@retrieval-agent/contracts'
import { operatorRequiredFields, sourceEvidenceFields } from './evidence-requirements.js'

it('requires source evidence without inventing a conversation field, and preserves explicit field requirements', () => {
  const plan = (params: Record<string, unknown>) => ({ steps: [{ op: 'sem_filter', params }] }) as unknown as SemanticQueryPlan
  const catalog = [{ key: 'conversationOrUpdates', accessLevel: 'L2', capability: { availability: 'unavailable', origin: 'source' } },
    { key: 'summary', accessLevel: 'L1', capability: { availability: 'available', origin: 'source' } },
    { key: 'generated_note', accessLevel: 'L2', capability: { availability: 'available', origin: 'generated' } },
    { key: 'problemDescription', accessLevel: 'L2', capability: { availability: 'available', origin: 'source' } }] as unknown as Parameters<typeof operatorRequiredFields>[1]
  expect(operatorRequiredFields(plan({ require_source: true }), catalog)).toEqual(['problemDescription'])
  expect(operatorRequiredFields(plan({ require_source: true, required_fields: ['source.raw_dialogue'] }))).toEqual(['source.raw_dialogue'])
})

it('keeps dialogue as the default source when a legacy catalog has no availability metadata', () => {
  const plan = { steps: [{ op: 'sem_filter', params: { require_source: true } }] } as unknown as SemanticQueryPlan
  const catalog: TicketFieldDescriptor[] = ['answer', 'conversationOrUpdates', 'problemDescription', 'source.raw_dialogue'].map(key => ({
    key, label: key, accessLevel: key === 'source.raw_dialogue' ? 'L3' : 'L2', valueKind: 'text',
    filterOperators: [], sensitivity: 'source_controlled',
  }))
  expect(operatorRequiredFields(plan, catalog)).toEqual(['conversationOrUpdates'])
  expect(operatorRequiredFields(plan, [...catalog].reverse())).toEqual(['conversationOrUpdates'])
})

it('offers only readable source fields to semantic planning', () => {
  const catalog = ([{ key: 'summary', accessLevel: 'L1', valueKind: 'text', capability: { availability: 'available', origin: 'source' } },
    { key: 'generated_note', accessLevel: 'L2', valueKind: 'text', capability: { availability: 'available', origin: 'generated' } },
    { key: 'source.raw_dialogue', accessLevel: 'L3', valueKind: 'text', capability: { availability: 'available', origin: 'source' } },
    { key: 'source.raw', accessLevel: 'L3', valueKind: 'raw_json', capability: { availability: 'available', origin: 'source' } },
    { key: 'conversationOrUpdates', accessLevel: 'L2', valueKind: 'text', capability: { availability: 'unavailable', origin: 'source' } }] as unknown as Parameters<typeof sourceEvidenceFields>[0])
  expect(sourceEvidenceFields(catalog).map(field => field.key)).toEqual(['source.raw_dialogue'])
})
