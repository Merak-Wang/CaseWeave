import { expect, it } from 'vitest'
import type { SemanticQueryPlan } from '@retrieval-agent/contracts'
import { operatorRequiredFields } from './evidence-requirements.js'

it('requires source evidence without inventing a conversation field, and preserves explicit field requirements', () => {
  const plan = (params: Record<string, unknown>) => ({ steps: [{ op: 'sem_filter', params }] }) as unknown as SemanticQueryPlan
  const catalog = [{ key: 'conversationOrUpdates', capability: { availability: 'unavailable' } },
    { key: 'problemDescription', capability: { availability: 'available' } }] as unknown as Parameters<typeof operatorRequiredFields>[1]
  expect(operatorRequiredFields(plan({ require_source: true }), catalog)).toEqual(['problemDescription'])
  expect(operatorRequiredFields(plan({ require_source: true, required_fields: ['source.raw_dialogue'] }))).toEqual(['source.raw_dialogue'])
})
