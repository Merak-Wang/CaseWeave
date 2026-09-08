import { describe, expect, it } from 'vitest'
import { latestTicketCandidateNode } from './selection.js'

describe('latestTicketCandidateNode', () => {
  it('uses conversation order and ignores unrelated nodes', () => {
    const older = { retrievalId: 'r1', candidates: [] }
    const latest = { retrievalId: 'r2', candidates: [] }
    const nodes = new Map([
      ['a', { kind: 'ticket-candidates', data: older }],
      ['b', { kind: 'assistant', data: {} }],
      ['c', { kind: 'ticket-candidates', data: latest }],
    ])
    expect(latestTicketCandidateNode(['a', 'b', 'c'], nodes)).toBe(latest)
    expect(latestTicketCandidateNode(['b'], nodes)).toBeUndefined()
  })
})
