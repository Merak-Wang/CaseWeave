import { describe, expect, it } from 'vitest'
import { parseExportCandidatesParams } from './index.js'

describe('DSH product Host export adapter', () => {
  it('accepts only the explicit wire contract', () => {
    expect(parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1'],
    })).toMatchObject({ sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: ['candidate-1'] })
    expect(() => parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: [], principal: { tenantId: 'attacker' },
    })).toThrow(/未知字段/u)
    expect(() => parseExportCandidatesParams({
      sessionId: 'session-1', retrievalId: 'retrieval-1', candidateRefs: Array.from({ length: 201 }, (_, index) => `ref-${index}`),
    })).toThrow(/候选引用/u)
  })
})
