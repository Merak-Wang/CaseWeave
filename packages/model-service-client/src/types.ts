import type { ModelServiceReadyResponse } from './protocol.js'

export interface EmbedInput {
  readonly requireCompleteInput?: boolean
  readonly onTiming?: (timings: Readonly<Record<string, number>>) => void
  readonly texts: readonly string[]
  readonly inputType: 'query' | 'document'
  readonly instruction?: string
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
}

export interface RerankInput {
  readonly query: string
  readonly candidates: readonly { readonly id: string; readonly text: string }[]
  readonly instruction: string
  readonly topK: number
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
}

export interface RetrievalModelGateway {
  ready(signal?: AbortSignal): Promise<ModelServiceReadyResponse>
  embed(input: EmbedInput): Promise<readonly (readonly number[])[]>
  rerank(input: RerankInput): Promise<readonly { readonly id: string; readonly rank: number; readonly score: number }[]>
}
