import { expect, it } from 'vitest'
import { assertTicketRetrievalRequest } from '@retrieval-agent/contracts'
import { buildSemanticTicketRequest } from './semantic-request.js'

it('preserves the execution choice with the original query through the admitted contract', () => {
  const request = buildSemanticTicketRequest('找副卡有关工单', { onlineLearning: false, semanticMethod: 'auto' })
  expect(request.queryContract?.semanticExecution).toEqual({ onlineLearning: false, semanticMethod: 'auto' })
  expect(request.query).toBe('找副卡有关工单')
  expect(() => assertTicketRetrievalRequest(request)).not.toThrow()
  expect(() => assertTicketRetrievalRequest({ ...request, queryContract: {
    ...request.queryContract!, semanticExecution: { onlineLearning: 'false', semanticMethod: 'auto' } as never,
  } })).toThrow(/执行模式/)
})
