import type { Bm25fHit } from './bm25f.js'
import type { RankingChannelScore, RankingHit } from './types.js'

export const FUSION_VERSION = 'weighted-rrf-v1' as const

export interface DenseHit {
  readonly documentId: string
  readonly rank: number
  readonly score: number
}

export interface FusionOptions {
  readonly rankConstant?: number
  readonly keywordWeight?: number
  readonly vectorWeight?: number
}

/** Stable weighted reciprocal-rank fusion preserving per-channel evidence. */
export function weightedReciprocalRankFusion(
  keyword: readonly Bm25fHit[],
  vector: readonly DenseHit[],
  options: FusionOptions = {},
): RankingHit[] {
  const rankConstant = options.rankConstant ?? 60
  const keywordWeight = options.keywordWeight ?? 0.55
  const vectorWeight = options.vectorWeight ?? 0.45
  if (!(rankConstant > 0) || keywordWeight < 0 || vectorWeight < 0 || keywordWeight + vectorWeight <= 0) {
    throw new TypeError('invalid fusion configuration')
  }
  const rows = new Map<string, { score: number; channels: RankingChannelScore[] }>()
  for (const [channel, hits, weight] of [
    ['keyword', keyword, keywordWeight],
    ['vector', vector, vectorWeight],
  ] as const) {
    if (weight === 0) continue
    for (const hit of hits) {
      const row = rows.get(hit.documentId) ?? { score: 0, channels: [] }
      row.score += weight / (rankConstant + hit.rank)
      row.channels.push({ channel, rank: hit.rank, score: hit.score })
      rows.set(hit.documentId, row)
    }
  }
  return [...rows.entries()]
    .sort(([leftId, left], [rightId, right]) => right.score - left.score || leftId.localeCompare(rightId))
    .map(([documentId, row], index) => ({ documentId, rank: index + 1, score: row.score, channels: row.channels }))
}
