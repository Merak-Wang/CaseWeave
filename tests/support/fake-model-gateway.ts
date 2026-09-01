import type {
  RankingDocument,
  RankingHit,
  RankingQuery,
  RetrievalRanker,
} from '@retrieval-agent/retrieval-ranking'

const DIMENSIONS = 32

function normalizedCharacterVector(text: string): readonly number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0)
  for (const character of text.normalize('NFKC').toLocaleLowerCase()) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || /\s/u.test(character)) continue
    vector[codePoint % DIMENSIONS]! += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? [1, ...Array.from({ length: DIMENSIONS - 1 }, () => 0)] : vector.map(value => value / norm)
}

function text(document: RankingDocument): string {
  return `${document.title}\n${document.summary}\n${document.body}\n${document.metadata}`.normalize('NFKC').toLocaleLowerCase()
}

function lexicalTokens(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const tokens: string[] = []
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|(?:(?!\p{Script=Han})[\p{L}\p{N}])(?:(?!\p{Script=Han})[\p{L}\p{N}_.:/-])*/gu)) {
    if (/^\p{Script=Han}+$/u.test(match[0])) {
      const chars = [...match[0]]
      tokens.push(...chars)
      for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(`${chars[index]}${chars[index + 1]}`)
    } else tokens.push(match[0])
  }
  return tokens
}

function keywordEligible(document: RankingDocument, query: RankingQuery): boolean {
  const searchable = text(document)
  if (query.keywordQuery !== undefined) {
    const matches = query.keywordQuery.terms.map(term => searchable.includes(term.normalize('NFKC').toLocaleLowerCase()))
    return query.keywordQuery.operator === 'and' ? matches.every(Boolean) : matches.some(Boolean)
  }
  return query.requiredConcepts?.every(concept => concept.alternatives.some(term => searchable.includes(term.normalize('NFKC').toLocaleLowerCase()))) ?? true
}

function channelHits(documents: readonly RankingDocument[], query: RankingQuery, channel: 'keyword' | 'vector'): RankingHit[] {
  const queryText = channel === 'keyword' ? query.keywordQuery?.terms.join(' ') || query.text : query.semanticText ?? query.text
  const queryVector = normalizedCharacterVector(queryText)
  const rows = documents.map(document => {
    const score = channel === 'keyword'
      ? [...new Set(lexicalTokens(queryText))]
        .reduce((sum, token) => sum + (lexicalTokens(text(document)).includes(token) ? 1 : 0), 0)
      : normalizedCharacterVector(text(document)).reduce((sum, value, index) => sum + value * queryVector[index]!, 0)
    return { documentId: document.id, score }
  }).filter(hit => channel === 'vector' || hit.score > 0)
    .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
  return rows.map((hit, index) => ({
    ...hit, rank: index + 1,
    channels: [{ channel, rank: index + 1, score: hit.score }],
  }))
}

function fuse(keyword: readonly RankingHit[], vector: readonly RankingHit[]): RankingHit[] {
  const rows = new Map<string, { score: number; channels: RankingHit['channels'] }>()
  for (const [hits, weight] of [[keyword, 0.55], [vector, 0.45]] as const) {
    for (const hit of hits) {
      const row = rows.get(hit.documentId) ?? { score: 0, channels: [] }
      rows.set(hit.documentId, { score: row.score + weight / (60 + hit.rank), channels: [...row.channels, ...hit.channels] })
    }
  }
  return [...rows].map(([documentId, row]) => ({ documentId, ...row, rank: 0 }))
    .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
    .map((hit, index) => ({ ...hit, rank: index + 1 }))
}

/** In-process test double; production BM25F/dense/fusion lives only in Python. */
class TestHybridRanker implements RetrievalRanker {
  readonly profileVersion = 'test-hybrid-ranker-v1'
  readonly capabilities = { keyword: true as const, dense: true, fusion: true, reranker: false }

  prepare(documents: readonly RankingDocument[]): Promise<{ documentCount: number; model: string; revision: string; dimensions: number; elapsedMs: number }> {
    return Promise.resolve({ documentCount: documents.length, model: 'test-character-vector', revision: 'v1', dimensions: DIMENSIONS, elapsedMs: 0 })
  }

  rank(documents: readonly RankingDocument[], query: RankingQuery, options: { readonly maxScan: number; readonly signal?: AbortSignal }) {
    if (documents.length > options.maxScan) return Promise.reject(new Error('scan limit'))
    const allowed = documents.filter(document => !query.excludedTerms.some(term => text(document).includes(term.toLocaleLowerCase())))
    const keywordDocuments = allowed.filter(document => keywordEligible(document, query))
    let keyword = channelHits(keywordDocuments, query, 'keyword')
    if (query.keywordQuery !== undefined) {
      const known = new Set(keyword.map(hit => hit.documentId))
      keyword = [...keyword, ...keywordDocuments.filter(document => !known.has(document.id)).map((document, index) => ({
        documentId: document.id, rank: keyword.length + index + 1, score: 0,
        channels: [{ channel: 'keyword' as const, rank: keyword.length + index + 1, score: 0 }],
      }))]
    }
    const vector = channelHits(allowed, query, 'vector')
    const hits = query.mode === 'keyword' ? keyword : query.mode === 'dense' ? vector : fuse(keyword, vector)
    const channels = [
      ...(query.mode === 'dense' ? [] : [{ channel: 'keyword' as const, implementation: 'test_keyword', version: 'v1', resultCount: keyword.length, elapsedMs: 0, querySource: query.fastPath ? 'direct_user_keywords' as const : 'agent_rewrite' as const }]),
      ...(query.mode === 'keyword' ? [] : [{ channel: 'vector' as const, implementation: 'test_vector', version: 'v1', resultCount: vector.length, elapsedMs: 0, model: 'test-character-vector', revision: 'v1', dimensions: DIMENSIONS, querySource: query.fastPath ? 'direct_user_original' as const : 'agent_rewrite' as const }]),
    ]
    return Promise.resolve({
      hits,
      execution: {
        requestedMode: query.mode,
        executedMode: query.mode,
        strategyVersion: this.profileVersion,
        channels,
        ...(query.mode !== 'hybrid' ? {} : { fusion: { method: 'weighted_rrf' as const, version: 'test-v1', rankConstant: 60, keywordWeight: 0.55, vectorWeight: 0.45 } }),
      },
      scanned: allowed.length,
      keywordEligible: keywordDocuments.length,
      rankedHits: hits.length,
      warnings: [],
    })
  }
}

export function testHybridRanker(): RetrievalRanker {
  return new TestHybridRanker()
}
