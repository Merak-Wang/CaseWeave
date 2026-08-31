import {
  MODEL_SERVICE_PROTOCOL_VERSION,
  type EmbedInput,
  type ModelServiceReadyResponse,
  type RerankInput,
  type RetrievalModelGateway,
} from '@retrieval-agent/model-service-client'
import { HybridRankingEngine } from '@retrieval-agent/retrieval-ranking'

const DIMENSIONS = 32

function normalizedCharacterVector(text: string): readonly number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0)
  for (const character of text.normalize('NFKC').toLocaleLowerCase()) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || /\s/u.test(character)) continue
    vector[codePoint % DIMENSIONS]! += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (norm === 0) return [1, ...Array.from({ length: DIMENSIONS - 1 }, () => 0)]
  return vector.map(value => value / norm)
}

/** Deterministic in-process model boundary for tests that exercise the real Hybrid ranking pipeline. */
export class FakeModelGateway implements RetrievalModelGateway {
  ready(): Promise<ModelServiceReadyResponse> {
    return Promise.resolve({
      protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION,
      serviceVersion: 'fake-model-service-v1',
      ready: true,
      device: 'test',
      models: [{
        model: 'fake-embedding',
        revision: 'fake-revision-v1',
        kind: 'embedding',
        loaded: true,
        dtype: 'float32',
        device: 'test',
        maxTokens: 12_000,
        dimensions: DIMENSIONS,
        pooling: 'last_token',
        normalization: 'l2',
      }],
      limits: { maxBatchSize: 128, maxTotalTokens: 100_000, maxRerankCandidates: 100 },
    })
  }

  embed(input: EmbedInput): Promise<readonly (readonly number[])[]> {
    if (input.signal?.aborted === true) return Promise.reject(input.signal.reason ?? new Error('cancelled'))
    return Promise.resolve(input.texts.map(normalizedCharacterVector))
  }

  rerank(_input: RerankInput): Promise<readonly { readonly id: string; readonly rank: number; readonly score: number }[]> {
    return Promise.reject(new Error('FakeModelGateway does not enable reranking'))
  }
}

export function testHybridRanker(): HybridRankingEngine {
  return new HybridRankingEngine({
    gateway: new FakeModelGateway(),
    embeddingIdentity: { model: 'fake-embedding', revision: 'fake-revision-v1', dimensions: DIMENSIONS },
    minimumDenseScore: -1,
  })
}
