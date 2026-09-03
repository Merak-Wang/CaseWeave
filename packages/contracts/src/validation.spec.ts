import { describe, expect, it } from 'vitest'
import { assertTicketFilter, assertTicketFilterField, assertTicketRetrievalRequest } from './validation.js'

describe('ticket filter runtime validation', () => {
  it('accepts only the operator family owned by each allowlisted field', () => {
    expect(() => assertTicketFilter({ field: 'status', op: 'eq', value: '已解决' })).not.toThrow()
    expect(() => assertTicketFilter({ field: 'createdAt', op: 'gte', value: '2026-08-01T00:00:00.000Z' })).not.toThrow()
    expect(() => assertTicketFilter({ field: 'errorCodes', op: 'contains', value: 'AUTH-1' })).not.toThrow()
    expect(() => assertTicketFilter({ field: 'source.queue', op: 'eq', value: 'Wireless' })).not.toThrow()

    expect(() => assertTicketFilter({ field: 'status', op: 'gte', value: 'P1' } as never)).toThrow(/eq\/neq/u)
    expect(() => assertTicketFilter({ field: 'createdAt', op: 'eq', value: '2026-08-01' } as never)).toThrow(/gte\/lte/u)
    expect(() => assertTicketFilter({ field: 'errorCodes', op: 'eq', value: 'AUTH-1' } as never)).toThrow(/contains/u)
  })

  it('fails closed for malformed model-created filter values and fields', () => {
    expect(() => assertTicketFilter({ field: 'status', op: 'eq' } as never)).toThrow(/筛选值/u)
    expect(() => assertTicketFilter({ field: 'tenantId', op: 'eq', value: 'other' } as never)).toThrow(/不支持/u)
    expect(() => assertTicketFilter({ field: 'createdAt', op: 'gte', value: 'not-a-date' })).toThrow(/有效时间/u)
    expect(() => assertTicketFilterField(undefined)).toThrow(/不支持/u)
  })
})

describe('ticket result-count validation', () => {
  it('rejects a result limit on an exhaustive legacy contract', () => {
    expect(() => assertTicketRetrievalRequest({
      target: 'cohort_collection',
      query: '主卡工单',
      fastQuery: {
        schemaVersion: 1,
        source: 'direct_user',
        rewriteApplied: false,
        keyword: { terms: ['主卡工单'], operator: 'and' },
        vector: { text: '主卡工单' },
      },
      queryContract: {
        schemaVersion: 5,
        original: '主卡工单',
        normalized: '主卡工单',
        task: 'cohort_collection',
        resultPolicy: 'exhaustive_current_snapshot',
        maxResults: 20,
        domain: 'telecom_ticket',
        language: 'zh',
        entities: [],
        constraints: [],
        ambiguities: [],
        compilerVersion: 'legacy-test',
      },
    })).toThrow(/Query Contract/u)
  })

  it('accepts exhaustive v7 only when every user-level result limit is absent', () => {
    expect(() => assertTicketRetrievalRequest({
      target: 'ranked_cases',
      query: '主卡工单',
      countPolicy: 'exhaustive',
      fastQuery: {
        schemaVersion: 1,
        source: 'direct_user',
        rewriteApplied: false,
        keyword: { terms: ['主卡工单'], operator: 'and' },
        vector: { text: '主卡工单' },
      },
      queryContract: {
        schemaVersion: 7,
        original: '主卡工单',
        normalized: '主卡工单',
        task: 'ranked_cases',
        resultPolicy: 'exhaustive_current_snapshot',
        domain: 'telecom_ticket',
        language: 'zh',
        entities: [],
        constraints: [],
        fastQuery: {
          schemaVersion: 1,
          source: 'direct_user',
          rewriteApplied: false,
          keyword: { terms: ['主卡工单'], operator: 'and' },
          vector: { text: '主卡工单' },
        },
        nlp: {
          schemaVersion: 2,
          engine: 'spacy',
          engineVersion: 'test',
          pipeline: 'test',
          pipelineVersion: 'test',
          lexiconVersion: 'test',
          keywordTerms: ['主卡工单'],
          tokens: [{ surface: '主卡工单', start: 0, end: 4, lemma: '', pos: 'NOUN', tag: 'NN', dep: 'ROOT', head: 0, isStop: false, entityType: '' }],
          entities: [],
          triples: [],
        },
        ambiguities: [],
        compilerVersion: 'current-test',
      },
    })).not.toThrow()
  })

  it('keeps task type independent from adaptive and exhaustive result policy', () => {
    expect(() => assertTicketRetrievalRequest({
      target: 'cohort_collection', query: '列出主卡工单', countPolicy: 'adaptive',
      queryContract: {
        schemaVersion: 7, original: '列出主卡工单', normalized: '列出主卡工单', task: 'cohort_collection',
        resultPolicy: 'adaptive_top_k', domain: 'telecom_ticket', language: 'zh', entities: [], constraints: [],
        nlp: {
          schemaVersion: 2, engine: 'spacy', engineVersion: 'test', pipeline: 'test', pipelineVersion: 'test',
          lexiconVersion: 'test', keywordTerms: [], tokens: [], entities: [], triples: [],
        },
        ambiguities: [], compilerVersion: 'current-test',
      },
    })).not.toThrow()
    expect(() => assertTicketRetrievalRequest({
      target: 'ranked_cases', query: '查找所有主卡工单', countPolicy: 'exhaustive',
      queryContract: {
        schemaVersion: 7, original: '查找所有主卡工单', normalized: '查找所有主卡工单', task: 'ranked_cases',
        resultPolicy: 'exhaustive_current_snapshot', domain: 'telecom_ticket', language: 'zh', entities: [], constraints: [],
        nlp: {
          schemaVersion: 2, engine: 'spacy', engineVersion: 'test', pipeline: 'test', pipelineVersion: 'test',
          lexiconVersion: 'test', keywordTerms: [], tokens: [], entities: [], triples: [],
        },
        ambiguities: [], compilerVersion: 'current-test',
      },
    })).not.toThrow()
  })

  it('requires a result count only for explicit Top-K', () => {
    expect(() => assertTicketRetrievalRequest({ target: 'ranked_cases', query: '主卡', countPolicy: 'explicit' }))
      .toThrow(/显式 Top-K/u)
    expect(() => assertTicketRetrievalRequest({ target: 'ranked_cases', query: '主卡', requestedCount: 5, countPolicy: 'adaptive' }))
      .toThrow(/显式 Top-K/u)
    expect(() => assertTicketRetrievalRequest({ target: 'ranked_cases', query: '主卡', requestedCount: 5, countPolicy: 'exhaustive' }))
      .toThrow(/显式 Top-K/u)
  })
})
