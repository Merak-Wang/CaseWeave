import { performance } from 'node:perf_hooks'
import { RANKING_TOKENIZER_VERSION, tokenizeRankingText } from './tokenize.js'
import type { RankingDocument } from './types.js'

export const BM25F_VERSION = `bm25f-v1:${RANKING_TOKENIZER_VERSION}` as const

export interface Bm25fOptions {
  readonly k1?: number
  readonly fields?: Readonly<Record<'title' | 'summary' | 'body' | 'metadata', { readonly weight: number; readonly b: number }>>
  readonly minimumScore?: number
}

export interface Bm25fHit {
  readonly documentId: string
  readonly rank: number
  readonly score: number
}

export interface Bm25fSearchResult {
  readonly hits: readonly Bm25fHit[]
  readonly elapsedMs: number
}

const DEFAULT_FIELDS = {
  title: { weight: 3, b: 0.2 },
  summary: { weight: 1.5, b: 0.65 },
  body: { weight: 1, b: 0.75 },
  metadata: { weight: 0.75, b: 0.3 },
} as const

type Field = keyof typeof DEFAULT_FIELDS
type TokenizedDocument = { readonly id: string; readonly fields: Readonly<Record<Field, readonly string[]>> }

function frequencies(tokens: readonly string[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1)
  return result
}

/** Small-corpus BM25F implementation; production-scale inverted indexing remains a Provider concern. */
export class Bm25fIndex {
  readonly #documents: readonly TokenizedDocument[]
  readonly #documentFrequency = new Map<string, number>()
  readonly #averageLengths: Readonly<Record<Field, number>>
  readonly #k1: number
  readonly #fields: Readonly<Record<Field, { readonly weight: number; readonly b: number }>>
  readonly #minimumScore: number

  constructor(documents: readonly RankingDocument[], options: Bm25fOptions = {}) {
    this.#k1 = options.k1 ?? 1.2
    this.#fields = options.fields ?? DEFAULT_FIELDS
    this.#minimumScore = options.minimumScore ?? 0
    this.#documents = documents.map(document => ({
      id: document.id,
      fields: {
        title: tokenizeRankingText(document.title),
        summary: tokenizeRankingText(document.summary),
        body: tokenizeRankingText(document.body),
        metadata: tokenizeRankingText(document.metadata),
      },
    }))
    const totals: Record<Field, number> = { title: 0, summary: 0, body: 0, metadata: 0 }
    for (const document of this.#documents) {
      const unique = new Set<string>()
      for (const field of Object.keys(DEFAULT_FIELDS) as Field[]) {
        totals[field] += document.fields[field].length
        document.fields[field].forEach(token => unique.add(token))
      }
      unique.forEach(token => this.#documentFrequency.set(token, (this.#documentFrequency.get(token) ?? 0) + 1))
    }
    const count = Math.max(1, this.#documents.length)
    this.#averageLengths = {
      title: totals.title / count,
      summary: totals.summary / count,
      body: totals.body / count,
      metadata: totals.metadata / count,
    }
    if (!(this.#k1 > 0) || Object.values(this.#fields).some(field => field.weight < 0 || field.b < 0 || field.b > 1)) {
      throw new TypeError('invalid BM25F configuration')
    }
  }

  search(query: string, excludedTerms: readonly string[] = []): Bm25fSearchResult {
    const started = performance.now()
    const terms = [...new Set(tokenizeRankingText(query))]
    const excluded = new Set(excludedTerms.flatMap(tokenizeRankingText))
    const hits = this.#documents.flatMap(document => {
      const perField = Object.fromEntries((Object.keys(DEFAULT_FIELDS) as Field[])
        .map(field => [field, frequencies(document.fields[field])])) as Record<Field, ReadonlyMap<string, number>>
      if ([...excluded].some(term => (Object.keys(DEFAULT_FIELDS) as Field[]).some(field => perField[field].has(term)))) return []
      let score = 0
      for (const term of terms) {
        const df = this.#documentFrequency.get(term) ?? 0
        if (df === 0) continue
        let weightedFrequency = 0
        for (const field of Object.keys(DEFAULT_FIELDS) as Field[]) {
          const tf = perField[field].get(term) ?? 0
          if (tf === 0) continue
          const length = document.fields[field].length
          const average = Math.max(1, this.#averageLengths[field])
          const normalization = 1 - this.#fields[field].b + this.#fields[field].b * length / average
          weightedFrequency += this.#fields[field].weight * tf / normalization
        }
        const idf = Math.log(1 + (this.#documents.length - df + 0.5) / (df + 0.5))
        score += idf * (this.#k1 + 1) * weightedFrequency / (this.#k1 + weightedFrequency)
      }
      return score > this.#minimumScore ? [{ documentId: document.id, score }] : []
    })
      .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
      .map((hit, index) => ({ ...hit, rank: index + 1 }))
    return { hits, elapsedMs: Math.max(0, performance.now() - started) }
  }
}
