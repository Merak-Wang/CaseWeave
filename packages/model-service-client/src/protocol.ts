export const MODEL_SERVICE_PROTOCOL_VERSION = 'retrieval-agent.models.v1' as const

export interface ModelDescriptorResponse {
  readonly model: string
  readonly revision: string
  readonly kind: 'embedding' | 'reranker'
  readonly loaded: boolean
  readonly dtype: string
  readonly device: string
  readonly maxTokens: number
  readonly dimensions?: number
  readonly pooling?: 'last_token'
  readonly normalization?: 'l2'
  readonly scoreKind?: 'yes_probability'
}

export interface ModelServiceLiveResponse {
  readonly protocolVersion: typeof MODEL_SERVICE_PROTOCOL_VERSION
  readonly serviceVersion: string
  readonly live: true
}

export interface ModelServiceReadyResponse {
  readonly protocolVersion: typeof MODEL_SERVICE_PROTOCOL_VERSION
  readonly serviceVersion: string
  readonly ready: boolean
  readonly device: string
  readonly models: readonly ModelDescriptorResponse[]
  readonly limits: {
    readonly maxBatchSize: number
    readonly maxTotalTokens: number
    readonly maxRerankCandidates: number
  }
}

export interface EmbedTextsParams {
  readonly requireCompleteInput?: boolean
  readonly protocolVersion: typeof MODEL_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly model: string
  readonly input: readonly string[]
  readonly inputType: 'query' | 'document'
  readonly dimensions: number
  readonly normalize: true
  readonly instruction?: string
  readonly deadlineMs?: number
}

export interface EmbedTextsResponse {
  readonly timings?: Readonly<Record<string, number>>
  readonly inputComplete?: boolean
  readonly protocolVersion: typeof MODEL_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly model: string
  readonly revision: string
  readonly dimensions: number
  readonly normalization: 'l2'
  readonly data: readonly { readonly index: number; readonly embedding: readonly number[] }[]
  readonly elapsedMs: number
}

export interface RerankTextsParams {
  readonly protocolVersion: typeof MODEL_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly model: string
  readonly query: string
  readonly candidates: readonly { readonly id: string; readonly text: string }[]
  readonly instruction: string
  readonly topK: number
  readonly deadlineMs?: number
}

export interface RerankTextsResponse {
  readonly protocolVersion: typeof MODEL_SERVICE_PROTOCOL_VERSION
  readonly requestId: string
  readonly model: string
  readonly revision: string
  readonly scoreKind: 'yes_probability'
  readonly results: readonly {
    readonly id: string
    readonly inputIndex: number
    readonly rank: number
    readonly score: number
  }[]
  readonly elapsedMs: number
}

export interface ModelServiceErrorResponse {
  readonly protocolVersion?: string
  readonly requestId?: string
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
}
