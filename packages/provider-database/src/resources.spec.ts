import { expect, it, vi } from 'vitest'
import { getDatabaseResources } from './resources.js'
vi.mock('./store.js', () => ({ TicketDatabase: class { migrate = async () => {}; close = vi.fn(async () => {}) } }))
vi.mock('./milvus.js', () => ({ MilvusClient: class {} }))
vi.mock('@retrieval-agent/model-service-client', () => ({ ModelServiceClient: class {} }))
it('normalized defaults share a single pool across host and Provider and close evicts it', async () => {
  const host = getDatabaseResources({}), provider = getDatabaseResources({ embeddingDimensions: 1024, modelDeadlineMs: 120000, embeddingModel: 'Qwen/Qwen3-Embedding-0.6B', modelBaseUrl: process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012' })
  expect(provider).toBe(host); await host.ready; await host.close()
  expect(getDatabaseResources({})).not.toBe(host)
})
