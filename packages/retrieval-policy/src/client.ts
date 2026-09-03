import { randomUUID } from 'node:crypto'
import {
  RetrievalError,
  type RetrievalAllowedAction,
  type RetrievalErrorCode,
  type RetrievalKnowledgeAssessment,
  type RetrievalState,
  type TicketCandidate,
  type TicketCandidateRef,
} from '@retrieval-agent/contracts'
import {
  RAG_POLICY_PROTOCOL_VERSION,
  type CandidateRankingInputParams,
  type CandidateRankingResultResponse,
  type PlanKnowledgeAssessmentParams,
  type PlanKnowledgeAssessmentResponse,
  type UpdateCandidateRankingParams,
  type UpdateCandidateRankingResponse,
} from './protocol.js'

export interface RetrievalPolicyGateway {
  updateCandidateRanking(input: CandidateRankingInputParams, signal?: AbortSignal): Promise<CandidateRankingResultResponse>
  planKnowledgeAssessment(
    state: RetrievalState,
    assessment: RetrievalKnowledgeAssessment,
    config: { readonly noProgressLimit: number },
    signal?: AbortSignal,
  ): Promise<Partial<RetrievalState>>
}

export interface RetrievalPolicyClientOptions {
  readonly baseUrl: string
  readonly deadlineMs?: number
  readonly fetch?: typeof globalThis.fetch
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function candidates(value: unknown): readonly TicketCandidate[] | undefined {
  if (!Array.isArray(value) || !value.every(item => {
    const candidate = object(item)
    return typeof candidate?.ref === 'string' && candidate.ref.length > 0
      && Number.isSafeInteger(candidate.rank) && Number(candidate.rank) >= 1
  })) return undefined
  return value as TicketCandidate[]
}

function withoutRank(candidate: TicketCandidate): unknown {
  const { rank: _rank, ...rest } = candidate
  return rest
}

function sameCandidate(candidate: TicketCandidate, source: TicketCandidate | undefined): boolean {
  return source !== undefined && stable(withoutRank(candidate)) === stable(withoutRank(source))
}

function validateRanking(
  value: unknown,
  input: CandidateRankingInputParams,
): value is CandidateRankingResultResponse {
  const result = object(value)
  const history = candidates(result?.history)
  const active = candidates(result?.active)
  const rawObservations = result?.observations
  if (result?.version !== 'candidate-ranking-v1' || history === undefined || active === undefined
    || !Array.isArray(rawObservations)) return false
  const source = [...input.previousHistory, ...input.page]
  const sourceByRef = new Map(source.map(candidate => [candidate.ref, candidate]))
  const expectedHistory = [...new Set(source.map(candidate => candidate.ref))]
  const excluded = new Set(input.excludedRefs)
  if (history.length !== expectedHistory.length || history.some((candidate, index) =>
    candidate.ref !== expectedHistory[index] || !sameCandidate(candidate, sourceByRef.get(candidate.ref)))) return false
  if (new Set(active.map(candidate => candidate.ref)).size !== active.length
    || active.some((candidate, index) => candidate.rank !== index + 1 || excluded.has(candidate.ref)
      || !sameCandidate(candidate, sourceByRef.get(candidate.ref)))) return false
  const observations = rawObservations.map(object)
  const known = new Set(history.map(candidate => candidate.ref))
  return observations.length >= input.previousObservations.length
    && input.previousObservations.every((observation, index) => stable(observation) === stable(rawObservations[index]))
    && observations.every(observation => typeof observation?.searchEventId === 'string'
      && typeof observation.stage === 'string' && typeof observation.queryFingerprint === 'string'
      && Array.isArray(observation.ranking) && observation.ranking.every(raw => {
        const row = object(raw)
        return typeof row?.ref === 'string' && known.has(row.ref as TicketCandidateRef)
          && Number.isSafeInteger(row.rank) && Number(row.rank) >= 1
      }))
}

function validAction(value: unknown, state: RetrievalState): value is RetrievalAllowedAction {
  const action = object(value)
  if (action === undefined) return false
  const candidateRefs = new Set(state.candidates.map(candidate => candidate.ref))
  const allowedFields = new Set(state.snapshot?.fieldCatalog
    .filter(field => action.kind === 'read_l3_details'
      ? field.accessLevel === 'L3' && field.valueKind === 'raw_json'
      : field.accessLevel === 'L2')
    .map(field => field.key) ?? [])
  return ['search', 'search_next', 'repair_search', 'assess', 'read_l3_details', 'request_clarification', 'freeze', 'read_state'].includes(String(action?.kind))
    && Array.isArray(action.candidateAllowlist) && action.candidateAllowlist.every(ref => typeof ref === 'string' && candidateRefs.has(ref as TicketCandidateRef))
    && Array.isArray(action.fieldAllowlist) && action.fieldAllowlist.every(field => typeof field === 'string' && allowedFields.has(field))
    && Number.isSafeInteger(action.maxTokens) && Number(action.maxTokens) >= 0 && Number(action.maxTokens) <= state.budget.maxEvidenceTokens
}

function validatePatch(value: unknown, state: RetrievalState): value is Partial<RetrievalState> {
  const patch = object(value)
  const outputCandidates = candidates(patch?.candidates)
  if (patch?.phase !== 'assessed' || outputCandidates === undefined
    || !Array.isArray(patch.excludedCandidateRefs) || !Array.isArray(patch.selectedCandidateRefs)
    || !Array.isArray(patch.gaps) || !Array.isArray(patch.allowedActions)
    || !['active', 'needs_clarification'].includes(String(patch.termination)) || object(patch.progress) === undefined
    || !patch.allowedActions.every(action => validAction(action, state))) return false
  const source = new Map(state.candidates.map(candidate => [candidate.ref, candidate]))
  const outputRefs = new Set(outputCandidates.map(candidate => candidate.ref))
  if (new Set(outputRefs).size !== outputCandidates.length || outputCandidates.some((candidate, index) =>
    candidate.rank !== index + 1 || !source.has(candidate.ref)
      || stable(withoutRank(candidate)) !== stable(withoutRank(source.get(candidate.ref)!)))) return false
  const selected = patch.selectedCandidateRefs as unknown[]
  const excluded = patch.excludedCandidateRefs as unknown[]
  if (!selected.every(ref => typeof ref === 'string' && outputRefs.has(ref as TicketCandidateRef))
    || !excluded.every(ref => typeof ref === 'string' && source.has(ref as TicketCandidateRef))) return false
  const evidence = new Set<string>([
    ...state.candidates.map(candidate => candidate.ref),
    ...state.promotedEvidence.map(item => item.evidenceId),
  ])
  return patch.gaps.every(raw => {
    const gap = object(raw)
    return typeof gap?.kind === 'string' && typeof gap.status === 'string' && typeof gap.evaluator === 'string'
      && Array.isArray(gap.evidenceRefs) && gap.evidenceRefs.every(ref => typeof ref === 'string' && evidence.has(ref))
  })
}

const KNOWN_CODES = new Set<RetrievalErrorCode>([
  'INVALID_REQUEST', 'UNAUTHORIZED', 'SNAPSHOT_NOT_FOUND', 'SNAPSHOT_INVALID', 'CANDIDATE_NOT_FOUND',
  'FIELD_NOT_ALLOWED', 'BUDGET_EXHAUSTED', 'INVALID_TRANSITION', 'PROVIDER_UNAVAILABLE', 'TIMEOUT',
  'CANCELLED', 'PROTOCOL_MISMATCH', 'EXPORT_LIMIT_EXCEEDED',
])

/** Validated HTTP gateway for deterministic policy executed by the Python FastAPI service. */
export class RetrievalPolicyClient implements RetrievalPolicyGateway {
  readonly #baseUrl: string
  readonly #deadlineMs: number
  readonly #fetch: typeof globalThis.fetch

  constructor(options: RetrievalPolicyClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.#deadlineMs = options.deadlineMs ?? 5_000
    this.#fetch = options.fetch ?? globalThis.fetch
    if (!/^https?:\/\//u.test(this.#baseUrl)) throw new TypeError('policy service baseUrl must use http or https')
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs < 100) throw new TypeError('policy deadlineMs must be at least 100ms')
  }

  async updateCandidateRanking(input: CandidateRankingInputParams, signal?: AbortSignal): Promise<CandidateRankingResultResponse> {
    const requestId = randomUUID()
    const body: UpdateCandidateRankingParams = { protocolVersion: RAG_POLICY_PROTOCOL_VERSION, requestId, input }
    const response = await this.#request<UpdateCandidateRankingResponse>('/v1/policy/candidate-ranking', body, signal)
    if (response.protocolVersion !== RAG_POLICY_PROTOCOL_VERSION || response.requestId !== requestId
      || !finite(response.elapsedMs) || !validateRanking(response.result, input)) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'RAG 策略服务返回了越界或无效的候选排名。')
    }
    return response.result
  }

  async planKnowledgeAssessment(
    state: RetrievalState,
    assessment: RetrievalKnowledgeAssessment,
    config: { readonly noProgressLimit: number },
    signal?: AbortSignal,
  ): Promise<Partial<RetrievalState>> {
    const requestId = randomUUID()
    const body: PlanKnowledgeAssessmentParams = {
      protocolVersion: RAG_POLICY_PROTOCOL_VERSION, requestId, state, assessment, config,
    }
    const response = await this.#request<PlanKnowledgeAssessmentResponse>('/v1/policy/knowledge-assessment', body, signal)
    if (response.protocolVersion !== RAG_POLICY_PROTOCOL_VERSION || response.requestId !== requestId
      || response.version !== 'knowledge-assessment-v1' || !finite(response.elapsedMs)
      || !validatePatch(response.patch, state)) {
      throw new RetrievalError('PROTOCOL_MISMATCH', 'RAG 策略服务返回了越界或无效的知识评估计划。')
    }
    return response.patch
  }

  async #request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('deadline exceeded')), this.#deadlineMs)
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const error = object(object(value)?.error)
        const rawCode = typeof error?.code === 'string' ? error.code : 'PROVIDER_UNAVAILABLE'
        const code: RetrievalErrorCode = KNOWN_CODES.has(rawCode as RetrievalErrorCode)
          ? rawCode as RetrievalErrorCode
          : response.status === 409 ? 'PROTOCOL_MISMATCH' : 'PROVIDER_UNAVAILABLE'
        throw new RetrievalError(
          code,
          typeof error?.message === 'string' ? error.message : `RAG 策略服务返回 HTTP ${response.status}。`,
          { retryable: typeof error?.retryable === 'boolean' ? error.retryable : response.status >= 500 },
        )
      }
      if (object(value) === undefined) throw new RetrievalError('PROTOCOL_MISMATCH', 'RAG 策略服务返回了无效 JSON。')
      return value as T
    } catch (error) {
      if (error instanceof RetrievalError) throw error
      const cancelled = signal?.aborted === true
      if (controller.signal.aborted) {
        throw new RetrievalError(cancelled ? 'CANCELLED' : 'TIMEOUT', cancelled ? 'RAG 策略请求已取消。' : 'RAG 策略请求超时。', { retryable: !cancelled, cause: error })
      }
      throw new RetrievalError('PROVIDER_UNAVAILABLE', '无法连接本地 RAG 策略服务。', { retryable: true, cause: error })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
