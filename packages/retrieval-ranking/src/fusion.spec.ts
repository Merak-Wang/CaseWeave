import { describe, expect, it } from 'vitest'
import { weightedReciprocalRankFusion } from './fusion.js'

describe('weightedReciprocalRankFusion', () => {
  it('computes weighted RRF and keeps channel provenance', () => {
    const result = weightedReciprocalRankFusion(
      [{ documentId: 'lexical', rank: 1, score: 4 }, { documentId: 'both', rank: 2, score: 2 }],
      [{ documentId: 'semantic', rank: 1, score: 0.9 }, { documentId: 'both', rank: 2, score: 0.8 }],
      { rankConstant: 10, keywordWeight: 0.5, vectorWeight: 0.5 },
    )

    expect(result[0]).toMatchObject({ documentId: 'both', rank: 1, score: 1 / 12 })
    expect(result[0]!.channels.map(channel => channel.channel)).toEqual(['keyword', 'vector'])
    expect(result.map(hit => hit.documentId)).toEqual(['both', 'lexical', 'semantic'])
  })

  it('does not admit candidates from a zero-weight channel', () => {
    const result = weightedReciprocalRankFusion(
      [{ documentId: 'keyword', rank: 1, score: 1 }],
      [{ documentId: 'vector', rank: 1, score: 1 }],
      { keywordWeight: 1, vectorWeight: 0 },
    )

    expect(result.map(hit => hit.documentId)).toEqual(['keyword'])
  })

  it('rejects configurations with no contributing channel', () => {
    expect(() => weightedReciprocalRankFusion([], [], { keywordWeight: 0, vectorWeight: 0 })).toThrow(TypeError)
  })
})
