import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const
const GAP = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    status: { type: 'string', required: true },
    description: { type: 'string' },
  },
} as const
const BUDGET = {
  type: 'object', additionalProperties: false,
  properties: {
    modelStepsUsed: { type: 'integer', required: true },
    successfulToolCalls: { type: 'integer', required: true },
    failedToolCalls: { type: 'integer', required: true },
    providerSearches: { type: 'integer', required: true },
    promotions: { type: 'integer', required: true },
    wallClockElapsedMs: { type: 'integer', required: true },
    modelLatencyMs: { type: 'integer', required: true },
    providerLatencyMs: { type: 'integer', required: true },
    totalInputTokens: { type: 'integer', required: true },
    totalOutputTokens: { type: 'integer', required: true },
    serializationBytes: { type: 'integer', required: true },
  },
} as const
const DELTA = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', const: 'retrieval_delta', required: true },
    retrievalId: { type: 'string', required: true },
    stateId: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    phase: { type: 'string', required: true },
    termination: { type: 'string', required: true },
    query: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        normalized: { type: 'string', required: true },
        task: { type: 'string', required: true },
        resultPolicy: { type: 'string', required: true },
        fastQuery: {
          type: 'object', additionalProperties: false,
          properties: {
            schemaVersion: { type: 'integer', const: 1, required: true },
            source: { type: 'string', const: 'direct_user', required: true },
            rewriteApplied: { type: 'boolean', const: false, required: true },
            keyword: {
              type: 'object', additionalProperties: false, required: true,
              properties: {
                terms: { ...STRING_ARRAY, required: true },
                operator: { type: 'string', required: true },
              },
            },
            vector: {
              type: 'object', additionalProperties: false, required: true,
              properties: { text: { type: 'string', required: true } },
            },
          },
        },
      },
    },
    candidateDelta: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          rank: { type: 'integer', required: true },
          displayId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          summary: { type: 'string' },
          l0: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              createdAt: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' },
              region: { type: 'string' }, category: { type: 'string' },
            },
          },
        },
      },
    },
    evidenceDelta: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          candidateAlias: { type: 'string', required: true },
          field: { type: 'string', required: true },
          text: { type: 'string', required: true },
          trust: { type: 'string', const: 'untrusted_ticket_evidence', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
    },
    activeAliases: { ...STRING_ARRAY, required: true },
    selectedAliases: { ...STRING_ARRAY, required: true },
    excludedAliasCount: { type: 'integer', required: true },
    gaps: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        system: { type: 'array', items: GAP, required: true },
        semantic: { type: 'array', items: GAP, required: true },
      },
    },
    allowedActions: { ...STRING_ARRAY, required: true },
    boundary: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        resultPagesExhausted: { type: 'boolean', required: true },
        semanticRecallKnown: { type: 'boolean', required: true },
        nextPageAvailable: { type: 'boolean', required: true },
        decisionFinalized: { type: 'boolean', required: true },
        topKAccepted: { type: 'boolean', required: true },
        resultMayBeIncomplete: { type: 'boolean', required: true },
      },
    },
    retrievalObservation: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        channels: {
          type: 'array', required: true,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              channel: { type: 'string', required: true },
              resultCount: { type: 'integer', required: true },
              querySource: { type: 'string' },
            },
          },
        },
        authorizedCorpusSize: { type: 'integer' },
        documentsAfterStructuredFilters: { type: 'integer' },
        documentsEligibleForKeywordChannel: { type: 'integer' },
        rankedHits: { type: 'integer' },
        newCandidateCount: { type: 'integer', required: true },
        cumulativeCandidateCount: { type: 'integer', required: true },
        rankOverlap: { type: 'number', required: true },
      },
    },
    budget: { ...BUDGET, required: true },
    clarification: {
      type: 'object', additionalProperties: false,
      properties: { facet: { type: 'string', required: true }, question: { type: 'string', required: true } },
    },
  },
} as const
const TERMINAL_RECEIPT = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', const: 'ticket_collection', required: true },
    schemaVersion: { type: 'integer', const: 3, required: true },
    retrievalId: { type: 'string', required: true },
    packId: { type: 'string' },
    stoppingReason: { type: 'string', required: true },
    decisionFinalized: { type: 'boolean', const: true, required: true },
    complete: { type: 'boolean', required: true },
    topKAccepted: { type: 'boolean', required: true },
    resultPagesExhausted: { type: 'boolean', required: true },
    semanticRecallKnown: { type: 'boolean', required: true },
    resultMayBeIncomplete: { type: 'boolean', required: true },
    nextPageAvailable: { type: 'boolean', required: true },
    tickets: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: { alias: { type: 'string', required: true }, displayId: { type: 'string', required: true } },
      },
    },
    remainingGapKinds: { ...STRING_ARRAY, required: true },
    budget: { ...BUDGET, required: true },
  },
} as const

export const RETRIEVAL_TOOL_OUTPUT_SCHEMA = {
  oneOf: [DELTA, TERMINAL_RECEIPT],
} as const satisfies ValueSchemaSpec
