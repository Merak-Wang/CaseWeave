import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ticketInputDefinition as definition, AcceptedTicketInput } from './input.js'

it('shows accepted input before any step, then yields to exactly that native message', () => {
  const input = { messageId: 'input-1', text: '  找副卡\n<x>  ', turn: 1 }
  const start = { event: { type: 'retrieval/input-accepted', seq: 3, time: 4, data: input },
    role: 'start', location: { kind: 'session' } } as unknown as ConversationStartMatch
  const state = definition.start({} as Parameters<typeof definition.start>[0], start, { previous: () => undefined })
  const context = { key: 'ticket-input:input-1', kind: 'ticket-input', id: 'input-1', start, state, matches: [start], current: new Map() }
  const node = definition.buildViewNode!(context)!
  expect(node).toMatchObject({ anchorSeq: 3, data: input })
  const rendered = renderToStaticMarkup(createElement(AcceptedTicketInput, { node } as Parameters<typeof AcceptedTicketInput>[0]))
  expect(rendered).toContain('找副卡\n&lt;x&gt;')
  const admitted = { type: 'user/message', seq: 8, time: 9, data: { id: 'input-1' } } as Parameters<typeof definition.match>[0]
  expect(definition.match(admitted)).toEqual({ id: 'input-1', role: 'update' })
  const next = definition.update(context, { event: admitted, role: 'update', location: { kind: 'session' } })
  expect(definition.buildViewNode!({ ...context, state: next })).toBeNull()
})
