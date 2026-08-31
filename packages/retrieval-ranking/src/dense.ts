import { performance } from 'node:perf_hooks'
import type { RetrievalModelGateway } from '@retrieval-agent/model-service-client'
import type { DenseHit } from './fusion.js'
import type { RankingDocument } from './types.js'
import { loadVectorCache, publishVectorCache, type VectorCacheIdentity } from './vector-cache.js'

export const DENSE_RANKING_VERSION = 'exact-cosine-v1' as const
export const DENSE_PROJECTION_VERSION = 'ticket-search-projection-v1' as const

export interface DenseRankingOptions {
  readonly gateway: RetrievalModelGateway
  readonly cacheDir?: string
  readonly instruction: string
  readonly batchSize?: number
  readonly minimumScore?: number
  readonly deadlineMs?: number
}

export interface DenseSearchResult {
  readonly hits: readonly DenseHit[]
  readonly elapsedMs: number
  readonly model: string
  readonly revision: string
  readonly dimensions: number
}

export interface DensePreparationResult {
  readonly documentCount: number
  readonly model: string
  readonly revision: string
  readonly dimensions: number
  readonly elapsedMs: number
}

interface PreparedCorpus {
  readonly rows: ReadonlyMap<string, { readonly row: number; readonly contentHash: string }>
  readonly vectors: Promise<{ readonly vectors: Float32Array; readonly identity: VectorCacheIdentity }>
}

function projection(document: RankingDocument): string {
  return [
    `title: ${document.title}`,
    `summary: ${document.summary}`,
    document.body.length === 0 ? '' : `evidence: ${document.body}`,
    document.metadata.length === 0 ? '' : `metadata: ${document.metadata}`,
  ].filter(Boolean).join('\n').slice(0, 12_000)
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('cancelled'))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
  })
}

/** Exact dense ranker with normalized Float32 cache and cancellation-safe single-flight builds. */
export class DenseRanker {
  readonly #gateway: RetrievalModelGateway
  readonly #cacheDir: string | undefined
  readonly #instruction: string
  readonly #batchSize: number
  readonly #minimumScore: number
  readonly #deadlineMs: number
  readonly #builds = new Map<string, Promise<{ readonly vectors: Float32Array; readonly identity: VectorCacheIdentity }>>()
  #preparedCorpus: PreparedCorpus | undefined

  constructor(options: DenseRankingOptions) {
    this.#gateway = options.gateway
    this.#cacheDir = options.cacheDir
    this.#instruction = options.instruction
    this.#batchSize = options.batchSize ?? 16
    this.#minimumScore = options.minimumScore ?? 0.1
    this.#deadlineMs = options.deadlineMs ?? 120_000
  }

  /** Load or build the immutable document matrix before the first user query. */
  async prepare(documents: readonly RankingDocument[], signal?: AbortSignal): Promise<DensePreparationResult> {
    const started = performance.now()
    const rows = new Map<string, { readonly row: number; readonly contentHash: string }>()
    for (const [row, document] of documents.entries()) {
      if (rows.has(document.id)) throw new TypeError(`duplicate ranking document id ${document.id}`)
      rows.set(document.id, { row, contentHash: document.contentHash })
    }
    const vectors = this.#preparedVectors(documents, signal)
    const corpus = { rows, vectors }
    this.#preparedCorpus = corpus
    let identity: VectorCacheIdentity
    try {
      ({ identity } = await vectors)
    } catch (error) {
      if (this.#preparedCorpus === corpus) this.#preparedCorpus = undefined
      throw error
    }
    return {
      documentCount: documents.length,
      model: identity.model,
      revision: identity.revision,
      dimensions: identity.dimensions,
      elapsedMs: Math.max(0, performance.now() - started),
    }
  }

  async search(documents: readonly RankingDocument[], query: string, signal?: AbortSignal): Promise<DenseSearchResult> {
    const started = performance.now()
    const prepared = await this.#vectorsForSearch(documents, signal)
    const { identity, vectors } = prepared
    const [queryVector] = await this.#gateway.embed({
      texts: [query], inputType: 'query', instruction: this.#instruction, deadlineMs: this.#deadlineMs,
      ...(signal === undefined ? {} : { signal }),
    })
    if (queryVector === undefined || queryVector.length !== identity.dimensions) throw new Error('query embedding dimensions changed')
    const hits = documents.flatMap((document, index) => {
      const row = prepared.rows[index]!
      let score = 0
      for (let column = 0; column < identity.dimensions; column += 1) {
        score += vectors[row * identity.dimensions + column]! * queryVector[column]!
      }
      return Number.isFinite(score) && score >= this.#minimumScore ? [{ documentId: document.id, score }] : []
    })
      .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
      .map((hit, index) => ({ ...hit, rank: index + 1 }))
    return {
      hits,
      elapsedMs: Math.max(0, performance.now() - started),
      model: identity.model,
      revision: identity.revision,
      dimensions: identity.dimensions,
    }
  }

  async #vectorsForSearch(
    documents: readonly RankingDocument[],
    signal?: AbortSignal,
  ): Promise<{
      readonly vectors: Float32Array
      readonly identity: VectorCacheIdentity
      readonly rows: readonly number[]
    }> {
    const corpus = this.#preparedCorpus
    if (corpus !== undefined) {
      const rows = documents.map(document => {
        const admitted = corpus.rows.get(document.id)
        return admitted?.contentHash === document.contentHash ? admitted.row : undefined
      })
      if (rows.every((row): row is number => row !== undefined)) {
        return { ...await waitFor(corpus.vectors, signal), rows }
      }
    }
    const prepared = await this.#preparedVectors(documents, signal)
    return { ...prepared, rows: documents.map((_document, row) => row) }
  }

  async #preparedVectors(
    documents: readonly RankingDocument[],
    signal?: AbortSignal,
  ): Promise<{ readonly vectors: Float32Array; readonly identity: VectorCacheIdentity }> {
    const ready = await this.#gateway.ready(signal)
    const model = ready.models.find(item => item.kind === 'embedding' && item.loaded)
    if (model?.dimensions === undefined) throw new Error('embedding model is not ready')
    const identity: VectorCacheIdentity = {
      model: model.model,
      revision: model.revision,
      dimensions: model.dimensions,
      projectionVersion: DENSE_PROJECTION_VERSION,
      documents: documents.map(document => ({ id: document.id, contentHash: document.contentHash })),
    }
    const key = JSON.stringify(identity)
    let build = this.#builds.get(key)
    if (build === undefined) {
      build = this.#vectors(documents, identity).catch(error => {
        this.#builds.delete(key)
        throw error
      })
      this.#builds.set(key, build)
    }
    return await waitFor(build, signal)
  }

  async #vectors(documents: readonly RankingDocument[], identity: VectorCacheIdentity): Promise<{ readonly vectors: Float32Array; readonly identity: VectorCacheIdentity }> {
    const cached = this.#cacheDir === undefined ? undefined : await loadVectorCache(this.#cacheDir, identity)
    if (cached !== undefined) return { vectors: cached, identity }
    const vectors = new Float32Array(documents.length * identity.dimensions)
    for (let offset = 0; offset < documents.length; offset += this.#batchSize) {
      const batch = documents.slice(offset, offset + this.#batchSize)
      const embedded = await this.#gateway.embed({
        texts: batch.map(projection), inputType: 'document', deadlineMs: this.#deadlineMs,
      })
      if (embedded.length !== batch.length) throw new Error('document embedding row count changed')
      embedded.forEach((vector, index) => {
        if (vector.length !== identity.dimensions) throw new Error('document embedding dimensions changed')
        vectors.set(vector, (offset + index) * identity.dimensions)
      })
    }
    if (this.#cacheDir !== undefined) await publishVectorCache(this.#cacheDir, identity, vectors)
    return { vectors, identity }
  }
}
