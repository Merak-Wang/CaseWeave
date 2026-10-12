import { ModelServiceClient } from '@retrieval-agent/model-service-client'
import { TicketDatabase } from './store.js'
import { MilvusClient } from './milvus.js'

export interface DatabaseResourceOptions {
  mysqlUrl?: string; milvusUrl?: string; milvusToken?: string | undefined; modelBaseUrl?: string
  embeddingModel?: string; embeddingRevision?: string | undefined; embeddingDimensions?: number; modelDeadlineMs?: number
}
export interface DatabaseResources { db: TicketDatabase; milvus: MilvusClient; model: ModelServiceClient; ready: Promise<void>; close(): Promise<void> }
const resources = new Map<string, DatabaseResources>()
/** Host和各数据集Provider共用连接与GPU客户端，避免每个任务新建连接池。 */
export function getDatabaseResources(options: DatabaseResourceOptions): DatabaseResources {
  options = { mysqlUrl: options.mysqlUrl ?? process.env.RETRIEVAL_AGENT_MYSQL_URL ?? 'mysql://root@127.0.0.1:13306/retrieval_agent',
    milvusUrl: options.milvusUrl ?? process.env.RETRIEVAL_AGENT_MILVUS_URL ?? 'http://127.0.0.1:19530', milvusToken: options.milvusToken ?? process.env.RETRIEVAL_AGENT_MILVUS_TOKEN,
    modelBaseUrl: options.modelBaseUrl ?? process.env.RETRIEVAL_AGENT_MODEL_SERVICE_URL ?? 'http://127.0.0.1:8012',
    embeddingModel: options.embeddingModel ?? process.env.RETRIEVAL_AGENT_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-0.6B',
    embeddingRevision: options.embeddingRevision ?? process.env.RETRIEVAL_AGENT_EMBEDDING_REVISION,
    embeddingDimensions: options.embeddingDimensions ?? 1024, modelDeadlineMs: options.modelDeadlineMs ?? 120000 }
  const key = JSON.stringify(options)
  let value = resources.get(key)
  if (!value) {
    const db = new TicketDatabase(options.mysqlUrl)
    value = { db, milvus: new MilvusClient(options.milvusUrl, options.milvusToken),
      model: new ModelServiceClient({ baseUrl: options.modelBaseUrl ?? 'http://127.0.0.1:8012',
        embeddingModel: options.embeddingModel ?? 'Qwen/Qwen3-Embedding-0.6B', embeddingDimensions: options.embeddingDimensions ?? 1024,
        ...(options.embeddingRevision ? { embeddingRevision: options.embeddingRevision } : {}), defaultDeadlineMs: options.modelDeadlineMs ?? 120000 }), ready: db.migrate(),
      close: async () => { resources.delete(key); await db.close() } }
    resources.set(key, value)
  }
  return value
}
